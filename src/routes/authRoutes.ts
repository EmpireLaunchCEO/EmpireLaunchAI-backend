import { Router } from 'express';
import { 
  acceptTerms,
  redeemKey,
  getEtsyAuthUrl, 
  etsyCallback, 
  getMetaAuthUrl, 
  metaCallback,
  getTikTokAuthUrl,
  tiktokCallback,
  getPlatformAuthUrl,
  handlePlatformCallback,
} from '../controllers/authController.js';

const router = Router();

router.post('/terms/accept', acceptTerms);
router.post('/redeem-key', redeemKey);

// ─── ETSY (Custom implementation with etsyService) ──────────────────
router.post('/etsy/url', getEtsyAuthUrl);
router.post('/etsy/callback', etsyCallback);

// ─── LEGACY (delegate to Universal Gateway) ────────────────────────
router.get('/meta/url', getMetaAuthUrl);
router.post('/meta/callback', metaCallback);
router.get('/tiktok/url', getTikTokAuthUrl);
router.post('/tiktok/callback', tiktokCallback);

// ─── UNIVERSAL GATEWAY (all platforms via single pattern) ──────────
// Platform-specific URL generation: GET /auth/:platform/url
// Platform-specific callback:    POST /auth/:platform/callback
router.get('/:platform/url', getPlatformAuthUrl);
router.post('/:platform/callback', handlePlatformCallback);

export default router;
