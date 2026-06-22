import { db, schema } from '../db/index.js';
import { PlatformAdapter } from './adapters/platformAdapter.js';
import { EtsyAdapter } from './adapters/etsyAdapter.js';
import { TikTokAdapter } from './adapters/tiktokAdapter.js';
import { v4 as uuidv4 } from 'uuid';
import { notificationService } from './notificationService.js';

export class AnalyticsAggregatorService {
  private adapters: PlatformAdapter[] = [];

  constructor() {
    this.adapters = [
      new EtsyAdapter(),
      new TikTokAdapter()
    ];
  }

  async aggregateDailyMetrics(userId: string, date: Date = new Date()) {
    try {
      const dailyMetrics = {
        revenue: 0,
        engagement: 0,
        adSpend: 0,
        sentimentScore: 0,
        platformBreakdown: {} as Record<string, any>
      };

      let totalSentimentScore = 0;
      let sentimentCount = 0;

      for (const adapter of this.adapters) {
        try {
          const metrics = await adapter.fetchMetrics(userId, date);
          const platformName = adapter.getPlatformName();

          dailyMetrics.revenue += metrics.revenue;
          dailyMetrics.engagement += metrics.engagement;
          dailyMetrics.adSpend += metrics.adSpend;
          
          if (metrics.sentimentScore !== undefined) {
            totalSentimentScore += metrics.sentimentScore;
            sentimentCount++;
          }

          dailyMetrics.platformBreakdown[platformName] = metrics;
        } catch (adapterError: any) {
          console.error(`Error in adapter ${adapter.getPlatformName()}:`, adapterError);
          // Non-blocking but notified
          await notificationService.notifyUser(userId, `Warning: Failed to fetch data from ${adapter.getPlatformName()}. Analytics for today may be partial.`);
        }
      }

      if (sentimentCount > 0) {
        dailyMetrics.sentimentScore = Math.floor(totalSentimentScore / sentimentCount);
      }

      // Save to historical_performance
      await db.insert(schema.historicalPerformance).values({
        id: uuidv4(),
        userId,
        date,
        revenue: dailyMetrics.revenue,
        engagement: dailyMetrics.engagement,
        adSpend: dailyMetrics.adSpend,
        sentimentScore: dailyMetrics.sentimentScore,
        platformBreakdown: dailyMetrics.platformBreakdown,
        createdAt: new Date()
      });

      return dailyMetrics;
    } catch (error: any) {
      console.error('Failed to aggregate daily metrics:', error);
      await notificationService.notifyUser(userId, `Critical Error: Analytics aggregation failed: ${error.message}`, true);
      throw error;
    }
  }
}

export const analyticsAggregator = new AnalyticsAggregatorService();
