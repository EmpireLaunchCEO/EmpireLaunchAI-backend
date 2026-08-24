import { db, schema } from '../db/index.js';
import { eq, and, gte, count, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const { usageLogs, users, creations, approvals } = schema;

// Postgres stores user ids as UUID columns. Guard every DB query with this so a
// non-UUID sentinel ('anonymous', 'system', '') never reaches Postgres and
// throws `invalid input syntax for type uuid: "..."` (which used to be caught
// silently, breaking quota tracking for those requests).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value: string): boolean {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export class UsageService {
  /**
   * Tracks a new usage event.
   */
  async logUsage(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'customize_video' | 'edits', metadata?: any) {
    // Never attempt a DB write / FK insert with a non-UUID userId (usage_logs.user_id
    // is a UUID FK). Unidentified callers simply have no quota attributable to them.
    if (!isValidUuid(userId)) {
      console.warn(`[UsageService] Skipping usage log for non-UUID userId "${userId}" (type=${type})`);
      return;
    }
    try {
      await db.insert(usageLogs).values({
        id: uuidv4(),
        userId,
        type,
        metadata,
        createdAt: new Date(),
      });
    } catch (error) {
      console.error('[UsageService] Failed to log usage:', error);
    }
  }

  /**
   * Gets the remaining count for a specific usage type today/month/week.
   * For neural_twin and customize_video: 168-hour window from user's signup date.
   * The app owner (Staci) has unlimited usage on everything.
   */
  async getDailyRemaining(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'high_res_design' | 'customize_video' | 'edits'): Promise<number | 'unlimited'> {
    // Weekly video-production quotas (168-hour rolling window).
    // Faceless is a cheap short-clip path and stays at 7/week (owner didn't change it);
    // Scene-Based (customize_video) and Neural Twin (neural_twin) are the costly renders,
    // reduced to 5/week (owner cost-control decision).
    const weeklyFacelessLimit = 7;
    const weeklyVideoLimit = 5;
    const monthlyDesignLimit = 50;
    // Unidentified / non-UUID caller — never run a Postgres query with the raw
    // value (it would throw a uuid cast error). There is no user row to count
    // usage against, so report the full allowance for the type (never crash).
    if (!isValidUuid(userId)) {
      console.warn(`[UsageService] Quota lookup with non-UUID userId "${userId}" (type=${type}) — returning full allowance`);
      if (type === 'enhanced_video' || type === 'edits') return 'unlimited';
      if (type === 'high_res_design') return monthlyDesignLimit;
      if (type === 'faceless') return weeklyFacelessLimit;
      if (type === 'neural_twin' || type === 'customize_video') return weeklyVideoLimit;
      return 3;
    }

    // Owner override — unlimited on everything
    if (await this.isOwner(userId)) {
      return 'unlimited';
    }

    // Unlimited check
    if (type === 'enhanced_video' || type === 'edits') {
      return 'unlimited';
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let periodStart: Date;
    let limit: number;

    if (type === 'high_res_design') {
      periodStart = startOfMonth;
      limit = monthlyDesignLimit;
      // TODO: Reset on subscription renewal date instead of calendar month
    } else if (type === 'neural_twin' || type === 'customize_video' || type === 'faceless') {
      // Calculate 168-hour window from user's signup date
      try {
        const [user] = await db.select({ createdAt: users.createdAt })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (user?.createdAt) {
          const signupTime = new Date(user.createdAt).getTime();
          const elapsed = now.getTime() - signupTime;
          const periodsElapsed = Math.floor(elapsed / (168 * 60 * 60 * 1000));
          periodStart = new Date(signupTime + periodsElapsed * 168 * 60 * 60 * 1000);
        } else {
          periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }
      } catch {
        periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
      // Faceless is a cheap short-clip path (stays at 7/wk);
      // Scene-Based + Neural Twin are the costly renders (reduced to 5/wk).
      limit = (type === 'faceless') ? weeklyFacelessLimit : weeklyVideoLimit;
    } else {
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      limit = 3; // Default daily limit for others
    }

    try {
      if (type === 'customize_video') {
        // Customize Video creations are stored in `creations` with type
        // 'enhanced_video'. Count those within the period instead of usage_logs
        // (which is never written for customize_video) so the 7/week quota and
        // the client-facing counter both reflect real usage.
        const [result] = await db.select({ count: count() })
          .from(creations)
          .where(and(
            eq(creations.userId, userId),
            eq(creations.type, 'enhanced_video'),
            gte(creations.createdAt, periodStart)
          ));
        return Math.max(0, limit - Number(result?.count ?? 0));
      }

      if (type === 'faceless') {
        // Faceless videos are submitted as `approvals` rows with type 'faceless'
        // (no `creations` row is written for them). Count faceless submissions
        // within the period so the 7/week quota reflects real submissions.
        const [result] = await db.select({ count: count() })
          .from(approvals)
          .where(and(
            eq(approvals.userId, userId),
            eq(approvals.type, 'faceless'),
            gte(approvals.createdAt, periodStart)
          ));
        return Math.max(0, limit - Number(result?.count ?? 0));
      }

      const logs = await db.select()
        .from(usageLogs)
        .where(
          and(
            eq(usageLogs.userId, userId),
            eq(usageLogs.type, type),
            gte(usageLogs.createdAt, periodStart)
          )
        );

      return Math.max(0, limit - logs.length);
    } catch (error) {
      console.error('[UsageService] Failed to check usage limits:', error);
      return 0; // Safe default on error
    }
  }

  /**
   * Enforces the daily/monthly/weekly limit. Throws if limit reached.
   */
  async enforceLimit(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'high_res_design' | 'customize_video' | 'edits') {
    const remaining = await this.getDailyRemaining(userId, type);
    if (remaining !== 'unlimited' && remaining <= 0) {
      let period = 'day';
      let limit = 3;

      if (type === 'high_res_design') {
        period = 'month';
        limit = 50;
      } else if (type === 'faceless') {
        period = 'week';
        limit = 7;
      } else if (type === 'neural_twin' || type === 'customize_video') {
        period = 'week';
        limit = 5;
      }

      throw new Error(`Usage limit reached. You can generate up to ${limit} ${type.replace(/_/g, ' ')}s per ${period}.`);
    }
  }

  /**
   * Check if a user is the app owner (unlimited usage).
   */
  private ownerCache = new Set<string>();
  private async isOwner(userId: string): Promise<boolean> {
    if (this.ownerCache.has(userId)) return true;
    if (!isValidUuid(userId)) return false;
    try {
      const [user] = await db.select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      // Owner emails that get unlimited access
      const ownerEmails = ['staci@empirelaunch.ai', 'staci.peabody@gmail.com'];
      if (user?.email && ownerEmails.includes(user.email.toLowerCase())) {
        this.ownerCache.add(userId);
        return true;
      }
    } catch {
      // Silently fail — default to limited
    }
    return false;
  }
}

export const usageService = new UsageService();
