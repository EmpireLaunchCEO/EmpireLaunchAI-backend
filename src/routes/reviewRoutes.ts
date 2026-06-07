import { Router } from 'express';
import { reviewController } from '../controllers/reviewController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

// Endpoint for the user/frontend to submit a rating/review
router.post('/', reviewController.submitReview);

// Endpoint for the Command Center to fetch reviews flagged for marketing
router.get('/flagged/:userId', reviewController.getFlaggedReviews);

// Endpoint for the owner to approve a review for marketing push
router.post('/approve', reviewController.approveReview);

router.get('/pulse', mobileAuth, reviewController.getTrustPulse);
router.get('/sentiment', mobileAuth, reviewController.getSentimentMap);

export default router;
