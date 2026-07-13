import { Router } from 'express';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { integrationService } from '../services/integrationService.js';
import { vaultService } from '../services/vaultService.js';
import { universalGatewayService } from '../services/universalGatewayService.js';
import { handleExtractionService } from '../services/handleExtractionService.js';

const router = Router();

/**
 * GET /api/integrations/handles
 * Returns platform handles (@usernames, shop names) for all connected platforms.
 */
router.get('/handles', mobileAuth, async (req: any, res) => {
  const userId = req.userId;
  try {
    const handles = await handleExtractionService.getStoredHandles(userId);
    res.json({ status: 'success', handles });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/integrations/handles/refresh
 * Attempts to refresh/extract handles for all connected platforms via Playwright.
 */
router.post('/handles/refresh', mobileAuth, async (req: any, res) => {
  const userId = req.userId;
  try {
    const userIntegrations = await db.select()
      .from(schema.integrations)
      .where(and(
        eq(schema.integrations.userId, userId),
        eq(schema.integrations.isActive, true)
      ));

    const results: Record<string, string | null> = {};
    for (const integration of userIntegrations) {
      const platform = integration.platform;
      const handle = await handleExtractionService.extractHandle(userId, platform);
      if (handle) {
        await handleExtractionService.updateStoredHandle(userId, platform, handle);
        results[platform] = handle;
      } else {
        results[platform] = integration.platformAccountHandle || null;
      }
    }

    res.json({ status: 'success', handles: results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

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

      const integration = userIntegrations.find((i: any) => i.platform === platformKey);
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
    
    res.json({ status: 'success', id, message: `${platform} linked successfully` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/integrations/:platform
 * Disconnect a platform by removing its integration record.
 */
router.delete('/:platform', mobileAuth, async (req: any, res) => {
  const userId = req.userId;
  const { platform } = req.params;

  if (!platform) {
    return res.status(400).json({ error: 'Platform is required' });
  }

  try {
    await integrationService.removeIntegration(userId, platform);
    res.json({ status: 'success', message: `${platform} disconnected successfully` });
  } catch (error: any) {
    console.error(`[IntegrationRoute] Failed to disconnect ${platform}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
