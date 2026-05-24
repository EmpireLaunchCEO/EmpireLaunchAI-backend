import { Request, Response } from 'express';
import { reviewService } from '../services/reviewService.js';

export class ReviewController {
  async submitReview(req: Request, res: Response) {
    try {
      const { userId, rating, comment } = req.body;
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
      const { userId, reviewId } = req.body;
      if (!userId || !reviewId) {
        return res.status(400).json({ error: 'userId and reviewId are required' });
      }
      const review = await reviewService.approveReviewForMarketing(userId, reviewId);
      res.json(review);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const reviewController = new ReviewController();
