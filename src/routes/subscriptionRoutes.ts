import { Router } from 'express';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { verifySubscription, getUserSubscriptions, createCheckoutSession } from '../controllers/subscriptionController.js';

const router = Router();

// Verify a user's payment via Stripe and record subscription
router.post('/stripe/verify-subscription', mobileAuth, verifySubscription);

// Create a dynamic Stripe Checkout Session tagged with user ID
router.post('/stripe/create-checkout-session', mobileAuth, createCheckoutSession);

// Get all subscriptions for a user
router.get('/subscriptions/:userId', mobileAuth, getUserSubscriptions);

export default router;
