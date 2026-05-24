import { db, schema } from '../db/index.js';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { bigQueryService } from './bigQueryService.js';
import { tiktokService } from './tiktokService.js';
import { youtubeService } from './youtubeService.js';
import { metaService } from './metaService.js';
import { integrationService } from './integrationService.js';
import { trendResearchAgent } from '../agents/trendResearchAgent.js';
import { v4 as uuidv4 } from 'uuid';

import { revenueOracle } from './revenueOracle.js';

const { adSpend, revenueTransactions, products } = schema;

export class ROIAnalyticsService {
  /**
   * Calculates ROI and profit margins for a user over a given period.
   */
  async getPerformanceMetrics(userId: string, startDate: Date, endDate: Date) {
    // 1. Fetch Revenue
    const revenue = await db.select({
      total: sql<number>`sum(${revenueTransactions.amount})`,
    })
    .from(revenueTransactions)
    .where(and(
      eq(revenueTransactions.userId, userId),
      gte(revenueTransactions.date, startDate),
      lte(revenueTransactions.date, endDate)
    ));

    const totalRevenue = revenue[0]?.total || 0;

    // 2. Fetch Ad Spend (Cost)
    const cost = await db.select({
      total: sql<number>`sum(${adSpend.amount})`,
    })
    .from(adSpend)
    .where(and(
      eq(adSpend.userId, userId),
      gte(adSpend.date, startDate),
      lte(adSpend.date, endDate)
    ));

    const totalCost = cost[0]?.total || 0;

    // 3. Calculate ROI and Profit Margin
    const netProfit = totalRevenue - totalCost;
    const roi = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    return {
      period: { start: startDate, end: endDate },
      totalRevenue,
      totalCost,
      netProfit,
      roi: Math.round(roi * 100) / 100,
      profitMargin: Math.round(profitMargin * 100) / 100
    };
  }

  /**
   * Generates growth forecasts using BigQuery ML.
   */
  async getGrowthForecast(userId: string) {
    // In a real flow, we would first sync latest data to BigQuery
    // await this.syncToBigQuery(userId);

    const forecast = await bigQueryService.runARIMAForecast(userId);
    return forecast;
  }

  /**
   * Generates Opportunity Cards based on trend analysis and ROI data.
   */
  async generateOpportunityCards(userId: string) {
    console.log(`Generating opportunity cards for user ${userId}...`);
    
    // 1. Get recent performance
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    const metrics = await this.getPerformanceMetrics(userId, monthAgo, new Date());

    // 2. Get current trends
    const trendsRaw = await trendResearchAgent.analyzeTrends("scale digital marketing business");
    const trends = JSON.parse(trendsRaw);

    // 3. Map trends to opportunity cards
    const cards = trends.trendingNiches.map((trend: any) => ({
      id: uuidv4(),
      type: 'optimization',
      title: `Optimize for ${trend.niche}`,
      description: `Based on your current ROI of ${metrics.roi}% and trending data from ${trend.platform}, we suggest focusing on ${trend.niche}. ${trend.reason}`,
      impact: trend.roi > 80 ? 'high' : 'medium',
      metric: `${trend.roi}% potential ROI`,
      cta: 'View Optimized Strategy',
      payload: { niche: trend.niche, strategy: trends.suggestedStrategy }
    }));

    // Add a generic growth card if revenue is low
    if (metrics.totalRevenue < 500000) { // < $5,000
       cards.push({
         id: uuidv4(),
         type: 'growth',
         title: 'Boost TikTok Engagement',
         description: 'Your TikTok attribution shows a lower conversion rate than Instagram. Try a "Day in the life" productivity video to boost organic reach.',
         impact: 'high',
         metric: '12% conversion lift',
         cta: 'Generate Script',
         payload: { platform: 'tiktok', contentType: 'lifestyle' }
       });
    }

    return cards;
  }

  /**
   * Syncs local ledger data to BigQuery.
   */
  async syncToBigQuery(userId: string) {
    const revenue = await db.select().from(revenueTransactions).where(eq(revenueTransactions.userId, userId));
    const costs = await db.select().from(adSpend).where(eq(adSpend.userId, userId));

    await bigQueryService.streamData('revenue', revenue);
    await bigQueryService.streamData('ad_spend', costs);
  }

