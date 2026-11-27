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
import { hashPassword, verifyPassword } from '../services/passwordHash.js';
import { createSession, revokeSession, sessionTokenFromRequest } from '../services/authSessions.js';
import { attributeSignupReferral } from '../services/repTracking.js';

/**
 * Mint a real session for a user and answer with it.
 *
 * Every door that signs somebody in (register, login, master login) answers
 * `{ status:'success', userId, token, expiresAt }`. The token is the raw session
 * token — returned here once, stored only as a SHA-256 digest — and it is the
 * ONLY thing the frontend should send back (`Authorization: Bearer <token>`).
 * The `userId` is informational; it is never a credential.
 */
async function issueSession(
  res: Response,
  userId: string,
  extra: Record<string, unknown> = {},
  req?: Request,
) {
  const { token, expiresAt } = await createSession(userId, req?.headers?.['user-agent'] as string | undefined);
  return res.json({
    status: 'success',
    userId,
    token,
    expiresAt: expiresAt.toISOString(),
    ...extra,
  });
}

export const registerUser = async (req: Request, res: Response) => {
  console.log('[DEBUG] Registering user:', req.body.email);
  const { email, password, referralCode } = req.body;
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

    // Attribution happens at SIGNUP, not at payment: whoever's /join/<code>
    // brought this client in owns them from here, whether they pay today or in
    // March. An unknown or inactive code attributes nothing, and a failure here
    // must never fail the signup itself.
    if (referralCode) {
      try {
        await attributeSignupReferral({ clientUserId: userId, code: referralCode });
      } catch (referralError: any) {
        console.error('[register] referral attribution failed:', referralError?.message || referralError);
      }
    }

    console.log('[DEBUG] Registration successful for:', email);
    return issueSession(res, userId, {}, req);
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
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // Check the password against the stored hash. A legacy (unsalted pbkdf2)
    // hash still verifies ONCE and is then rewritten in the scrypt format, so
    // the old scheme stops being reachable for this account after this login.
    const check = await verifyPassword(password, user.passwordHash);
    if (check.ok) {
      if (check.needsRehash) {
        try {
          const upgraded = await hashPassword(password);
          await db.update(users)
            .set({ passwordHash: upgraded, updatedAt: new Date() })
            .where(eq(users.id, user.id));
        } catch (err) {
          console.warn('[auth] legacy password upgrade failed:', (err as Error)?.message);
        }
      }
      return issueSession(res, user.id, {}, req);
    }

    // Owner bypass: allow a configured master key as the owner's password.
    // With OWNER_MASTER_KEYS unset the list is empty, so this refuses.
    const cleanPassword = String(password).trim().toUpperCase();
    if (email === OWNER_CONFIG.email && OWNER_CONFIG.allowedMasterKeys.includes(cleanPassword)) {
      return issueSession(res, user.id, {}, req);
    }

    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Revoke the caller's session. The token that made the request stops working
 * immediately; every other session of the same user is untouched.
 */
export const logoutUser = async (req: Request, res: Response) => {
  try {
    const token = sessionTokenFromRequest(req);
    await revokeSession(token);
    return res.json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const acceptTerms = async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { version } = req.body;
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

    // Check if Etsy OAuth credentials are configured and working
    const clientId = process.env.ETSY_CLIENT_ID;
    const clientSecret = process.env.ETSY_CLIENT_SECRET;
    if (!clientId || !clientSecret || clientId.length < 10) {
      return res.status(400).json({
        error: 'MISSING_KEYS',
        key: 'ETSY_CLIENT_ID',
        platform: 'etsy'
      });
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

    try {
      const url = etsyService.getAuthUrl(state, codeChallenge);
      if (!url || url.includes('client_id=&')) {
        throw new Error('MISSING_KEYS');
      }
      res.json({ url, state, sessionId });
    } catch (error: any) {
      // Clean up the session since we can't use it
      await db.delete(oauthSessions).where(eq(oauthSessions.id, sessionId)).catch(() => {});
      if (error.message === 'MISSING_KEYS') {
        return res.status(400).json({
          error: 'MISSING_KEYS',
          key: 'ETSY_CLIENT_ID',
          platform: 'etsy'
        });
      }
      res.status(500).json({ error: 'Failed to initiate Etsy OAuth' });
    }
  };

export const etsyCallback = async (req: Request, res: Response) => {
  const { code, state, sessionId } = req.body;
  // Public redirect callback: the OAuth session row it was started with carries
  // the user. If a signed-in caller also names itself, it must match.
  const claimedUserId = (req as any).userId as string | undefined;

  if (!code || !state || !sessionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const [session] = await db.select().from(oauthSessions).where(eq(oauthSessions.id, sessionId)).limit(1);
    if (!session || session.used || session.state !== state || new Date() > new Date(session.expiresAt)) {
      return res.status(400).json({ error: 'Invalid or expired session' });
    }
    if (claimedUserId && session.userId !== claimedUserId) {
      return res.status(400).json({ error: 'Invalid or expired session' });
    }
    const userId = session.userId;

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
  const userId = (req as any).userId;
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
  // Public redirect callback (the platform sends the browser here with no
  // headers). The user is whoever STARTED the flow, carried by the OAuth
  // session row that `sessionId` / `state` identifies — never `?userId=`, which
  // any caller can type.
  const userId = (req as any).userId as string | undefined;
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
  const userId = (req as any).userId;
  const { key } = req.body;
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
      await db.update(users).set({ tier: 'OWNER_MASTER', businessSlots: 3, updatedAt: new Date() }).where(eq(users.id, userId));
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

export const masterLogin = async (req: Request, res: Response) => {
  const { email, key } = req.body;
  if (!email || !key) return res.status(400).json({ error: 'Email and master key are required' });

  try {
    const cleanKey = String(key).trim().toUpperCase();
    // Keys come from OWNER_MASTER_KEYS only. When it is unset the list is empty
    // and master login refuses — fail closed, never a built-in fallback.
    const isMasterKey = OWNER_CONFIG.allowedMasterKeys.includes(cleanKey);
    if (!isMasterKey) return res.status(401).json({ error: 'Invalid master key' });

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return res.status(401).json({ error: 'User not found' });

    await db.update(users).set({ tier: 'OWNER_MASTER', businessSlots: 3, updatedAt: new Date() }).where(eq(users.id, user.id));
    return issueSession(res, user.id, {}, req);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};
