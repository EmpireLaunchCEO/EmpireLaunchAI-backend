import { Router } from 'express';
import { onboardUser, createPaymentLink, getAccountStatus, createPaymentButton, triggerInstantPayout } from '../controllers/stripeController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/onboard', mobileAuth, onboardUser);
router.post('/payment-link', mobileAuth, createPaymentLink);
router.post('/payment-button', mobileAuth, createPaymentButton);
router.get('/status', mobileAuth, getAccountStatus);
router.post('/payout/instant', mobileAuth, triggerInstantPayout);

export default router;
