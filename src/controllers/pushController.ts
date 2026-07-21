import { Request, Response } from 'express';
import { notificationService } from '../services/notificationService.js';
import dotenv from 'dotenv';

dotenv.config();

export const getPublicKey = (req: Request, res: Response) => {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(500).json({ error: 'VAPID public key not configured' });
  }
  res.json({ publicKey });
};

export const subscribe = async (req: Request, res: Response) => {
  try {
    const { subscription, platform, type } = req.body;
    const userId = (req as any).userId;

    if (!subscription || (type === 'NATIVE' && !subscription.token) || (type !== 'NATIVE' && !subscription.endpoint)) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }

    const result = await notificationService.subscribeUser(userId, subscription, type || 'WEB', platform);
    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('Error subscribing to push:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Endpoint for testing push notifications.
 */
export const testPush = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const result = await notificationService.sendPushNotification(userId, {
      title: 'EmpireLaunch AI Test',
      body: 'Your mobile push infrastructure is ready!',
      data: { url: '/dashboard', type: 'GENERAL' }
    });
    res.json({ success: true, results: result });
  } catch (error: any) {
    console.error('Error testing push:', error);
    res.status(500).json({ error: error.message });
  }
};
