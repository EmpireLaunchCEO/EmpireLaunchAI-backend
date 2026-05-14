import { Router } from 'express';
import { 
  getEtsyAuthUrl, 
  etsyCallback, 
  getMetaAuthUrl, 
  metaCallback 
} from '../controllers/authController.js';

const router = Router();

router.get('/etsy/url', getEtsyAuthUrl);
router.post('/etsy/callback', etsyCallback);

router.get('/meta/url', getMetaAuthUrl);
router.post('/meta/callback', metaCallback);

export default router;
