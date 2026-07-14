import { Router } from 'express';
import { startOnboarding, getOnboardingStatus, startTikTokQRLogin } from '../controllers/onboardingController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/start', mobileAuth, startOnboarding);
router.get('/status/:sessionId', mobileAuth, getOnboardingStatus);
router.post('/tiktok-qr', mobileAuth, startTikTokQRLogin);

export default router;
