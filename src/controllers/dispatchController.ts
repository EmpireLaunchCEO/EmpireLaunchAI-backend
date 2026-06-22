import { Request, Response } from 'express';
import { creationDraftService } from '../services/creationDraftService.js';
import { dispatchService } from '../services/dispatchService.js';

export class DispatchController {
  async saveDraft(req: Request, res: Response) {
    try {
      const { campaignId, creationType, title, content, platform, metadata, rootId } = req.body;
      const userId = (req as any).user.id;
      const id = await creationDraftService.saveDraft({
        userId,
        campaignId,
        creationType,
        title,
        content,
        platform,
        metadata,
        rootId
      });
      res.json({ status: 'success', id });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  async createNewVersion(req: Request, res: Response) {
    try {
      const draftId = req.params.draftId as string;
      const { content, feedback } = req.body;
      const id = await creationDraftService.createNewVersion(draftId, content, feedback);
      res.json({ status: 'success', id });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  async addFeedback(req: Request, res: Response) {
    try {
      const draftId = req.params.draftId as string;
      const { feedback, actor } = req.body;
      const userId = (req as any).user.id;
      await creationDraftService.addFeedback(draftId, userId, feedback, actor || 'user');
      res.json({ status: 'success' });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  async updateStatus(req: Request, res: Response) {
    try {
      const draftId = req.params.draftId as string;
      const { status } = req.body;
      await creationDraftService.updateStatus(draftId, status);
      res.json({ status: 'success' });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  async getDraftHistory(req: Request, res: Response) {
    try {
      const rootId = req.params.rootId as string;
      const history = await creationDraftService.getDraftHistory(rootId);
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  async getFeedbackHistory(req: Request, res: Response) {
    try {
      const draftId = req.params.draftId as string;
      const feedback = await creationDraftService.getFeedbackHistory(draftId);
      res.json(feedback);
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  async dispatch(req: Request, res: Response) {
    try {
      const draftId = req.params.draftId as string;
      const { platform } = req.body;
      const result = await dispatchService.dispatch(draftId, platform);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  }

  async getLatestDrafts(req: Request, res: Response) {
      try {
          const userId = (req as any).user.id;
          const drafts = await creationDraftService.getLatestDrafts(userId);
          res.json(drafts);
      } catch (error: any) {
          res.status(500).json({ status: 'error', message: error.message });
      }
  }
}

export const dispatchController = new DispatchController();
