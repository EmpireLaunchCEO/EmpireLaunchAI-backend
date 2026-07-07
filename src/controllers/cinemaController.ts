import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import { cinemaEngineService } from '../services/cinemaEngineService.js';
import { usageService } from '../services/usageService.js';
import { productionDirector } from '../services/productionDirector.js';
import { renderingEngine } from '../services/renderingEngine.js';
import { approvalService } from '../services/approvalService.js';
import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';
const { creations } = schema;

// ─── Multer Configuration ───────────────────────────────────────────────────

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'assets', 'cinema', 'uploads');
const PHOTO_DIR = path.join(process.cwd(), 'public', 'assets', 'cinema', 'facial_dna');

const storage = multer.diskStorage({
  destination: (req: any, file: any, cb: any) => {
    const isPhoto = file.fieldname === 'photo';
    cb(null, isPhoto ? PHOTO_DIR : UPLOAD_DIR);
  },
  filename: (req: any, file: any, cb: any) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (req: any, file: any, cb: any) => {
  const isPhoto = file.fieldname === 'photo';
  const allowedPhoto = ['.jpg', '.jpeg', '.png', '.webp'];
  const allowedVideo = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (isPhoto && allowedPhoto.includes(ext)) return cb(null, true);
  if (!isPhoto && allowedVideo.includes(ext)) return cb(null, true);
  cb(new Error(`Invalid file type: ${ext}`));
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB max
  },
});

// ─── Controller ─────────────────────────────────────────────────────────────

export class CinemaController {

