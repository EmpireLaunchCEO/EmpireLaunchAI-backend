import { Router } from 'express';
import { db } from '../db/index.js';
import { 
  registerUser,
  loginUser,
  acceptTerms,
  redeemKey,
  masterLogin,
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
router.get('/debug-db', async (req, res) => {
  try {
    const result = await db.execute('SELECT name FROM sqlite_master WHERE type="table"');
    res.json({ type: 'sqlite', tables: result });
  } catch (e: any) {
    try {
      const result = await db.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      res.json({ type: 'postgres', tables: result.rows });
    } catch (e2: any) {
      res.status(500).json({ error: e.message, error2: e2.message });
    }
  }
});
router.post('/login', loginUser);
router.post('/terms/accept', acceptTerms);
router.post('/redeem-key', redeemKey);
router.post('/master-login', masterLogin);

// ─── UNIVERSAL GATEWAY (High-Trust OAuth flows) ──────────────────
// Platform-specific URL generation: GET/POST /api/auth/:platform/url
// Platform-specific callback:    GET/POST /api/auth/:platform/callback
router.all('/:platform/url', getPlatformAuthUrl);
router.all('/:platform/callback', handlePlatformCallback);

// ─── LEGACY COMPATIBILITY (will be deprecated) ──────────────────
router.post('/etsy/url', getEtsyAuthUrl);
router.post('/etsy/callback', etsyCallback);
router.get('/meta/url', getMetaAuthUrl);
router.post('/meta/callback', metaCallback);
router.get('/tiktok/url', getTikTokAuthUrl);
router.post('/tiktok/callback', tiktokCallback);

export default router;
