import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import { cinemaEngineService } from '../services/cinemaEngineService.js';
import { VIDEO_MOODS, isValidMood } from '../services/voiceOptions.js';
import { usageService } from '../services/usageService.js';
import { creationEngine } from '../services/creationEngine.js';
import { neuralActionEngine } from '../services/neuralActionEngine.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

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
  const allowedPhoto = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
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

/**
 * Resolve the acting user id for unauthenticated cinema flows. These routes
 * are intentionally fail-open (the Studio boxes call them before auth), so we
 * pull the real user from the transport the frontend actually sends: the
 * `x-user-id` header, or body/query `userId`. Without it we'd always persist
 * Neural Twin / enhanced creations under the sentinel `system`/`anonymous`,
 * which never surfaces on the Operations page.
 */
function resolveUserId(req: Request): string {
  const fromAuth = (req as any).user?.id;
  const fromBody = (req as any).body?.userId;
  const fromQuery = (req as any).query?.userId as string | undefined;
  const fromHeader = (req as any).headers?.['x-user-id'] as string | undefined;
  const uid = fromAuth || fromBody || fromQuery || fromHeader || '';
  const sentinels = /^(system|anonymous|)$/i;
  return sentinels.test(String(uid).trim()) ? '' : String(uid).trim();
}
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
      const userId = resolveUserId(req) || 'anonymous';

      // Save to creations table so it shows up in Operations page
      await db.insert(schema.creations).values({
        id: uuidv4(),
        userId,
        type: 'facial_dna',
        title: `Photo - ${path.basename(storedPath)}`,
        status: 'completed',
        fileUrl: storedPath,
        metadata: { fileSize: (req as any).file?.size, originalName: (req as any).file?.originalname },
      }).onConflictDoNothing();

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
      const userId = resolveUserId(req) || 'anonymous';

      // Save to creations table so it shows up in Operations page
      await db.insert(schema.creations).values({
        id: uuidv4(),
        userId,
        type: 'raw_video',
        title: `Video - ${path.basename(storedPath)}`,
        status: 'completed',
        fileUrl: storedPath,
        metadata: { fileSize: (req as any).file?.size, originalName: (req as any).file?.originalname },
      }).onConflictDoNothing();

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
      const { photoPath, script, voiceStyle, mood } = req.body;
      const userId = resolveUserId(req) || 'system';

      if (!photoPath && !req.body.photoUrl) {
        res.status(400).json({ error: 'photoPath or photoUrl and script are required' });
        return;
      }
      // Owner-locked mood (shared with Faceless/Scene-Based). Validate; 'auto'/empty -> undefined.
      let moodVal: string | undefined;
      if (mood !== undefined && mood !== null && String(mood).trim() !== '' && String(mood).toLowerCase() !== 'auto') {
        const m = String(mood).toLowerCase();
        if (!isValidMood(m)) {
          res.status(400).json({ error: `Invalid mood "${mood}". Allowed: ${VIDEO_MOODS.join(', ')}` });
          return;
        }
        moodVal = m;
      }

      // Neural Twin requested duration (seconds). Frontend sends 15/30/'' (default '15').
      // Validate to 15 or 30; empty/absent keeps current default behavior.
      let durationVal: number | undefined;
      const rawDuration = req.body.duration;
      if (rawDuration !== undefined && rawDuration !== null && String(rawDuration).trim() !== '' && String(rawDuration).toLowerCase() !== 'auto') {
        const d = Number(rawDuration);
        if (!Number.isFinite(d) || (d !== 15 && d !== 30)) {
          res.status(400).json({ error: `Invalid Neural Twin duration "${rawDuration}". Allowed: 15 or 30 seconds` });
          return;
        }
        durationVal = d;
      }

      const result = await cinemaEngineService.createNeuralTwin({
        userId,
        photoPath,
        photoUrl: req.body.photoUrl,
        script,
        voiceStyle,
        mood: moodVal,
        duration: durationVal,
      });

      // Save to creations table so it shows up in Operations page
      if (result.status === 'completed' && result.videoUrl) {
        await db.insert(schema.creations).values({
          id: uuidv4(),
          userId,
          type: 'neural_twin',
          title: `Neural Twin - ${path.basename(result.videoUrl || '')}`,
          status: 'completed',
          fileUrl: result.videoUrl,
          metadata: { photoPath, voiceStyle, script: script?.slice(0, 100) },
        }).onConflictDoNothing();

        // Owner auto-save change: also deliver the twin + its export variants as
        // OPERATIONS DRAFTS (draft approval rows, saved:false) so the client can
        // preview/download each and Save (POST /api/approval/save-to-library) to
        // move it into the Library with 90-day expiry from save time. Never auto-
        // saved to Library.
        try {
          // Master draft
          await db.insert(schema.approvals).values({
            id: uuidv4(),
            userId,
            type: 'video',
            status: 'completed',
            payload: {
              assetId: uuidv4(),
              title: `Neural Twin - ${path.basename(result.videoUrl || '')}`,
              videoUrl: result.videoUrl,
              platforms: [],
              status: 'completed',
              mode: 'twin',
              saved: false,
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          // Variant drafts
          for (const v of (result.variants || [])) {
            await db.insert(schema.approvals).values({
              id: uuidv4(),
              userId,
              type: 'video',
              status: 'completed',
              payload: {
                assetId: uuidv4(),
                title: `Neural Twin (${v.variant.aspectRatio})`,
                videoUrl: v.fileUrl,
                r2Key: v.r2Key,
                platforms: [],
                status: 'completed',
                aspectRatio: v.variant.aspectRatio,
                ratioLabel: v.variant.label,
                shape: v.variant.shape,
                mode: 'twin',
                saved: false,
              },
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        } catch (draftErr: any) {
          console.warn('[Cinema] Twin draft approvals failed:', draftErr?.message);
        }
      }

      res.json({
        success: result.status === 'completed',
        asset: result,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/cinema/enhance-video
   * Apply AI Empire Style enhancement to an uploaded video.
   */
  async enhanceVideo(req: Request, res: Response): Promise<void> {
    try {
      const { videoPath } = req.body;
      const userId = resolveUserId(req) || 'system';

      if (!videoPath) {
        res.status(400).json({ error: 'videoPath is required' });
        return;
      }

      const result = await cinemaEngineService.enhanceRawVideo(userId, videoPath);

      // Save to creations table so it shows up in Operations page
      if (result.status === 'completed' && result.videoUrl) {
        await db.insert(schema.creations).values({
          id: uuidv4(),
          userId,
          type: 'enhanced_video',
          title: `Enhanced - ${path.basename(result.videoUrl || videoPath)}`,
          status: 'completed',
          fileUrl: result.videoUrl,
          metadata: { sourceVideo: videoPath },
        }).onConflictDoNothing();
      }

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
      const userId = resolveUserId(req) || 'anonymous';
      const neuralRemaining = await usageService.getDailyRemaining(userId, 'neural_twin');
      const enhancedRemaining = await usageService.getDailyRemaining(userId, 'enhanced_video');
      const designRemaining = await usageService.getDailyRemaining(userId, 'high_res_design');
      const customizeRemaining = await usageService.getDailyRemaining(userId, 'customize_video');
      const facelessRemaining = await usageService.getDailyRemaining(userId, 'faceless');

      res.json({
        userId,
        neural: {
          remaining: neuralRemaining,
          limit: 7,
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
          limit: 7,
          period: 'week',
        },
        faceless: {
          remaining: facelessRemaining,
          limit: 7,
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
   * POST /api/cinema/generate-video
   * Generate a video from a text idea using the creation pipeline.
   */
  async generateVideo(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const { niche, angle, platforms } = req.body;
      if (!niche || !angle) {
        res.status(400).json({ error: 'niche and angle are required' });
        return;
      }
      
      // Delegate to the creation engine pipeline
      const result = await creationEngine.generateMasterAsset({
        userId,
        campaignId: uuidv4(),
        niche,
        productName: angle,
        platforms: platforms || ['tiktok'],
        archetype: 'creator',
      });
      
      // Save to creations table so it shows up in Operations page
      if (result.masterAssetUrl) {
        await db.insert(schema.creations).values({
          id: uuidv4(),
          userId,
          type: 'enhanced_video',
          title: `${niche} - ${angle}`,
          status: 'completed',
          fileUrl: result.masterAssetUrl,
          metadata: { niche, angle, platforms: platforms || ['tiktok'] },
        }).onConflictDoNothing();
      }
      
      res.json({
        message: 'Video generated successfully',
        status: 'completed',
        videoUrl: result.masterAssetUrl,
        assetId: uuidv4(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/cinema/creations
   * Get user's video creations for Operations Base display.
   */
  async getCreations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id || (req.query.userId as string);
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      
      const userCreations = await db.select()
        .from(schema.creations)
        .where(eq(schema.creations.userId, userId))
        .orderBy(schema.creations.createdAt)
        .limit(50);
      
      res.json({ creations: userCreations });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/cinema/post-tiktok
   * Post a video to TikTok via Neural Action Engine.
   */
  async postToTikTok(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

      const file = (req as any).file;
      if (!file) { res.status(400).json({ error: 'No video file provided' }); return; }

      const { caption, hashtags, music } = req.body;

      const result = await neuralActionEngine.postToTikTok(
        userId,
        file.path,
        caption || 'Check this out!',
        music ? { searchTerm: music, startTime: 0, duration: 15 } : undefined,
        hashtags ? hashtags.split(',').map((h: string) => h.trim()) : undefined
      );

      if (result) {
        res.json({ status: 'success', message: 'Video posted to TikTok' });
      } else {
        res.status(500).json({ error: 'Failed to post to TikTok' });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/cinema/post-instagram-reel
   * Post a video to Instagram Reels via Neural Action Engine.
   */
  async postToInstagramReel(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

      const file = (req as any).file;
      if (!file) { res.status(400).json({ error: 'No video file provided' }); return; }

      const { caption, hashtags, music } = req.body;

      const result = await neuralActionEngine.postToInstagramReel(
        userId,
        file.path,
        caption || 'Check this out!',
        undefined,
        music ? { searchTerm: music } : null,
        hashtags ? hashtags.split(',').map((h: string) => h.trim()) : undefined
      );

      if (result) {
        res.json({ status: 'success', message: 'Reel posted to Instagram' });
      } else {
        res.status(500).json({ error: 'Failed to post to Instagram' });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const cinemaController = new CinemaController();
