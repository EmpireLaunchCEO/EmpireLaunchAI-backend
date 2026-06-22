import { Request, Response } from 'express';
import { paypalService } from '../services/paypalService.js';
import { db, schema } from '../db/index.js';
const { users } = schema;
import { eq } from 'drizzle-orm';

export const onboardUser = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const returnUrl = `${process.env.FRONTEND_URL}/paypal/callback?userId=${userId}`;
    
    const { onboardingUrl } = await paypalService.generateOnboardingLink(userId, returnUrl);
    res.json({ url: onboardingUrl });
  } catch (error: any) {
    console.error('Error in PayPal onboarding:', error);
    res.status(500).json({ error: error.message });
  }
};

export const callback = async (req: Request, res: Response) => {
  try {
    const { userId, merchantIdInPayPal } = req.query;
    if (!userId || !merchantIdInPayPal) {
      return res.status(400).json({ error: 'Missing userId or merchantIdInPayPal' });
    }

    await paypalService.saveMerchantConnection(userId as string, merchantIdInPayPal as string);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error in PayPal callback:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getAccountStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    res.json({
      connected: !!(user && user.paypalMerchantId),
      merchantId: user?.paypalMerchantId || null
    });
  } catch (error: any) {
    console.error('Error in PayPal status:', error);
    res.status(500).json({ error: error.message });
  }
};
