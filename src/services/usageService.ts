import { db, schema } from '../db/index.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const { usageLogs } = schema;

export class UsageService {
  /**
   * Tracks a new usage event.
   */
  async logUsage(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless', metadata?: any) {
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
   * Gets the remaining count for a specific usage type today/month.
   */
  async getDailyRemaining(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'high_res_design'): Promise<number | 'unlimited'> {
    // Unlimited check
    if (type === 'faceless' || type === 'enhanced_video') {
      return 'unlimited';
    }

    const dailyLimit = 3;
    const monthlyDesignLimit = 50;
    
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const periodStart = type === 'high_res_design' ? startOfMonth : startOfToday;
    const limit = type === 'high_res_design' ? monthlyDesignLimit : dailyLimit;

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
   * Enforces the daily/monthly limit. Throws if limit reached.
   */
  async enforceLimit(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'high_res_design') {
    const remaining = await this.getDailyRemaining(userId, type);
    if (remaining !== 'unlimited' && remaining <= 0) {
      const period = type === 'high_res_design' ? 'month' : 'day';
      const limit = type === 'high_res_design' ? 50 : 3;
      throw new Error(`Usage limit reached. You can generate up to ${limit} ${type.replace(/_/g, ' ')}s per ${period}.`);
    }
  }
}

export const usageService = new UsageService();
