import { Router } from 'express';
import { db } from '../db/index.js';
import {
  registerUser,
  loginUser,
  logoutUser,
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
import { mobileAuth } from '../middleware/mobileAuth.js';

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
// Revokes the caller's own session row. Behind mobileAuth, so only a real
// signed-in session can end itself.
router.post('/logout', mobileAuth, logoutUser);
router.post('/terms/accept', mobileAuth, acceptTerms);
router.post('/redeem-key', redeemKey);
router.post('/master-login', masterLogin);

// ─── PUBLIC OAUTH DOORS ─────────────────────────────────────────
// `/:platform/url` needs a signed-in session (it mints an OAuth session for
// that user), so it sits behind mobileAuth. `/:platform/callback` is a browser
// redirect from the platform and carries no headers: the user is resolved from
// the OAuth session row that `sessionId` / `state` identifies.
router.all('/:platform/url', mobileAuth, getPlatformAuthUrl);
router.all('/:platform/callback', handlePlatformCallback);

// ─── LEGACY COMPATIBILITY (will be deprecated) ──────────────────
router.post('/etsy/url', mobileAuth, getEtsyAuthUrl);
router.post('/etsy/callback', etsyCallback);
router.get('/meta/url', mobileAuth, getMetaAuthUrl);
router.post('/meta/callback', metaCallback);
router.get('/tiktok/url', mobileAuth, getTikTokAuthUrl);
router.post('/tiktok/callback', tiktokCallback);

export default router;
