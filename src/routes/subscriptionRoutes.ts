import { Router } from 'express';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { verifySubscription, getUserSubscriptions, createCheckoutSession, checkRenewal, pollRenewal, cancelSubscription, reactivateSubscription } from '../controllers/subscriptionController.js';

const router = Router();

// Verify a user's payment via Stripe and record subscription
router.post('/stripe/verify-subscription', mobileAuth, verifySubscription);

// Create a dynamic Stripe Checkout Session tagged with user ID
router.post('/stripe/create-checkout-session', mobileAuth, createCheckoutSession);

// Check subscription renewal status (MUST come before /subscriptions/:userId)
router.get('/subscriptions/check-renewal', mobileAuth, checkRenewal);
router.get('/subscriptions/poll-renewal', mobileAuth, pollRenewal);
router.post('/subscriptions/cancel', mobileAuth, cancelSubscription);
router.post('/subscriptions/reactivate', mobileAuth, reactivateSubscription);

// Get all subscriptions for a user
router.get('/subscriptions/:userId', mobileAuth, getUserSubscriptions);

export default router;