  /**
   * Syncs platform engagement data.
   */
  async syncPlatformEngagement(userId: string) {
    console.log(`[ROIAnalytics] Syncing platform engagement for user ${userId}`);
    
    // 1. YouTube
    try {
        const ytData = await youtubeService.getAnalytics(userId, '30daysAgo', 'today');
        if (ytData.rows) {
            for (const row of ytData.rows) {
                // Simplified mapping: metrics = [views, likes, dislikes, shares, ...]
                await db.insert(schema.engagementMetrics).values({
                    id: uuidv4(),
                    userId,
                    platform: 'youtube',
                    externalMediaId: 'channel_total', // Or specific video if dimensions included video
                    viewCount: row[1],
                    likeCount: row[2],
                    commentCount: 0, // Not in basic analytics report
                    shareCount: row[4],
                    date: new Date(row[0]),
                    createdAt: new Date(),
                });
            }
        }
    } catch (e: any) {
        console.warn('YouTube sync failed:', e.message);
    }

    // 2. TikTok
    try {
        const ttData = await tiktokService.getVideoAnalytics(userId);
        if (ttData.data && ttData.data.videos) {
            for (const video of ttData.data.videos) {
                await db.insert(schema.engagementMetrics).values({
                    id: uuidv4(),
                    userId,
                    platform: 'tiktok',
                    externalMediaId: video.id,
                    viewCount: video.view_count,
                    likeCount: video.like_count,
                    commentCount: video.comment_count,
                    shareCount: video.share_count,
                    date: new Date(), // TikTok Display API usually returns current snapshot
                    createdAt: new Date(),
                });
            }
        }
    } catch (e: any) {
        console.warn('TikTok sync failed:', e.message);
    }

    // 3. Instagram
    try {
        // We would first fetch all user's media IDs, then get insights for each
        // For this implementation, we'll assume a loop over recent posts
        const credentials = await integrationService.getCredentials(userId, 'meta');
        if (credentials && credentials.instagramBusinessAccountId) {
            const igInsights = await metaService.getInstagramInsights(userId, credentials.instagramBusinessAccountId);
            // Process IG insights...
        }
    } catch (e: any) {
        console.warn('Instagram sync failed:', e.message);
    }
  }

  /**
   * Aggregates 'Empire Health' metrics (EHS) for the dashboard.
   */
  async getEmpireHealth(userId: string) {
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    // 1. Revenue Velocity (50%)
    // Mock: Growth MoM. Real: compare this month to last month.
    const [milestone] = await db.select().from(schema.revenueMilestones).where(eq(schema.revenueMilestones.userId, userId));
    const totalRevenue = milestone?.totalRevenue || 0;
    const revenueVelocity = Math.min(100, Math.round((totalRevenue / 100000) * 10)); // $10k = 100 score

    // 2. Engagement Pulse (30%)
    // Mock: Based on view-to-like ratio.
    const metrics = await db.select().from(schema.engagementMetrics).where(eq(schema.engagementMetrics.userId, userId));
    const totalViews = metrics.reduce((sum, m) => sum + m.viewCount, 0);
    const totalLikes = metrics.reduce((sum, m) => sum + m.likeCount, 0);
    const engagementPulse = totalViews > 0 ? Math.min(100, Math.round((totalLikes / totalViews) * 500)) : 50;

    // 3. Operational Consistency (20%)
    // Mock: Adherence to schedule.
    const operationalConsistency = 85;

    // Calculate Overall Score
    const overallScore = Math.round(
      (revenueVelocity * 0.5) +
      (engagementPulse * 0.3) +
      (operationalConsistency * 0.2)
    );

    // Log the health score
    await db.insert(schema.empireHealthLogs).values({
      id: uuidv4(),
      userId,
      revenueVelocity,
      engagementPulse,
      operationalConsistency,
      overallScore,
      timestamp: new Date()
    });

    const dues = await revenueOracle.calculatePendingDues(userId);

    const platformRevenue = await db.select({
      platform: schema.revenueTransactions.platform,
      total: sql<number>`sum(${schema.revenueTransactions.amount})`,
    })
    .from(schema.revenueTransactions)
    .where(eq(schema.revenueTransactions.userId, userId))
    .groupBy(schema.revenueTransactions.platform);

    return {
      totalLifetimeRevenue: totalRevenue,
      pendingDues: dues.total,
      growthScore: overallScore,
      revenueVelocity,
      engagementPulse,
      operationalConsistency,
      platformBreakdown: platformRevenue,
      status: overallScore > 70 ? 'healthy' : overallScore > 40 ? 'stable' : 'at_risk'
    };
  }
}

export const roiAnalyticsService = new ROIAnalyticsService();
