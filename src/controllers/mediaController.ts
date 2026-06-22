import { Request, Response } from 'express';
import { mediaService } from '../services/mediaService.js';
import path from 'path';

export const generateProductImage = async (req: Request, res: Response) => {
  try {
    const { productName, niche } = req.body;
    
    if (!productName || !niche) {
      return res.status(400).json({ error: 'productName and niche are required' });
    }

    const imagePath = await mediaService.createProductImage(productName, niche);
    
    res.json({
      status: 'success',
      imagePath: imagePath,
      publicUrl: `/assets/temp/${path.basename(imagePath)}`
    });
  } catch (error) {
    console.error('Error generating product image:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const combineVideos = async (req: Request, res: Response) => {
  try {
    const { clips, outputName, audioPath } = req.body;
    
    if (!clips || !Array.isArray(clips) || !outputName) {
      return res.status(400).json({ error: 'clips (array) and outputName are required' });
    }

    const videoPath = await mediaService.generateVideo({
      clips,
      outputName,
      audioPath
    });
    
    res.json({
      status: 'success',
      videoPath: videoPath,
      publicUrl: `/assets/temp/${path.basename(videoPath)}`
    });
  } catch (error) {
    console.error('Error combining videos:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
