import { Router } from 'express';
import { getPublicKey, subscribe, testPush } from '../controllers/pushController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/public-key', getPublicKey);
router.post('/subscribe', mobileAuth, subscribe);
router.post('/test', mobileAuth, testPush);

export default router;
