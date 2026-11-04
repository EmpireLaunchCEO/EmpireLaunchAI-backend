import { Router } from 'express';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { cancelMyBilling, getMyBilling } from '../controllers/billingController.js';

const router = Router();

// Real billing truth for the signed-in client. Both endpoints answer from
// services/stripeSubscriptions.ts (one Stripe read), never from a guessed date.
router.get('/me', mobileAuth, getMyBilling);
router.post('/cancel', mobileAuth, cancelMyBilling);

export default router;
