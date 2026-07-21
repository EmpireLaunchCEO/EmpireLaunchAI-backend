import { Request, Response } from 'express';
import { roiAnalyticsService } from '../services/roiAnalyticsService.js';
import { strategyOracle } from '../services/strategyOracleService.js';
import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';

export const getPerformanceMetrics = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { start, end } = req.query;

    const startDate = start ? new Date(start as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end as string) : new Date();

    const metrics = await roiAnalyticsService.getPerformanceMetrics(userId, startDate, endDate);
    res.json(metrics);
  } catch (error: any) {
    console.error('Error fetching performance metrics:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getGrowthForecast = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const forecast = await roiAnalyticsService.getGrowthForecast(userId);
    res.json({ forecast });
  } catch (error: any) {
    console.error('Error fetching growth forecast:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getOpportunityCards = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const cards = await roiAnalyticsService.generateOpportunityCards(userId);
    res.json({ cards });
  } catch (error: any) {
    console.error('Error generating opportunity cards:', error);
    res.status(500).json({ error: error.message });
  }
};

export const syncAnalyticsData = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    await roiAnalyticsService.syncToBigQuery(userId);
    await roiAnalyticsService.syncPlatformEngagement(userId);
    res.json({ status: 'success', message: 'Data synced to BigQuery and platforms refreshed' });
  } catch (error: any) {
    console.error('Error syncing analytics data:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getEmpireHealth = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const health = await roiAnalyticsService.getEmpireHealth(userId);
    
    // Transform to frontend format
    const pulse = {
      status: health.status,
      description: `Your empire is currently ${health.status.replace('_', ' ')}. Growth score: ${health.growthScore}%.`,
      progress: health.growthScore,
      health: {
        revenue: health.totalLifetimeRevenue / 100, // backend uses cents
        monthlyRevenue: health.recentMonthlyRevenue / 100,
        pendingDues: health.pendingDues / 100,
        platformBreakdown: health.platformBreakdown.map((p: any) => ({
          platform: p.platform,
          revenue: p.total / 100
        }))
      },
      logs: [
        `Total Revenue: ${(health.totalLifetimeRevenue / 100).toLocaleString()}`,
        `Pending Dues: ${(health.pendingDues / 100).toLocaleString()}`,
        `Profit Margin: ${health.profitMargin}%`
      ]
    };

    res.json(pulse);
  } catch (error: any) {
    console.error('Error fetching empire pulse:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getRevenueTransactions = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const transactions = await db.select()
      .from(schema.revenueTransactions)
      .where(eq(schema.revenueTransactions.userId, userId))
      .orderBy(desc(schema.revenueTransactions.date))
      .limit(20);
    
    res.json(transactions);
  } catch (error: any) {
    console.error('Error fetching revenue transactions:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getStrategyQueue = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    // 1. Fetch existing suggestions
    let suggestions = await db.select()
      .from(schema.strategySuggestions)
      .where(eq(schema.strategySuggestions.userId, userId))
      .orderBy(desc(schema.strategySuggestions.createdAt));

    // 2. If no suggestions, trigger a generation pass
    if (suggestions.length === 0) {
      console.log(`No strategy suggestions found for user \${userId}. Triggering generation...`);
      await strategyOracle.generateSuggestions(userId);
      
      // Fetch again after generation
      suggestions = await db.select()
        .from(schema.strategySuggestions)
        .where(eq(schema.strategySuggestions.userId, userId))
        .orderBy(desc(schema.strategySuggestions.createdAt));
    }

    res.json(suggestions);
  } catch (error: any) {
    console.error('Error fetching strategy queue:', error);
    res.status(500).json({ error: error.message });
  }
};