  /**
   * POST /api/cinema/upload-photo
   * Upload a facial photo for Neural Twin generation.
   */
  async uploadPhoto(req: Request, res: Response): Promise<void> {
    try {
      if (!(req as any).file) {
        res.status(400).json({ error: 'No photo uploaded' });
        return;
      }

      const filePath = (req as any).file.path;
      const validation = cinemaEngineService.validateUpload(filePath, 'photo');
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      // Store securely
      const storedPath = cinemaEngineService.storeUpload(filePath, 'photo');
      const userId = (req as any).user?.id || 'anonymous';

      // Save to creations table
      await db.insert(creations).values({
        id: uuidv4(),
        userId,
        type: 'facial_dna',
        title: `Facial Photo - ${path.basename(storedPath)}`,
        status: 'completed',
        fileUrl: storedPath,
        metadata: { originalName: (req as any).file?.originalname, size: (req as any).file?.size },
      });

      res.json({
        success: true,
        photoUrl: storedPath,
        filename: path.basename(storedPath),
        message: 'Photo uploaded successfully. Ready for Neural Twin generation.',
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/cinema/upload-video
   * Upload raw video material for AI editing.
   */
  async uploadVideo(req: Request, res: Response): Promise<void> {
    try {
      if (!(req as any).file) {
        res.status(400).json({ error: 'No video uploaded' });
        return;
      }

      const filePath = (req as any).file.path;
      const validation = cinemaEngineService.validateUpload(filePath, 'video');
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const storedPath = cinemaEngineService.storeUpload(filePath, 'video');
      const userId = (req as any).user?.id || 'anonymous';

      // Save to creations table
      await db.insert(creations).values({
        id: uuidv4(),
        userId,
        type: 'raw_video',
        title: `Raw Video - ${path.basename(storedPath)}`,
        status: 'completed',
        fileUrl: storedPath,
        metadata: { originalName: (req as any).file?.originalname, size: (req as any).file?.size },
      });

      res.json({
        success: true,
        videoUrl: storedPath,
        filename: path.basename(storedPath),
        fileSize: (req as any).file.size,
        message: 'Video uploaded successfully. Ready for AI Empire Style editing.',
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/cinema/create-twin
   * Create a Neural Twin video from uploaded photo and script.
   */
  async createNeuralTwin(req: Request, res: Response): Promise<void> {
    try {
      const { photoPath, script, voiceStyle } = req.body;
      const userId = (req as any).user?.id || 'system';

      if (!photoPath && !req.body.photoUrl) {
        res.status(400).json({ error: 'photoPath or photoUrl and script are required' });
        return;
      }

      const result = await cinemaEngineService.createNeuralTwin({
        userId,
        photoPath,
        photoUrl: req.body.photoUrl,
        script,
        voiceStyle,
      });

      res.json({
        success: result.status === 'completed',
        asset: result,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/cinema/generate-video
   * Full text-to-video pipeline: Gemini → DALL-E/Sharp/FFmpeg → stored + queued for review
   */
  async generateVideo(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      const { idea, niche } = req.body;
      if (!idea) {
        res.status(400).json({ error: 'idea is required' });
        return;
      }

      // Step 1: Gemini generates production script
      const script = await productionDirector.direct({
        campaignId: uuidv4(),
        userId,
        niche: niche || 'Custom Video',
        angle: idea,
        archetype: 'creator'
      });

      // Step 2: Render the video (DALL-E → Sharp → FFmpeg)
      const renderResult = await renderingEngine.render({
        scenes: script.scenes,
        pacing: script.pacing
      });

      if (!renderResult.success || !renderResult.videoUrl) {
        res.status(500).json({ error: 'Video rendering failed' });
        return;
      }

      // Step 3: Save to creations table
      const creationId = uuidv4();
      await db.insert(creations).values({
        id: creationId,
        userId,
        type: 'ai_video',
        title: script.title || idea.slice(0, 60),
        status: 'completed',
        fileUrl: renderResult.videoUrl,
        metadata: { idea, scenes: script.scenes.length, pacing: script.pacing }
      });

      // Step 4: Create approval record so it shows in Operations queue
      await approvalService.createRequest(
        userId, 'video', idea,
        { creationId, videoUrl: renderResult.videoUrl, sceneCount: script.scenes.length }
      );

      res.status(201).json({ success: true, creationId, videoUrl: renderResult.videoUrl });
    } catch (error: any) {
      console.error('Error generating video:', error);
      res.status(500).json({ status: 'error', error: error.message });
    }
  }

  /**
   * POST /api/cinema/enhance-video
   * Apply AI Empire Style enhancement to an uploaded video.
   */
  async enhanceVideo(req: Request, res: Response): Promise<void> {
    try {
      const { videoPath } = req.body;
      const userId = (req as any).user?.id || 'system';

      if (!videoPath) {
        res.status(400).json({ error: 'videoPath is required' });
        return;
      }

      const result = await cinemaEngineService.enhanceRawVideo(userId, videoPath);

      res.json({
        success: result.status === 'completed',
        asset: result,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/cinema/usage
   * Get usage remaining for the user.
   */
  async getUsage(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id || 'anonymous';
      const neuralRemaining = await usageService.getDailyRemaining(userId, 'neural_twin');
      const enhancedRemaining = await usageService.getDailyRemaining(userId, 'enhanced_video');
      const designRemaining = await usageService.getDailyRemaining(userId, 'high_res_design');
      const customizeRemaining = await usageService.getDailyRemaining(userId, 'customize_video');

      res.json({
        userId,
        neural: {
          remaining: neuralRemaining,
          limit: 14,
          period: 'week',
        },
        enhanced: {
          remaining: enhancedRemaining,
          limit: 'unlimited',
        },
        design: {
          remaining: designRemaining,
          limit: 50,
          period: 'month',
        },
        customize: {
          remaining: customizeRemaining,
          limit: 14,
          period: 'week',
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/cinema/status/:assetId
   * Check status of a cinema asset.
   */
  async getAssetStatus(req: Request, res: Response): Promise<void> {
    const { assetId } = req.params;
    // For now, return mock status — in production, check DB/queue
    res.json({
      assetId,
      status: 'completed',
      message: 'Neural Twin ready',
    });
  }

  /**
   * GET /api/cinema/creations
   * Fetch user's created assets (photos, videos, designs) for Operations Base.
   */
  async getCreations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id || (req.query.userId as string);
      if (!userId) {
        res.status(400).json({ error: 'userId required' });
        return;
      }

      const userCreations = await db.select()
        .from(creations)
        .where(eq(creations.userId, userId))
        .orderBy(desc(creations.createdAt))
        .limit(50);

      res.json({ success: true, creations: userCreations });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const cinemaController = new CinemaController();
