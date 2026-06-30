import { Router } from 'express';
import { 
  onboardUser, 
  createPaymentLink, 
  getAccountStatus, 
  createPaymentButton, 
  triggerInstantPayout,
  createPlatformCheckout,
  createExpansionCheckout,
  verifyPlatformPayment,
  createFinancialConnectionsSession
} from '../controllers/stripeController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/onboard', mobileAuth, onboardUser);
router.post('/payment-link', mobileAuth, createPaymentLink);
router.post('/payment-button', mobileAuth, createPaymentButton);
router.get('/status', mobileAuth, getAccountStatus);
router.post('/payout/instant', mobileAuth, triggerInstantPayout);
router.post('/checkout/platform', mobileAuth, createPlatformCheckout);
router.post('/checkout/expansion', mobileAuth, createExpansionCheckout);
router.get('/verify/platform', mobileAuth, verifyPlatformPayment);
router.post('/financial-connections/session', mobileAuth, createFinancialConnectionsSession);

export default router;
