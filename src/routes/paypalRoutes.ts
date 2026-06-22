import { Router } from 'express';
import * as paypalController from '../controllers/paypalController.js';

const router = Router();

router.get('/onboard', paypalController.onboardUser);
router.get('/callback', paypalController.callback);
router.get('/status', paypalController.getAccountStatus);

export default router;
