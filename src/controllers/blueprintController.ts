import { Request, Response } from 'express';
import { blueprintService } from '../services/blueprintService.js';

export const createKittlBlueprint = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const { niche, productTitle, targetAudience, isEmpireMode } = req.body;

    if (!niche || !productTitle) {
      return res.status(400).json({ error: 'niche and productTitle are required' });
    }

    const blueprint = await blueprintService.generateKittlBlueprint({
      userId,
      platform: 'kittl',
      niche,
      productTitle,
      targetAudience: targetAudience || 'general audience',
      isEmpireMode: !!isEmpireMode
    });

    res.json(blueprint);
  } catch (error: any) {
    console.error('Error in createKittlBlueprint:', error);
    res.status(500).json({ error: error.message });
  }
};

export const createCapCutBlueprint = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const { niche, productTitle, targetAudience } = req.body;

    if (!niche || !productTitle) {
      return res.status(400).json({ error: 'niche and productTitle are required' });
    }

    const blueprint = await blueprintService.generateCapCutBlueprint({
      userId,
      platform: 'capcut',
      niche,
      productTitle,
      targetAudience: targetAudience || 'social media users'
    });

    res.json(blueprint);
  } catch (error: any) {
    console.error('Error in createCapCutBlueprint:', error);
    res.status(500).json({ error: error.message });
  }
};
