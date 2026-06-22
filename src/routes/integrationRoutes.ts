import { Router } from 'express';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { integrationService } from '../services/integrationService.js';
import { vaultService } from '../services/vaultService.js';
import { universalGatewayService } from '../services/universalGatewayService.js';

const router = Router();

/**
 * GET /api/integrations/status
 * Returns the connection status for all primary platforms.
 */
router.get('/status', mobileAuth, async (req: any, res) => {
  const userId = req.userId;
  
  try {
    const userIntegrations = await db.select()
      .from(schema.integrations)
      .where(eq(schema.integrations.userId, userId));

    const platforms = [
      'etsy', 'tiktok', 'godaddy', 'systeme_io', 
      'fiverr', 'behance', 'figma', 'kittl', 'redbubble',
      'canva', 'google', 'youtube', 'meta', 'instagram', 'pinterest', 'shopify'
    ];

    const status = platforms.map(p => {
      // Handle aliases for status lookup
      let platformKey = p;
      if (p === 'youtube') platformKey = 'google';
      if (p === 'instagram') platformKey = 'meta';

      const integration = userIntegrations.find(i => i.platform === platformKey);
      return {
        platform: p,
        isConnected: !!integration && integration.isActive,
        handle: integration?.platformAccountHandle || null,
        updatedAt: integration?.updatedAt || null
      };
    });

    res.json({ status: 'success', integrations: status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/integrations/oauth/:platform/url
 * Initiates OAuth flow for a platform via Universal Gateway.
 */
router.get('/oauth/:platform/url', mobileAuth, async (req: any, res) => {
  const userId = req.userId;
  const platform = req.params.platform;
  const shopDomain = req.query.shop as string;

  try {
    const result = await universalGatewayService.initiateOAuth(userId, platform, shopDomain);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/integrations/oauth/:platform/callback
 * Handles the OAuth callback and saves tokens.
 */
router.post('/oauth/:platform/callback', mobileAuth, async (req: any, res) => {
  const userId = req.userId;
  const platform = req.params.platform;
  const { code, state, sessionId, shop } = req.body;

  try {
    const result = await universalGatewayService.handleCallback(userId, platform, code, state, sessionId, shop);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/integrations/manual
 * Manually link a platform using API Keys (for GoDaddy, Systeme.io)
 */
router.post('/manual', mobileAuth, async (req: any, res) => {
  const userId = req.userId;
  const { platform, credentials, handle } = req.body;

  if (!platform || !credentials) {
    return res.status(400).json({ error: 'Platform and credentials are required' });
  }

  try {
    // Store in vault for high-trust security
    if (platform === 'godaddy') {
      await vaultService.storeSecretWithEnvelope(userId, 'GODADDY', 'API_KEY', credentials.apiKey);
      await vaultService.storeSecretWithEnvelope(userId, 'GODADDY', 'API_SECRET', credentials.apiSecret);
    } else if (platform === 'systeme_io') {
      await vaultService.storeSecretWithEnvelope(userId, 'SYSTEME_IO', 'API_KEY', credentials.apiKey);
    }

    // Save to integrations table
    const id = await integrationService.saveIntegration(userId, platform, credentials, undefined, handle);
    
    res.json({ status: 'success', id, message: `\${platform} linked successfully` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
