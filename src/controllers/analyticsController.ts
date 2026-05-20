import { Request, Response } from 'express';
import { roiAnalyticsService } from '../services/roiAnalyticsService.js';

export const getPerformanceMetrics = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
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
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const forecast = await roiAnalyticsService.getGrowthForecast(userId);
    res.json({ forecast });
  } catch (error: any) {
    console.error('Error fetching growth forecast:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getOpportunityCards = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const cards = await roiAnalyticsService.generateOpportunityCards(userId);
    res.json({ cards });
  } catch (error: any) {
    console.error('Error generating opportunity cards:', error);
    res.status(500).json({ error: error.message });
  }
};

export const syncAnalyticsData = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    await roiAnalyticsService.syncToBigQuery(userId);
    res.json({ status: 'success', message: 'Data synced to BigQuery' });
  } catch (error: any) {
    console.error('Error syncing analytics data:', error);
    res.status(500).json({ error: error.message });
  }
};
