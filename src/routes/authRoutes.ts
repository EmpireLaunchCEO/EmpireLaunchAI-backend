import { Router } from 'express';
import { 
  getEtsyAuthUrl, 
  etsyCallback, 
  getMetaAuthUrl, 
  metaCallback,
  getGmailAuthUrl,
  gmailCallback,
  getOutlookAuthUrl,
  outlookCallback
} from '../controllers/authController.js';

const router = Router();

router.get('/etsy/url', getEtsyAuthUrl);
router.post('/etsy/callback', etsyCallback);

router.get('/meta/url', getMetaAuthUrl);
router.post('/meta/callback', metaCallback);

router.get('/gmail/url', getGmailAuthUrl);
router.post('/gmail/callback', gmailCallback);

router.get('/outlook/url', getOutlookAuthUrl);
router.post('/outlook/callback', outlookCallback);

export default router;
