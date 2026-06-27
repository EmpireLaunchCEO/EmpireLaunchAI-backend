import { Request, Response } from 'express';
import { etsyService } from '../services/etsyService.js';
import { metaService } from '../services/metaService.js';
import { db, schema } from '../db/index.js';
const { users, oauthSessions, userSettings } = schema;
import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';
import { gmailService } from '../services/gmailService.js';
import { outlookService } from '../services/outlookService.js';
import { youtubeService } from '../services/youtubeService.js';
import { tiktokService } from '../services/tiktokService.js';
import { integrationService } from '../services/integrationService.js';
import { universalGatewayService } from '../services/universalGatewayService.js';
import { OWNER_CONFIG } from '../config/owner.js';
import { v4 as uuidv4 } from 'uuid';

import { promisify } from 'util';

const pbkdf2 = promisify(crypto.pbkdf2);

// Simple password hashing using Node's crypto (Async for scalability)
async function hashPassword(password: string): Promise<string> {
  const hash = await pbkdf2(password, 'empire-launch-salt', 1000, 64, 'sha512');
  return hash.toString('hex');
}

export const registerUser = async (req: Request, res: Response) => {
  console.log('[DEBUG] Registering user:', req.body.email);
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    console.log('[DEBUG] Checking if user exists...');
    const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingUser.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const userId = uuidv4();
    const passwordHash = await hashPassword(password);

    console.log('[DEBUG] Inserting user into DB...');
    try {
      await db.insert(users).values({
        id: userId,
        email,
        passwordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
        tier: 'STANDARD_USER',
      });
    } catch (insertError: any) {
      console.error('[DEBUG] DB Insert failed:', insertError);
      return res.status(500).json({ error: `DB Insert failed: ${insertError.message}` });
    }

    console.log('[DEBUG] Creating default settings...');
    try {
      await db.insert(userSettings).values({
        id: uuidv4(),
        userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (settingsError: any) {
      console.error('[DEBUG] Settings insert failed:', settingsError);
      // Not a fatal error for registration itself, but let's report it
    }

    console.log('[DEBUG] Registration successful for:', email);
    res.json({ status: 'success', userId });
  } catch (error: any) {
    console.error('Registration error (outer):', error);
    res.status(500).json({ error: `Outer registration error: ${error.message}` });
  }
};

export const loginUser = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || user.passwordHash !== await hashPassword(password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({ status: 'success', userId: user.id });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

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
  const userId = (req as any).userId || req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  const sessionId = uuidv4();
  await db.insert(oauthSessions).values({
    id: sessionId,
    userId,
    platform: 'etsy',
    state,
    codeVerifier,
    used: false,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
  });

  const url = etsyService.getAuthUrl(state, codeChallenge);
  res.json({ url, state, sessionId });
};

export const etsyCallback = async (req: Request, res: Response) => {
  const { code, state, sessionId } = req.body;
  const userId = (req as any).userId || req.headers['x-user-id'];

  if (!code || !state || !sessionId || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const [session] = await db.select().from(oauthSessions).where(eq(oauthSessions.id, sessionId)).limit(1);
    if (!session || session.used || session.state !== state || new Date() > new Date(session.expiresAt) || session.userId !== userId) {
      return res.status(400).json({ error: 'Invalid or expired session' });
    }

    await db.update(oauthSessions).set({ used: true }).where(eq(oauthSessions.id, sessionId));
    const tokenData = await etsyService.getAccessToken(code, session.codeVerifier);
    const shopData = await etsyService.getShop(tokenData.access_token);
    const shop = shopData.results?.[0];
    const shopId = shop?.shop_id;
    const shopName = shop?.shop_name;

    await integrationService.saveIntegration(userId, 'etsy', tokenData, shopId?.toString(), shopName);
    res.json({ status: 'success', handle: shopName });
  } catch (error) {
    res.status(500).json({ error: 'Failed to integrate Etsy' });
  }
};

export const getPlatformAuthUrl = async (req: Request, res: Response) => {
  const userId = (req as any).userId || req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  const platform = req.params.platform as string;
  try {
    const result = await universalGatewayService.initiateOAuth(userId, platform);
    res.json(result);
  } catch (error: any) {
    if (error.message === 'MISSING_KEYS') {
      return res.status(400).json({ 
        error: 'MISSING_KEYS', 
        key: error.key,
        platform 
      });
    }
    res.status(500).json({ error: error.message });
  }
};

export const handlePlatformCallback = async (req: Request, res: Response) => {
  const userId = (req as any).userId || req.headers['x-user-id'] || req.body.userId || req.query.userId;
  const platform = req.params.platform as string;
  const { code, state, sessionId } = { ...req.query, ...req.body } as any;
  
  try {
    const result = await universalGatewayService.handleCallback(userId, platform, code, state, sessionId);
    
    // If it's a GET request (direct redirect from platform), redirect back to frontend
    if (req.method === 'GET') {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/onboarding?status=success&platform=${platform}&handle=${encodeURIComponent(result.handle || '')}`);
    }
    
    res.json(result);
  } catch (error: any) {
    console.error(`[handlePlatformCallback] Error for ${platform}:`, error);
    
    if (req.method === 'GET') {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${frontendUrl}/onboarding?status=error&message=${encodeURIComponent(error.message)}`);
    }
    
    res.status(500).json({ error: error.message });
  }
};

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
  if (!key) return res.status(400).json({ error: 'Missing key' });
  
  try {
    const cleanKey = key.trim().toUpperCase();
    const isMasterKey = OWNER_CONFIG.allowedMasterKeys.includes(cleanKey as any);
    
    // If no userId, we are just verifying the key's existence and validity
    if (!userId) {
      if (isMasterKey) {
        return res.json({ status: 'success', message: 'Master key valid' });
      }
      const [accessKey] = await db.select().from(schema.accessKeys).where(eq(schema.accessKeys.key, key)).limit(1);
      if (!accessKey || accessKey.isUsed) return res.status(400).json({ error: 'Invalid or used key' });
      return res.json({ status: 'success', message: 'Key valid' });
    }

    // Standard redemption logic with userId
    if (isMasterKey) {
      await db.update(users).set({ tier: 'EMPIRE_MASTER', businessSlots: 3, updatedAt: new Date() }).where(eq(users.id, userId));
      return res.json({ status: 'success', message: 'Master access granted' });
    }
    const [accessKey] = await db.select().from(schema.accessKeys).where(eq(schema.accessKeys.key, key)).limit(1);
    if (!accessKey || accessKey.isUsed) return res.status(400).json({ error: 'Invalid or used key' });
    await db.transaction(async (tx: any) => {
      await tx.update(users).set({ tier: accessKey.tier, accessKey: accessKey.key, updatedAt: new Date() }).where(eq(users.id, userId));
      await tx.update(schema.accessKeys).set({ isUsed: true, usedBy: userId, updatedAt: new Date() }).where(eq(schema.accessKeys.id, accessKey.id));
    });
    res.json({ status: 'success' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};
