import { Router } from 'express';
import { getPublicKey, subscribe, testPush } from '../controllers/pushController.js';

const router = Router();

router.get('/public-key', getPublicKey);
router.post('/subscribe', subscribe);
router.post('/test', testPush);

export default router;
