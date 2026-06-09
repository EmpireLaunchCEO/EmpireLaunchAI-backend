import { Request, Response } from 'express';
import { infrastructureService } from '../services/infrastructureService.js';
import { revenueService } from '../services/revenueService.js';

export const getInfrastructureBalances = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const balances = await infrastructureService.getAllBalances();
    res.json(balances);
  } catch (error: any) {
    console.error('Error fetching infrastructure balances:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getRevenueSummary = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const summary = await revenueService.getAggregateRevenue(userId);
    res.json(summary);
  } catch (error: any) {
    console.error('Error fetching revenue summary:', error);
    res.status(500).json({ error: error.message });
  }
};
