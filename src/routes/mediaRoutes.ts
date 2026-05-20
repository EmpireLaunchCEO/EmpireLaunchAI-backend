import { Router } from 'express';
import { generateProductImage, combineVideos } from '../controllers/mediaController.js';

const router = Router();

router.post('/image/product', generateProductImage);
router.post('/video/combine', combineVideos);

export default router;
