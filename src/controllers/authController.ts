import { Request, Response } from 'express';
import { etsyService } from '../services/etsyService.js';
import { metaService } from '../services/metaService.js';
import { db, schema } from '../db/index.js';
const { integrations } = schema;
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

    // @ts-ignore
    await db.insert(integrations).values({
      userId: userId,
      platform: 'etsy',
      credentials: { data: encryptedCredentials },
      createdAt: new Date(),
      updatedAt: new Date()
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

    // @ts-ignore
    await db.insert(integrations).values({
      userId: userId,
      platform: 'meta',
      credentials: { data: encryptedCredentials },
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ status: 'success', message: 'Meta integrated successfully' });
  } catch (error: any) {
    console.error('Meta callback error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to integrate Meta' });
  }
};

import { gmailService } from '../services/gmailService.js';
import { outlookService } from '../services/outlookService.js';
import { integrationService } from '../services/integrationService.js';

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
