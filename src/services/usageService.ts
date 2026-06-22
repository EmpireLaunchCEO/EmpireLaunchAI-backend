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
   * Gets the remaining count for a specific usage type today/month/week.
   */
  async getDailyRemaining(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'high_res_design'): Promise<number | 'unlimited'> {
    // Unlimited check
    if (type === 'faceless' || type === 'enhanced_video') {
      return 'unlimited';
    }

    const weeklyNeuralLimit = 21;
    const monthlyDesignLimit = 50;
    
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfSevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let periodStart: Date;
    let limit: number;

    if (type === 'high_res_design') {
      periodStart = startOfMonth;
      limit = monthlyDesignLimit;
    } else if (type === 'neural_twin') {
      periodStart = startOfSevenDaysAgo;
      limit = weeklyNeuralLimit;
    } else {
      periodStart = startOfToday;
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
  async enforceLimit(userId: string, type: 'neural_twin' | 'enhanced_video' | 'faceless' | 'high_res_design') {
    const remaining = await this.getDailyRemaining(userId, type);
    if (remaining !== 'unlimited' && remaining <= 0) {
      let period = 'day';
      let limit = 3;

      if (type === 'high_res_design') {
        period = 'month';
        limit = 50;
      } else if (type === 'neural_twin') {
        period = 'week';
        limit = 21;
      }

      throw new Error(`Usage limit reached. You can generate up to ${limit} ${type.replace(/_/g, ' ')}s per ${period}.`);
    }
  }
}

export const usageService = new UsageService();
