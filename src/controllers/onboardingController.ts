import { Request, Response } from 'express';
import { onboardingOrchestrator } from '../services/onboardingOrchestrator.js';
import { stripeService } from '../services/stripeService.js';
import { vaultService } from '../services/vaultService.js';
import { db, schema } from '../db/index.js';
const { users } = schema;
import { eq } from 'drizzle-orm';

export const startOnboarding = async (req: Request, res: Response) => {
  try {
    const { userId, platform, credentials } = req.body;
    if (!userId || !platform) {
      return res.status(400).json({ error: 'userId and platform are required' });
    }

    if (platform === 'stripe') {
      const returnUrl = `${process.env.FRONTEND_URL}/stripe/callback?userId=${userId}`;
      const refreshUrl = `${process.env.FRONTEND_URL}/stripe/onboard?userId=${userId}`;
      
      let stripeAccountId = await vaultService.getSecret(userId, 'stripe', 'stripe_account_id');
      
      if (!stripeAccountId) {
        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        const account = await stripeService.createConnectAccount(user.email);
        stripeAccountId = account.id;
        await vaultService.storeSecret(userId, 'stripe', 'stripe_account_id', stripeAccountId);
      }

      const accountLink = await stripeService.createAccountLink(stripeAccountId, returnUrl, refreshUrl);
      return res.json({ status: 'success', url: accountLink.url });
    }

    const { sessionId } = await onboardingOrchestrator.startOnboarding(userId, platform, credentials);

    res.json({
      status: 'success',
      sessionId,
      message: `Onboarding session started for ${platform}`,
    });
  } catch (error: any) {
    console.error('Error starting onboarding:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getOnboardingStatus = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required as a string' });
    }

    const session = await onboardingOrchestrator.getSessionStatus(sessionId as string);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      status: 'success',
      session,
    });
  } catch (error: any) {
    console.error('Error getting onboarding status:', error);
    res.status(500).json({ error: error.message });
  }
};

export const startTikTokQRLogin = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const result = await onboardingOrchestrator.startTikTokQRLogin(userId);
    if (!result) {
      return res.status(500).json({ error: 'Failed to start TikTok QR login' });
    }

    res.json({
      status: 'success',
      sessionId: result.sessionId,
      qrCode: result.qrCodeBase64,
      message: 'Scan the QR code with your TikTok app to log in',
    });
  } catch (error: any) {
    console.error('Error starting TikTok QR login:', error);
    res.status(500).json({ error: error.message });
  }
};
