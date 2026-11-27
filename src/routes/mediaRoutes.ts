import { Router } from 'express';
import { generateProductImage, combineVideos } from '../controllers/mediaController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/image/product', mobileAuth, generateProductImage);
router.post('/video/combine', mobileAuth, combineVideos);

export default router;
