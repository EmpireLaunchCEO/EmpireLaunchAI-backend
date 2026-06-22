import { Request, Response } from 'express';
import { neuralDiscoveryService } from '../services/neuralDiscoveryService.js';
import { db } from '../db/index.js';
import { discoveryResults } from '../db/sqlite-schema.js';
import { eq, and } from 'drizzle-orm';

export class NeuralDiscoveryController {
  async scan(req: Request, res: Response) {
    const userId = req.body.userId as string;
    const accessToken = req.body.accessToken as string;
    if (!userId || !accessToken) {
      return res.status(400).json({ error: 'Missing userId or accessToken' });
    }

    try {
      const matchCount = await neuralDiscoveryService.scanGmail(userId, accessToken);
      res.json({ message: 'Gmail scan completed', matchCount });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async imapScan(req: Request, res: Response) {
    const userId = req.body.userId as string;
    const config = req.body.config;
    if (!userId || !config) {
      return res.status(400).json({ error: 'Missing userId or imap config' });
    }

    try {
      const matchCount = await neuralDiscoveryService.scanImap(userId, config);
      res.json({ message: 'IMAP scan completed', matchCount });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async listPending(req: Request, res: Response) {
    const userId = req.params.userId;
    if (typeof userId !== 'string') {
      return res.status(400).json({ error: 'Invalid userId' });
    }
    try {
      const pending = await db.select().from(discoveryResults).where(
        and(
          eq(discoveryResults.userId, userId),
          eq(discoveryResults.status, 'pending')
        )
      );
      res.json(pending);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async approve(req: Request, res: Response) {
    const userId = req.body.userId as string;
    const discoveryId = req.body.discoveryId as string;
    try {
      await neuralDiscoveryService.approveCredential(userId, discoveryId);
      res.json({ message: 'Credential approved and moved to Ownership Vault' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async reject(req: Request, res: Response) {
    const userId = req.body.userId as string;
    const discoveryId = req.body.discoveryId as string;
    try {
      await neuralDiscoveryService.rejectCredential(userId, discoveryId);
      res.json({ message: 'Credential rejected' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const neuralDiscoveryController = new NeuralDiscoveryController();
