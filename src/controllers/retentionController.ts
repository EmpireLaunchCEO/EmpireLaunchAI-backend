import { Request, Response } from 'express';
import { retentionService } from '../services/retentionService.js';

export class RetentionController {
  async getDrafts(req: Request, res: Response) {
    try {
      const userId = req.headers['x-user-id'] as string || 'default-user';
      const drafts = await retentionService.getInboxDrafts(userId);
      res.json(drafts);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async respond(req: Request, res: Response) {
    try {
      const userId = req.headers['x-user-id'] as string || 'default-user';
      const { id, status } = req.body;
      if (!id || !status) {
        return res.status(400).json({ error: 'id and status are required' });
      }
      const draft = await retentionService.respondToDraft(userId, id, status);
      res.json(draft);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async triggerScan(req: Request, res: Response) {
    try {
      const userId = req.headers['x-user-id'] as string || 'default-user';
      await retentionService.scanAndGenerateDrafts(userId);
      res.json({ status: 'success', message: 'Retention scan complete' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const retentionController = new RetentionController();
