import { Request, Response } from 'express';
import { etsyService } from '../services/etsyService.js';
import { metaService } from '../services/metaService.js';
import { db, schema } from '../db/index.js';
const { users, oauthSessions } = schema;
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { gmailService } from '../services/gmailService.js';
import { outlookService } from '../services/outlookService.js';
import { youtubeService } from '../services/youtubeService.js';
import { tiktokService } from '../services/tiktokService.js';
import { integrationService } from '../services/integrationService.js';
import { universalGatewayService } from '../services/universalGatewayService.js';
import { OWNER_CONFIG } from '../config/owner.js';
import { v4 as uuidv4 } from 'uuid';

export const acceptTerms = async (req: Request, res: Response) => {
  const { userId, version } = req.body;
  if (!userId || !version) {
    return res.status(400).json({ error: 'UserId and version are required' });
  }

  try {
    await db.update(users)
      .set({ termsAcceptedVersion: version, updatedAt: new Date() })
      .where(eq(users.id, userId));
    
    res.json({ status: 'success', message: 'Terms accepted' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getEtsyAuthUrl = async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  // Persist OAuth session server-side — never send codeVerifier to the frontend
  const sessionId = uuidv4();
  await db.insert(oauthSessions).values({
    id: sessionId,
    userId,
    platform: 'etsy',
    state,
    codeVerifier,
    used: false,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min expiry
    createdAt: new Date(),
  });

  const url = etsyService.getAuthUrl(state, codeChallenge);

  // Only return the URL and state — codeVerifier stays server-side
  res.json({ url, state, sessionId });
};

export const etsyCallback = async (req: Request, res: Response) => {
  const { code, state, sessionId } = req.body;
  const userId = (req as any).userId;

  if (!code || !state || !sessionId || !userId) {
    return res.status(400).json({ error: 'Missing required fields: code, state, sessionId' });
  }

  try {
    // Retrieve and validate the OAuth session
    const [session] = await db.select()
      .from(oauthSessions)
      .where(eq(oauthSessions.id, sessionId))
      .limit(1);

    if (!session) {
      return res.status(400).json({ error: 'OAuth session not found. Please restart authorization.' });
    }

    if (session.used) {
      return res.status(400).json({ error: 'OAuth session already used. Please restart authorization.' });
    }

    if (session.state !== state) {
      return res.status(400).json({ error: 'State mismatch. Possible CSRF attack.' });
    }

    if (new Date() > new Date(session.expiresAt)) {
      return res.status(400).json({ error: 'OAuth session expired. Please restart authorization.' });
    }

    if (session.userId !== userId) {
      return res.status(403).json({ error: 'User ID mismatch.' });
    }

    // Mark session as used (prevent replay attacks)
    await db.update(oauthSessions)
      .set({ used: true })
      .where(eq(oauthSessions.id, sessionId));

    // Exchange code for tokens using the stored codeVerifier (never exposed to client)
    const tokenData = await etsyService.getAccessToken(code, session.codeVerifier);

    // Fetch shop info
    const shopData = await etsyService.getShop(tokenData.access_token);
    const shopId = shopData.results?.[0]?.shop_id;

    await integrationService.saveIntegration(userId, 'etsy', tokenData, shopId?.toString());
    res.json({ status: 'success', message: 'Etsy integrated successfully' });
  } catch (error: any) {
    console.error('Etsy callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate Etsy' });
  }
};

// ─── UNIVERSAL GATEWAY HANDLERS ────────────────────────────────────
// All platforms use the same secure OAuth pattern via universalGatewayService.

export const getPlatformAuthUrl = async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const platform = req.params.platform as string;
  const shopDomain = req.query.shop as string | undefined;

  if (typeof platform !== 'string' || !universalGatewayService.getConfig(platform)) {
    return res.status(400).json({ error: `Unsupported platform: ${platform}` });
  }

  try {
    const result = await universalGatewayService.initiateOAuth(userId, platform, shopDomain);
    res.json(result);
  } catch (error: any) {
    console.error(`[Auth] ${platform} auth URL error:`, error.message);
    res.status(500).json({ error: error.message });
  }
};

export const handlePlatformCallback = async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const platform = req.params.platform as string;
  const { code, state, sessionId, shop } = req.body;

  if (typeof platform !== 'string' || !code || !state || !sessionId) {
    return res.status(400).json({ error: 'Missing required fields: platform, code, state, sessionId' });
  }

  try {
    const result = await universalGatewayService.handleCallback(userId, platform, code, state, sessionId, shop as string);
    res.json(result);
  } catch (error: any) {
    console.error(`[Auth] ${platform} callback error:`, error.message);
    res.status(500).json({ error: error.message });
  }
};

// ─── LEGACY HANDLERS (delegate to Universal Gateway for TikTok/Meta) ──

export const getMetaAuthUrl = async (req: Request, res: Response) => {
  req.params = { platform: 'meta' };
  return getPlatformAuthUrl(req, res);
};

export const metaCallback = async (req: Request, res: Response) => {
  req.params = { platform: 'meta' };
  return handlePlatformCallback(req, res);
};

export const getTikTokAuthUrl = async (req: Request, res: Response) => {
  req.params = { platform: 'tiktok' };
  return getPlatformAuthUrl(req, res);
};

export const tiktokCallback = async (req: Request, res: Response) => {
  req.params = { platform: 'tiktok' };
  return handlePlatformCallback(req, res);
};

export const redeemKey = async (req: Request, res: Response) => {
  const { userId, key } = req.body;
  if (!userId || !key) {
    return res.status(400).json({ error: 'UserId and key are required' });
  }

  try {
    const cleanKey = key.trim().toUpperCase();

    // Permanent Owner/Admin Bypass
    if (cleanKey === OWNER_CONFIG.masterKey) {
      await db.update(users)
        .set({ tier: 'EMPIRE_MASTER', businessSlots: 5, updatedAt: new Date() })
        .where(eq(users.id, userId));
      
      return res.json({ status: 'success', message: 'Master access granted. Welcome, Admin.' });
    }

    const [accessKey] = await db.select().from(schema.accessKeys).where(eq(schema.accessKeys.key, key)).limit(1);
    
    if (!accessKey) {
      return res.status(404).json({ error: 'Invalid access key' });
    }
    
    if (accessKey.isUsed) {
      return res.status(400).json({ error: 'Access key already used' });
    }

    await db.transaction(async (tx: any) => {
      await tx.update(users)
        .set({ tier: accessKey.tier, accessKey: accessKey.key, updatedAt: new Date() })
        .where(eq(users.id, userId));
      
      await tx.update(schema.accessKeys)
        .set({ isUsed: true, usedBy: userId, updatedAt: new Date() })
        .where(eq(schema.accessKeys.id, accessKey.id));
    });

    res.json({ status: 'success', message: `Key redeemed. Account upgraded to ${accessKey.tier}.` });
  } catch (error) {
    console.error('Error redeeming key:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
