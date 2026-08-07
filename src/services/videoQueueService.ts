/**
 * Video Queue Service — database-backed job queue for video generation.
 * Completely sidesteps the "async after res.json()" problem by using
 * a polling worker that checks for pending video creations.
 */

import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';

// We import the pipeline function dynamically to avoid circular deps
let executeVideoPipeline: Function | null = null;

interface VideoJobPayload {
  creationId: string;
  prompt: string;
  platforms: string[];
  sourceImages: string[];
  resolvedUserId: string;
  brandContext: any;
}

let workerStarted = false;

/**
 * Insert a video job by updating the existing creation record.
 * The creation already exists with status='processing' and pipeline_trace='pending'.
 * We just mark it as queued so the worker picks it up.
 */
export async function insertVideoJob(payload: VideoJobPayload): Promise<void> {
  console.log(`[VideoQueue] Inserting job for creation=${payload.creationId}`);
  try {
    await db.update(schema.creations).set({
      metadata: {
        prompt: payload.prompt,
        platforms: payload.platforms,
        pipeline_trace: 'queued',
        sourceImages: payload.sourceImages,
      },
    }).where(eq(schema.creations.id, payload.creationId));
    console.log(`[VideoQueue] Job queued: ${payload.creationId}`);
  } catch (err: any) {
    console.error(`[VideoQueue] Failed to queue job: ${err.message}`);
  }
}

/**
 * Start the video queue worker. Polls every 5 seconds for jobs with
 * pipeline_trace='queued', picks the oldest one, and processes it.
 */
export function startVideoQueueWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  console.log('[VideoQueue] Worker started — polling every 5s');

  setInterval(async () => {
    try {
      // Find oldest queued job
      const [job] = await db.select({
        id: schema.creations.id,
        userId: schema.creations.userId,
        metadata: schema.creations.metadata,
      }).from(schema.creations)
        .where(and(
          eq(schema.creations.status, 'processing'),
          eq(schema.creations.type, 'enhanced_video'),
        ))
        .orderBy(schema.creations.createdAt)
        .limit(1);

      if (!job) return; // No jobs waiting

      const meta = job.metadata as any;
      if (meta?.pipeline_trace !== 'queued') return; // Not our job

      // Mark as in-progress so another worker doesn't pick it up
      await db.update(schema.creations).set({
        metadata: { ...meta, pipeline_trace: 'worker_processing' },
      }).where(eq(schema.creations.id, job.id));

      console.log(`[VideoQueue] Processing job: ${job.id}`);

      // Lazy-load the pipeline function
      if (!executeVideoPipeline) {
        const mod = await import('../routes/studioRoutes.js');
        // executeVideoPipeline is not exported from studioRoutes — it's internal.
        // We need a different approach.
      }

      // Since we can't import the function, inline the pipeline here
      // or use the soraVideoService directly.
      const { soraVideoService } = await import('./soraVideoService.js');
      const { ffmpegRenderService } = await import('./ffmpegRenderService.js');
      const { r2Storage } = await import('./r2StorageService.js');
      const fs = await import('fs');
      const { v4: uuidv4 } = await import('uuid');

      const creationId = job.id;
      const prompt = meta?.prompt || 'Generate a video';
      const platforms = meta?.platforms || ['tiktok'];
      const userId = job.userId;

      console.log(`[VideoQueue] Starting Sora for ${creationId}`);

      try {
        // Sora
        const soraResult = await soraVideoService.generateVideo(prompt, { userId });
        if (!soraResult.success || !soraResult.videoPath) {
          await db.update(schema.creations).set({
            status: 'failed',
            metadata: { ...meta, error: soraResult.error || 'Sora failed', pipeline_trace: 'sora_failed' },
          }).where(eq(schema.creations.id, creationId));
          return;
        }

        // Validate
        try {
          const stat = fs.statSync(soraResult.videoPath);
          if (stat.size < 1024) {
            await db.update(schema.creations).set({
              status: 'failed',
              metadata: { ...meta, error: 'Sora output too small', pipeline_trace: 'validation_failed' },
            }).where(eq(schema.creations.id, creationId));
            try { fs.unlinkSync(soraResult.videoPath); } catch {}
            return;
          }
        } catch {}

        // FFmpeg
        let videoUrl = soraResult.videoUrl || soraResult.videoPath;
        try {
          const renderResult = await ffmpegRenderService.render(soraResult.videoPath, {
            platforms,
            enableWatermark: !!meta?.brandContext?.name,
          });
          if (renderResult.success && renderResult.outputs.length > 0) {
            videoUrl = renderResult.outputs[0]?.videoUrl || videoUrl;
          }
        } catch (ffmpegErr: any) {
          console.warn(`[VideoQueue] FFmpeg failed: ${ffmpegErr.message}`);
        }

        // R2
        try {
          if (r2Storage.isAvailable) {
            const r2 = await r2Storage.uploadLocalFile(soraResult.videoPath, userId, 'cinema/sora', 'video/mp4');
            if (r2.url) videoUrl = r2.url;
          }
        } catch {}

        // Complete
        await db.update(schema.creations).set({
          status: 'completed',
          fileUrl: videoUrl,
          metadata: { ...meta, aiProvider: 'sora-2', pipeline_trace: 'completed' },
        }).where(eq(schema.creations.id, creationId));

        // Approval
        try {
          await db.insert(schema.approvals).values({
            id: uuidv4(),
            userId,
            type: 'video',
            status: 'completed',
            payload: { assetId: creationId, title: prompt.slice(0, 60), videoUrl, platforms, status: 'completed' },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } catch {}

        console.log(`[VideoQueue] Job completed: ${creationId}`);
      } catch (err: any) {
        console.error(`[VideoQueue] Job failed: ${creationId} — ${err.message}`);
        try {
          await db.update(schema.creations).set({
            status: 'failed',
            metadata: { ...meta, error: err.message, pipeline_trace: 'worker_failed' },
          }).where(eq(schema.creations.id, creationId));
        } catch {}
      }
    } catch (pollErr: any) {
      // Don't crash the worker on transient DB errors
      console.error(`[VideoQueue] Poll error: ${pollErr.message}`);
    }
  }, 5000);
}
