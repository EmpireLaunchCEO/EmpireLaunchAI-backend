import { Request, Response } from 'express';
import { campaignService } from '../services/campaignService.js';

export class CampaignController {
  /**
   * Reschedules a post based on conversational input.
   * e.g., 'post this in 1 hour'
   */
  async reschedule(req: Request, res: Response) {
    const { postId, delayInMinutes } = req.body;
    
    if (!postId || delayInMinutes === undefined) {
      return res.status(400).json({ error: 'Missing postId or delayInMinutes' });
    }

    const newDate = new Date();
    newDate.setMinutes(newDate.getMinutes() + delayInMinutes);

    try {
      const updatedPost = await campaignService.reschedulePost(postId, newDate);
      res.json({ message: 'Post rescheduled successfully', updatedPost });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Manual trigger to process due posts (for demo/testing).
   */
  async processDue(req: Request, res: Response) {
    try {
      await campaignService.processDuePosts();
      res.json({ message: 'Due posts processed' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const campaignController = new CampaignController();
