import { Router } from 'express';
import { 
  acceptTerms,
  redeemKey,
  getEtsyAuthUrl, 
  etsyCallback, 
  getMetaAuthUrl, 
  metaCallback,
  getGmailAuthUrl,
  gmailCallback,
  getOutlookAuthUrl,
  outlookCallback,
  getYouTubeAuthUrl,
  youtubeCallback,
  getTikTokAuthUrl,
  tiktokCallback
} from '../controllers/authController.js';

const router = Router();

router.post('/terms/accept', acceptTerms);
router.post('/redeem-key', redeemKey);
router.get('/etsy/url', getEtsyAuthUrl);
router.post('/etsy/callback', etsyCallback);

router.get('/meta/url', getMetaAuthUrl);
router.post('/meta/callback', metaCallback);

router.get('/gmail/url', getGmailAuthUrl);
router.post('/gmail/callback', gmailCallback);

router.get('/outlook/url', getOutlookAuthUrl);
router.post('/outlook/callback', outlookCallback);

router.get('/youtube/url', getYouTubeAuthUrl);
router.post('/youtube/callback', youtubeCallback);

router.get('/tiktok/url', getTikTokAuthUrl);
router.post('/tiktok/callback', tiktokCallback);

export default router;
