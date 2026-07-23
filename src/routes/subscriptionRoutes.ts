import { Router } from 'express';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { verifySubscription, getUserSubscriptions } from '../controllers/subscriptionController.js';

const router = Router();

// Verify a user's payment via Stripe and record subscription
router.post('/stripe/verify-subscription', mobileAuth, verifySubscription);

// Get all subscriptions for a user
router.get('/subscriptions/:userId', mobileAuth, getUserSubscriptions);

export default router;
