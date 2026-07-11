import { db, schema } from '../db/index.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const { usageLogs, users } = schema;

export class UsageService {
  /**
   * Tracks a new usage event.
   */
  async logUsage(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'customize_video', metadata?: any) {
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
  async getDailyRemaining(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'high_res_design' | 'customize_video'): Promise<number | 'unlimited'> {
    // Owner override — unlimited on everything
    if (await this.isOwner(userId)) {
      return 'unlimited';
    }

    // Unlimited check
    if (type === 'faceless' || type === 'enhanced_video') {
      return 'unlimited';
    }

    const weeklyNeuralLimit = 14;
    const monthlyDesignLimit = 50;
    
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let periodStart: Date;
    let limit: number;

    if (type === 'high_res_design') {
      periodStart = startOfMonth;
      limit = monthlyDesignLimit;
      // TODO: Reset on subscription renewal date instead of calendar month
    } else if (type === 'neural_twin' || type === 'customize_video') {
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
      limit = weeklyNeuralLimit;
    } else {
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      limit = 3; // Default daily limit for others
    }

    try {
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
  async enforceLimit(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'high_res_design' | 'customize_video') {
    const remaining = await this.getDailyRemaining(userId, type);
    if (remaining !== 'unlimited' && remaining <= 0) {
      let period = 'day';
      let limit = 3;

      if (type === 'high_res_design') {
        period = 'month';
        limit = 50;
      } else if (type === 'neural_twin' || type === 'customize_video') {
        period = 'week';
        limit = 14;
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
