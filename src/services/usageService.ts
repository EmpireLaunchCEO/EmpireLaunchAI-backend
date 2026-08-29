import { db, schema } from '../db/index.js';
import { eq, and, gte, count, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { OWNER_CONFIG } from '../config/owner.js';

const { usageLogs, users, approvals } = schema;

/**
 * Gmail (and Googlemail) treat the local part as case-insensitive AND ignore
 * '.' — so first.last@gmail.com, firstlast@gmail.com, First.Last@GMAIL.com are
 * all the same mailbox. The owner's stored email can arrive in any dot-variant
 * depending on how she signed up, so comparison must normalize those away or the
 * exact-string owner check silently fails (real defect — the owner would be
 * counted against client quota). Non-gmail addresses are lowercased only.
 */
function normalizeOwnerEmail(email: string): string {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.indexOf('@');
  if (at <= 0) return raw;
  const domain = raw.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const local = raw.slice(0, at).replace(/\./g, '');
    return `${local}@gmail.com`;
  }
  return raw;
}

/**
 * Everything the app considers an owner account. Every entry is normalized so
 * Gmail dot-variants collapse to one canonical comparison. OWNER_CONFIG.email is
 * the primary owner email; the .ai address and the dotted variant are kept for
 * robustness against older rows / internal accounts. The owner (Staci) is
 * unlimited on ALL quotas.
 */
const OWNER_EMAILS = new Set([
  normalizeOwnerEmail(OWNER_CONFIG.email),        // stacipeabody@gmail.com (canonical)
  normalizeOwnerEmail('staci.peabody@gmail.com'), // dotted variant -> same mailbox
  normalizeOwnerEmail('staci@empirelaunch.ai'),   // internal .ai account
]);

/** Tiers that are unbounded everywhere else in the codebase (subscriptionGuard,
 *  revenueOracle) — treat them as owner-exempt here too for quota (defense in
 *  depth beyond the email match; the owner's DB row is provisioned OWNER_MASTER). */
const UNLIMITED_TIERS: ReadonlySet<string> = new Set(['OWNER_MASTER', 'BETA_TESTER']);

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
    // Owner is unlimited and her quota MUST NEVER be decremented by usage logs,
    // nor should her rows accumulate in the shared usage_logs table. Skip writing
    // usage for the owner entirely (client-facing counts are unaffected because
    // every read is scoped to the caller's own userId).
    if (await this.isOwner(userId)) {
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
    // Weekly video-production quotas (168-hour rolling window), final owner config:
    // Scene-Based (customize_video) = 3/wk, Faceless = 10/wk, Neural Twin (neural_twin) = 5/wk.
    const weeklySceneLimit = 3;   // customize_video
    const weeklyFacelessLimit = 10;
    const weeklyTwinLimit = 5;    // neural_twin
    const monthlyDesignLimit = 50;
    // Unidentified / non-UUID caller — never run a Postgres query with the raw
    // value (it would throw a uuid cast error). There is no user row to count
    // usage against, so report the full allowance for the type (never crash).
    if (!isValidUuid(userId)) {
      console.warn(`[UsageService] Quota lookup with non-UUID userId "${userId}" (type=${type}) — returning full allowance`);
      if (type === 'enhanced_video' || type === 'edits') return 'unlimited';
      if (type === 'high_res_design') return monthlyDesignLimit;
      if (type === 'customize_video') return weeklySceneLimit;
      if (type === 'faceless') return weeklyFacelessLimit;
      if (type === 'neural_twin') return weeklyTwinLimit;
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
      // Final per-type weekly limits: customize_video=3, faceless=10, neural_twin=5.
      if (type === 'customize_video') limit = weeklySceneLimit;
      else if (type === 'faceless') limit = weeklyFacelessLimit;
      else limit = weeklyTwinLimit; // neural_twin
    } else {
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      limit = 3; // Default daily limit for others
    }

    try {
      if (type === 'customize_video') {
        // Scene-Based / Customize Video quota. Since the owner auto-save change,
        // completed scene videos are delivered as Operations draft APPROVAL rows
        // (payload.mode='scene', payload.projectId) — NOT `creations` rows anymore.
        // Count DISTINCT scene projectIds within the period so each generation
        // counts once regardless of how many export variants it produced.
        const [result] = await db.select({ count: count() })
          .from(sql`(
            SELECT DISTINCT payload->>'projectId' AS pid
            FROM approvals
            WHERE user_id = ${userId}
              AND payload->>'mode' = 'scene'
              AND payload->>'projectId' IS NOT NULL
              AND created_at >= ${periodStart}
          ) AS _scene_drafts`);
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
      } else if (type === 'customize_video') {
        period = 'week';
        limit = 3;
      } else if (type === 'faceless') {
        period = 'week';
        limit = 10;
      } else if (type === 'neural_twin') {
        period = 'week';
        limit = 5;
      }

      throw new Error(`Usage limit reached. You can generate up to ${limit} ${type.replace(/_/g, ' ')}s per ${period}.`);
    }
  }

  /**
   * Check if a user is the app owner (unlimited usage).
   * Owner detection is robust to Gmail dot-variants: the owner's stored email may
   * be 'stacipeabody@gmail.com' or 'staci.peabody@gmail.com' (same Gmail mailbox),
   * so we compare normalized addresses. We ALSO treat the unbounded tiers
   * (OWNER_MASTER / BETA_TESTER) as owner-exempt as a defense in depth, because
   * the owner's DB row is provisioned OWNER_MASTER and those tiers are already
   * unbounded in subscriptionGuard/revenueOracle.
   */
  private ownerCache = new Set<string>();
  private async isOwner(userId: string): Promise<boolean> {
    if (this.ownerCache.has(userId)) return true;
    if (!isValidUuid(userId)) return false;
    try {
      const [user] = await db.select({ email: users.email, tier: users.tier })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      // Tier-based exemption (defense in depth) — the owner's row is OWNER_MASTER.
      if (user?.tier && UNLIMITED_TIERS.has(user.tier)) {
        this.ownerCache.add(userId);
        return true;
      }
      // Email-based exemption — normalized so Gmail dot/alias variants match.
      if (user?.email && OWNER_EMAILS.has(normalizeOwnerEmail(user.email))) {
        this.ownerCache.add(userId);
        return true;
      }
    } catch {
      // Silently fail — default to limited
    }
    return false;
  }

  /**
   * Public owner check for callers that bypass getDailyRemaining (e.g. the inline
   * single-shot /process video quota gate in studioRoutes). Removes duplicate
   * owner-listing logic from the route and keeps it centralized here.
   */
  async isOwnerUser(userId: string): Promise<boolean> {
    return this.isOwner(userId);
  }
}

export const usageService = new UsageService();
