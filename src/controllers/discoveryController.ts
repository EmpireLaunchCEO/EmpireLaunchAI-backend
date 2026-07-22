import { Request, Response } from 'express';
import { neuralDiscoveryService } from '../services/neuralDiscoveryService.js';
import { db, schema } from '../db/index.js';
const { discoveryResults } = schema;
import { eq, and } from 'drizzle-orm';

export const runDiscovery = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const count = await neuralDiscoveryService.discover(userId);
    res.json({
      status: 'success',
      message: `Discovery completed. Found ${count} potential credentials.`,
      count: count
    });
  } catch (error: any) {
    console.error('Error running discovery:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getPendingDiscoveries = async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const results = await db.select()
      .from(discoveryResults)
      .where(and(
        eq(discoveryResults.userId, userId as string),
        eq(discoveryResults.status, 'pending')
      ));

    res.json({
      status: 'success',
      discoveries: results.map((r: any) => ({
        id: r.id,
        platform: r.platform,
        snippet: r.snippet,
        potentialKeyMasked: r.potentialKeyMasked,
        createdAt: r.createdAt
      }))
    });
  } catch (error: any) {
    console.error('Error getting pending discoveries:', error);
    res.status(500).json({ error: error.message });
  }
};

export const approveDiscovery = async (req: Request, res: Response) => {
  try {
    const { discoveryId } = req.params;
    if (!discoveryId) {
      return res.status(400).json({ error: 'discoveryId is required' });
    }

    const result = await neuralDiscoveryService.approveDiscovery(discoveryId as string);
    res.json({
      status: 'success',
      message: 'Credential vaulted successfully.',
      ...result
    });
  } catch (error: any) {
    console.error('Error approving discovery:', error);
    res.status(500).json({ error: error.message });
  }
};

export const rejectDiscovery = async (req: Request, res: Response) => {
  try {
    const { discoveryId } = req.params;
    if (!discoveryId) {
      return res.status(400).json({ error: 'discoveryId is required' });
    }

    await neuralDiscoveryService.rejectDiscovery(discoveryId as string);
    res.json({
      status: 'success',
      message: 'Discovery rejected.'
    });
  } catch (error: any) {
    console.error('Error rejecting discovery:', error);
    res.status(500).json({ error: error.message });
  }
};
