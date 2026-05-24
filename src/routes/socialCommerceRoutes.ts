import { Router } from 'express';
import { syncMetaCatalog, syncTikTokShop, getMetaCatalogs } from '../controllers/socialCommerceController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/meta/catalogs', mobileAuth, getMetaCatalogs);
router.post('/meta/sync', mobileAuth, syncMetaCatalog);
router.post('/tiktok/sync', mobileAuth, syncTikTokShop);

export default router;
