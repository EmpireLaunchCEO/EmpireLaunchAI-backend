import { Request, Response } from 'express';
import { reviewService } from '../services/reviewService.js';

export class ReviewController {
  async submitReview(req: Request, res: Response) {
    try {
      const userId = (req as any).userId;
      const { rating, comment } = req.body;
      if (!userId || !rating) {
        return res.status(400).json({ error: 'userId and rating are required' });
      }
      const review = await reviewService.submitReview(userId, rating, comment);
      res.status(201).json(review);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async getFlaggedReviews(req: Request, res: Response) {
    try {
      const { userId } = req.params;
      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }
      const reviews = await reviewService.getFlaggedReviews(userId as string);
      res.json(reviews);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async approveReview(req: Request, res: Response) {
    try {
      const userId = (req as any).userId;
      const { reviewId } = req.body;
      if (!userId || !reviewId) {
        return res.status(400).json({ error: 'userId and reviewId are required' });
      }
      const review = await reviewService.approveReviewForMarketing(userId, reviewId);
      res.json(review);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async getTrustPulse(req: Request, res: Response) {
    try {
      const userId = req.headers['x-user-id'] as string || 'default-user';
      const metrics = await reviewService.getTrustMetrics(userId);
      res.json(metrics);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async getSentimentMap(req: Request, res: Response) {
    try {
      const userId = req.headers['x-user-id'] as string || 'default-user';
      const map = await reviewService.getSentimentMap(userId);
      res.json(map);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  async getFeedbackInbox(req: Request, res: Response) {
    try {
      const reviews = await reviewService.getAllReviews();
      res.json(reviews);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const reviewController = new ReviewController();
