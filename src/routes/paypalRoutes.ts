import { Router } from 'express';
import * as paypalController from '../controllers/paypalController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/onboard', mobileAuth, paypalController.onboardUser);
router.get('/callback', paypalController.callback);
router.get('/status', mobileAuth, paypalController.getAccountStatus);

export default router;
