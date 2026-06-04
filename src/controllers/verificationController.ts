import { Request, Response } from 'express';
import { verificationService } from '../services/verificationService.js';

export const initiateVerification = async (req: Request, res: Response) => {
  try {
    const { platform, handle } = req.body;
    const userId = (req as any).user?.id;

    if (!platform || !handle) {
      return res.status(400).json({ error: 'Platform and handle are required' });
    }

    const hash = await verificationService.initiateVerification(userId, platform, handle);
    res.json({ hash, message: `Please add this hash to your ${platform} bio: ${hash}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const verifyHandle = async (req: Request, res: Response) => {
  try {
    const { platform, handle } = req.body;
    const userId = (req as any).user?.id;

    if (!platform || !handle) {
      return res.status(400).json({ error: 'Platform and handle are required' });
    }

    const result = await verificationService.verifyHandle(userId, platform, handle);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getVerifiedHandles = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const handles = await verificationService.getVerifiedHandles(userId);
    res.json(handles);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
