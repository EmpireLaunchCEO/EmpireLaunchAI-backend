import { Router } from 'express';
import { startOnboarding, getOnboardingStatus } from '../controllers/onboardingController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/start', mobileAuth, startOnboarding);
router.get('/status/:sessionId', mobileAuth, getOnboardingStatus);

export default router;
