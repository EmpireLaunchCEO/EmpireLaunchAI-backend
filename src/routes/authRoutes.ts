import { Router } from 'express';
import { 
  registerUser,
  loginUser,
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

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/terms/accept', acceptTerms);
router.post('/redeem-key', redeemKey);

// ─── UNIVERSAL GATEWAY (High-Trust OAuth flows) ──────────────────
// Platform-specific URL generation: GET /api/auth/:platform/url
// Platform-specific callback:    POST /api/auth/:platform/callback
router.get('/:platform/url', getPlatformAuthUrl);
router.post('/:platform/url', getPlatformAuthUrl);
router.get('/:platform/callback', handlePlatformCallback);
router.post('/:platform/callback', handlePlatformCallback);

// ─── LEGACY COMPATIBILITY (will be deprecated) ──────────────────
router.post('/etsy/url', getEtsyAuthUrl);
router.post('/etsy/callback', etsyCallback);
router.get('/meta/url', getMetaAuthUrl);
router.post('/meta/callback', metaCallback);
router.get('/tiktok/url', getTikTokAuthUrl);
router.post('/tiktok/callback', tiktokCallback);

export default router;
