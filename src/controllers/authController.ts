import { Request, Response } from 'express';
import { etsyService } from '../services/etsyService.js';
import { metaService } from '../services/metaService.js';
import { db } from '../db/index.js';
import { integrations } from '../db/schema.js';
import { encrypt } from '../utils/encryption.js';
import crypto from 'crypto';

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
    
    const encryptedCredentials = encrypt(JSON.stringify(tokenData));

    await db.insert(integrations).values({
      userId: userId,
      platform: 'etsy',
      credentials: { data: encryptedCredentials },
    });

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
    
    const encryptedCredentials = encrypt(JSON.stringify(longLivedToken));

    await db.insert(integrations).values({
      userId: userId,
      platform: 'meta',
      credentials: { data: encryptedCredentials },
    });

    res.json({ status: 'success', message: 'Meta integrated successfully' });
  } catch (error: any) {
    console.error('Meta callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate Meta' });
  }
};
