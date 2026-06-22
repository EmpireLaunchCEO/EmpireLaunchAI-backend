import { Request, Response } from 'express';
import { onboardingOrchestrator } from '../services/onboardingOrchestrator.js';

export const startOnboarding = async (req: Request, res: Response) => {
  try {
    const { userId, platform } = req.body;
    if (!userId || !platform) {
      return res.status(400).json({ error: 'userId and platform are required' });
    }

    const { sessionId } = await onboardingOrchestrator.startOnboarding(userId, platform);

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
