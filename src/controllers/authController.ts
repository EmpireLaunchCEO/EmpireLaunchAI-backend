import { Request, Response } from 'express';
import { etsyService } from '../services/etsyService.js';
import { metaService } from '../services/metaService.js';
import { db, schema } from '../db/index.js';
const { users } = schema;
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { gmailService } from '../services/gmailService.js';
import { outlookService } from '../services/outlookService.js';
import { youtubeService } from '../services/youtubeService.js';
import { tiktokService } from '../services/tiktokService.js';
import { integrationService } from '../services/integrationService.js';

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

export const getEtsyAuthUrl = (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  // In a real app, we would store state and codeVerifier in session or redis
  const url = etsyService.getAuthUrl(state, codeChallenge);
  
  res.json({ url, state, codeVerifier });
};

export const etsyCallback = async (req: Request, res: Response) => {
  const { code, codeVerifier, userId } = req.body;

  try {
    const tokenData = await etsyService.getAccessToken(code, codeVerifier);
    
    // Fetch shop info to get shopId
    const shopData = await etsyService.getShop(tokenData.access_token);
    const shopId = shopData.results?.[0]?.shop_id;

    await integrationService.saveIntegration(userId, 'etsy', tokenData, shopId?.toString());
    res.json({ status: 'success', message: 'Etsy integrated successfully' });
  } catch (error: any) {
    console.error('Etsy callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate Etsy' });
  }
};

export const getMetaAuthUrl = (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url = metaService.getAuthUrl(state);
  res.json({ url, state });
};

export const metaCallback = async (req: Request, res: Response) => {
  const { code, userId } = req.body;

  try {
    const shortLivedToken = await metaService.getAccessToken(code);
    const longLivedToken = await metaService.getLongLivedToken(shortLivedToken.access_token);
    
    await integrationService.saveIntegration(userId, 'meta', longLivedToken);
    res.json({ status: 'success', message: 'Meta integrated successfully' });
  } catch (error: any) {
    console.error('Meta callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate Meta' });
  }
};

export const getGmailAuthUrl = (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url = gmailService.getAuthUrl(state);
  res.json({ url, state });
};

export const gmailCallback = async (req: Request, res: Response) => {
  const { code, userId } = req.body;

  try {
    const tokenData = await gmailService.getAccessToken(code);
    await integrationService.saveIntegration(userId, 'gmail', tokenData);
    res.json({ status: 'success', message: 'Gmail integrated successfully' });
  } catch (error: any) {
    console.error('Gmail callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate Gmail' });
  }
};

export const getOutlookAuthUrl = (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url = outlookService.getAuthUrl(state);
  res.json({ url, state });
};

export const outlookCallback = async (req: Request, res: Response) => {
  const { code, userId } = req.body;

  try {
    const tokenData = await outlookService.getAccessToken(code);
    await integrationService.saveIntegration(userId, 'outlook', tokenData);
    res.json({ status: 'success', message: 'Outlook integrated successfully' });
  } catch (error: any) {
    console.error('Outlook callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate Outlook' });
  }
};

export const getYouTubeAuthUrl = (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url = youtubeService.getAuthUrl(state);
  res.json({ url, state });
};

export const youtubeCallback = async (req: Request, res: Response) => {
  const { code, userId } = req.body;

  try {
    const tokenData = await youtubeService.getAccessToken(code);
    await integrationService.saveIntegration(userId, 'youtube', tokenData);
    res.json({ status: 'success', message: 'YouTube integrated successfully' });
  } catch (error: any) {
    console.error('YouTube callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate YouTube' });
  }
};

export const getTikTokAuthUrl = (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  const url = tiktokService.getAuthUrl(state);
  res.json({ url, state });
};

export const tiktokCallback = async (req: Request, res: Response) => {
  const { code, userId } = req.body;

  try {
    const tokenData = await tiktokService.getAccessToken(code);
    await integrationService.saveIntegration(userId, 'tiktok_display', tokenData);
    res.json({ status: 'success', message: 'TikTok integrated successfully' });
  } catch (error: any) {
    console.error('TikTok callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate TikTok' });
  }
};

export const redeemKey = async (req: Request, res: Response) => {
  const { userId, key } = req.body;
  if (!userId || !key) {
    return res.status(400).json({ error: 'UserId and key are required' });
  }

  try {
    const [accessKey] = await db.select().from(schema.accessKeys).where(eq(schema.accessKeys.key, key)).limit(1);
    
    if (!accessKey) {
      return res.status(404).json({ error: 'Invalid access key' });
    }
    
    if (accessKey.isUsed) {
      return res.status(400).json({ error: 'Access key already used' });
    }

    await db.transaction(async (tx) => {
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
