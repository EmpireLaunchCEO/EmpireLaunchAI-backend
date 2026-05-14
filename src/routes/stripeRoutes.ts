import { Router } from 'express';
import { onboarding, createProductLink, getStripeStatus } from '../controllers/stripeController.js';

const router = Router();

router.post('/onboarding', onboarding);
router.post('/payment-link', createProductLink);
router.get('/status/:userId', getStripeStatus);

export default router;
