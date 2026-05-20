import { db, schema } from '../db/index.js';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { bigQueryService } from './bigQueryService.js';
import { trendResearchAgent } from '../agents/trendResearchAgent.js';
import { v4 as uuidv4 } from 'uuid';

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
   * Ingests revenue data from external source.
   */
  async ingestRevenue(userId: string, platform: string, transactions: any[]) {
    for (const tx of transactions) {
      await db.insert(revenueTransactions).values({
        id: uuidv4(),
        userId,
        platform,
        amount: tx.amount,
        currency: tx.currency || 'usd',
        externalTransactionId: tx.id,
        productId: tx.productId,
        date: tx.date || new Date(),
        createdAt: new Date(),
      });
    }
    
    // Optionally trigger milestone check in RevenueOracle
    // await revenueOracle.processMilestones(userId);
  }
}

export const roiAnalyticsService = new ROIAnalyticsService();
