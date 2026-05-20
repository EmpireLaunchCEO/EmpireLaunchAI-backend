import { Router } from 'express';
import { onboarding, createProductLink, getStripeStatus, handleWebhook } from '../controllers/stripeController.js';

const router = Router();

router.post('/onboarding', onboarding);
router.post('/payment-link', createProductLink);
router.get('/status/:userId', getStripeStatus);
router.post('/webhook', handleWebhook);

export default router;
