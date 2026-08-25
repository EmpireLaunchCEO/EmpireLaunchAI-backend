/**
 * Video Queue Service — database-backed job queue for video generation.
 * Completely sidesteps the "async after res.json()" problem by using
 * a polling worker that checks for pending video creations.
 */

import { db, schema } from '../db/index.js';
import { eq, and, lt } from 'drizzle-orm';
import type { SoraGenerationResult } from './soraVideoService.js';

// ── Sora retry policy ──────────────────────────────────────────────
// Sora's API intermittently returns status:failed ~55-90s into generation
// (~50% flake rate observed in production on 2026-08-12). We retry up to 2
// additional attempts with a short backoff before marking the creation
// failed. FFmpeg/R2 are NOT re-run on retry — only the Sora create/generate
// call is repeated. Policy per task #26627131 (2 retries, 10-15s backoff).
const SORA_MAX_ATTEMPTS = 3; // initial + 2 automatic retries
const SORA_RETRY_BACKOFF_MS = [0, 10_000, 15_000]; // backoff before attempt 1/2/3 (10s then 15s)

// A queue job is considered orphaned only after this much inactivity. Every
// worker state transition refreshes updatedAt, so an in-flight Sora request is
// not re-queued while it is still making progress.
const VIDEO_JOB_STALE_MS = 8 * 60 * 1000;
const VIDEO_QUEUE_RECOVERY_INTERVAL_MS = 60 * 1000;
const MAX_RECOVERY_BATCH = 25;

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

/**
 * Extract the R2 object key from a stored URL (signed, public, or custom domain).
 * Key format: brands/{userId}/{type}/{uuid}.{ext}
 */
function extractR2Key(storedUrl: string): string | null {
  try {
    const url = new URL(storedUrl);
    // Case 1: Custom public URL (R2_PUBLIC_URL) — key is the entire pathname minus leading /
    const r2PublicUrl = process.env.R2_PUBLIC_URL;
    if (r2PublicUrl && storedUrl.startsWith(r2PublicUrl)) {
      return url.pathname.replace(/^\//, '');
    }
    // Case 2: R2 endpoint URL — pathname is /{bucket}/{key}
    if (storedUrl.includes('r2.cloudflarestorage.com')) {
      const parts = url.pathname.split('/');
      // ['', '{bucket}', 'brands', ...] → skip bucket
      return parts.slice(2).join('/');
    }
    return null;
  } catch {
    return null;
  }
}

let workerStarted = false;
let recoveryInFlight = false;

type CreationMetadata = Record<string, any>;

function normalizeMetadata(value: unknown): CreationMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as CreationMetadata;
}

/**
 * Re-queue jobs orphaned by a process restart/deploy. The updatedAt predicate
 * is part of the UPDATE, not just the initial SELECT, so a worker that touched
 * the row while the sweep was running wins and is never double-processed.
 */
async function recoverStaleVideoJobs(): Promise<void> {
  if (recoveryInFlight) return;
  recoveryInFlight = true;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - VIDEO_JOB_STALE_MS);

  try {
    const staleJobs = await db.select({
      id: schema.creations.id,
      metadata: schema.creations.metadata,
      updatedAt: schema.creations.updatedAt,
    }).from(schema.creations)
      .where(and(
        eq(schema.creations.status, 'processing'),
        eq(schema.creations.type, 'enhanced_video'),
        lt(schema.creations.updatedAt, staleBefore),
      ))
      .orderBy(schema.creations.updatedAt)
      .limit(MAX_RECOVERY_BATCH);

    for (const job of staleJobs) {
      const metadata = normalizeMetadata(job.metadata);
      const previousTrace = typeof metadata.pipeline_trace === 'string'
        ? metadata.pipeline_trace
        : 'unknown';

      // Queued rows are already eligible for the normal poller; only recover
      // rows that had advanced into an in-flight state before the restart.
      if (previousTrace === 'queued') continue;

      const recoveryCount = Number(metadata.recoveryCount || 0) + 1;
      await db.update(schema.creations).set({
        metadata: {
          ...metadata,
          pipeline_trace: 'queued',
          recoveryCount,
          recoveredFrom: previousTrace,
          recoveredAt: now.toISOString(),
        },
        updatedAt: now,
      }).where(and(
        eq(schema.creations.id, job.id),
        eq(schema.creations.status, 'processing'),
        eq(schema.creations.type, 'enhanced_video'),
        lt(schema.creations.updatedAt, staleBefore),
      ));

      console.warn(`[VideoQueue] Re-queued stale job ${job.id} (trace=${previousTrace}, recovery=${recoveryCount})`);
    }
  } catch (err: any) {
    console.error(`[VideoQueue] Recovery sweep failed: ${err.message}`);
  } finally {
    recoveryInFlight = false;
  }
}

/**
 * Insert a video job by updating the existing creation record.
 * The creation already exists with status='processing' and pipeline_trace='pending'.
 * We just mark it as queued so the worker picks it up, preserving metadata
 * (notably duration and voiceover) persisted by the route before this call.
 */
export async function insertVideoJob(payload: VideoJobPayload): Promise<void> {
  console.log(`[VideoQueue] Inserting job for creation=${payload.creationId}`);
  try {
    const [existing] = await db.select({ metadata: schema.creations.metadata })
      .from(schema.creations)
      .where(eq(schema.creations.id, payload.creationId))
      .limit(1);
    const existingMetadata = normalizeMetadata(existing?.metadata);

    await db.update(schema.creations).set({
      metadata: {
        ...existingMetadata,
        prompt: payload.prompt,
        platforms: payload.platforms,
        pipeline_trace: 'queued',
        sourceImages: payload.sourceImages,
      },
      updatedAt: new Date(),
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

  // Recover rows orphaned by a previous process before the first poll, then
  // repeat periodically for deploys/restarts that happen during processing.
  void recoverStaleVideoJobs();
  let lastRecoveryAt = 0;

  setInterval(async () => {
    try {
      if (Date.now() - lastRecoveryAt >= VIDEO_QUEUE_RECOVERY_INTERVAL_MS) {
        lastRecoveryAt = Date.now();
        await recoverStaleVideoJobs();
      }
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
        metadata: { ...normalizeMetadata(meta), pipeline_trace: 'worker_processing' },
        updatedAt: new Date(),
      }).where(and(
        eq(schema.creations.id, job.id),
        eq(schema.creations.status, 'processing'),
      ));

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
      const duration = typeof meta?.duration === 'number' ? meta.duration : undefined;
      const voiceoverRaw = (meta?.voiceover || meta?.voiceoverConfig || {}) as {
        voice?: 'female' | 'male';
        gender?: 'female' | 'male';
        tone?: 'enthusiastic' | 'calm' | 'serious' | 'warm' | 'auto';
      } | undefined;
      const voiceover = voiceoverRaw && (voiceoverRaw.voice || voiceoverRaw.gender || voiceoverRaw.tone)
        ? { gender: (voiceoverRaw.voice || voiceoverRaw.gender) as 'female' | 'male' | undefined, tone: voiceoverRaw.tone }
        : undefined;
      const userId = job.userId;

      console.log(`[VideoQueue] Starting Sora for ${creationId}`);

      try {
        // ── Sora (with automatic retry on upstream flake) ──────────────
        // Sora's API intermittently returns status:failed ~55-90s into
        // generation. Retry up to 2 additional attempts with a short
        // backoff before marking the creation failed. FFmpeg/R2 below run
        // only once, after a successful Sora result — retries never re-run them.
        let soraResult: SoraGenerationResult | null = null;
        let retriesUsed = 0;

        for (let attempt = 1; attempt <= SORA_MAX_ATTEMPTS; attempt++) {
          if (attempt > 1) {
            retriesUsed = attempt - 1;
            const backoffMs = SORA_RETRY_BACKOFF_MS[attempt - 1]; // 10s then 15s
            console.log(`[VideoQueue] Sora attempt ${attempt}/${SORA_MAX_ATTEMPTS} starting after ${backoffMs}ms backoff (creation=${creationId})`);
            await db.update(schema.creations).set({
              metadata: { ...normalizeMetadata(meta), pipeline_trace: `sora_retry_${retriesUsed}`, retryCount: retriesUsed },
              updatedAt: new Date(),
            }).where(eq(schema.creations.id, creationId));
            await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
          }

          soraResult = await soraVideoService.generateVideo(prompt, { userId, duration });
          if (soraResult.success && soraResult.videoPath) break;
          console.warn(`[VideoQueue] Sora attempt ${attempt}/${SORA_MAX_ATTEMPTS} failed: ${soraResult.error || 'no video path'} (creation=${creationId})`);
        }

        if (!soraResult?.success || !soraResult.videoPath) {
          await db.update(schema.creations).set({
            status: 'failed',
            metadata: {
              ...normalizeMetadata(meta),
              error: soraResult?.error || 'Sora failed',
              pipeline_trace: 'sora_failed',
              retryCount: retriesUsed,
            },
            updatedAt: new Date(),
          }).where(eq(schema.creations.id, creationId));
          return;
        }

        // Validate
        try {
          const stat = fs.statSync(soraResult.videoPath);
          if (stat.size < 1024) {
            await db.update(schema.creations).set({
              status: 'failed',
              metadata: { ...normalizeMetadata(meta), error: 'Sora output too small', pipeline_trace: 'validation_failed' },
              updatedAt: new Date(),
            }).where(eq(schema.creations.id, creationId));
            try { fs.unlinkSync(soraResult.videoPath); } catch {}
            return;
          }
        } catch {}

        // FFmpeg — never clobber an existing remote URL with a relative/local path
        let videoUrl = soraResult.videoUrl || soraResult.videoPath;
        try {
          const renderResult = await ffmpegRenderService.render(soraResult.videoPath, {
            platforms,
            enableWatermark: !!meta?.brandContext?.name,
          });
          if (renderResult.success && renderResult.outputs.length > 0 && !/^https?:\/\//.test(videoUrl)) {
            videoUrl = renderResult.outputs[0]?.videoUrl || videoUrl;
          }
        } catch (ffmpegErr: any) {
          console.warn(`[VideoQueue] FFmpeg failed: ${ffmpegErr.message}`);
        }

        // Voiceover (gpt-audio) — if the user selected a voice, generate narration
        // of the prompt and mux it onto the video so the delivered file has audio.
        // Uses the same verified chat/completions + mp3 path as scene narration.
        let voiceoverPath: string | undefined;
        if (voiceover && (voiceover.gender || voiceover.tone)) {
          try {
            const { resolveVoice } = await import('./voiceOptions.js');
            const { execFile } = await import('child_process');
            const key = process.env.OPENAI_API_KEY;
            if (key) {
              const vr = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'gpt-audio', modalities: ['text','audio'], audio: { voice: resolveVoice(voiceover.gender, voiceover.tone), format: 'mp3' }, messages: [{ role: 'user', content: prompt }] }),
                signal: AbortSignal.timeout(90000),
              });
              if (vr.ok) {
                const j = await vr.json();
                const aud = j?.choices?.[0]?.message?.audio;
                if (aud?.data) {
                  const inputVideoPath = soraResult.videoPath;
                  if (!inputVideoPath) throw new Error('Sora returned no video path for voiceover');
                  const audioFile = `${inputVideoPath}.voice.mp3`;
                  const fsMod = await import('fs');
                  fsMod.writeFileSync(audioFile, Buffer.from(aud.data as string, 'base64'));
                  const muxed = `${inputVideoPath}.voiced.mp4`;
                  await new Promise<void>((resolve, reject) => {
                    execFile('ffmpeg', ['-y', '-i', inputVideoPath, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxed], (err: Error | null) => err ? reject(err) : resolve());
                  });
                  if (fsMod.existsSync(muxed)) { soraResult.videoPath = muxed; voiceoverPath = audioFile; fsMod.unlinkSync(audioFile); videoUrl = soraResult.videoPath; }
                }
              }
            }
          } catch (voErr: any) {
            console.warn(`[VideoQueue] Voiceover failed: ${voErr.message}`);
          }
        }
        // R2 — only upload if we don't already have a remote URL and the file still exists.
        // soraResult.videoUrl is already an R2 signed URL when R2 is configured —
        // never clobber it with a dead local-path fallback.
        let r2Key: string | undefined;
        try {
          if (r2Storage.isAvailable && !/^https?:\/\//.test(videoUrl) && fs.existsSync(soraResult.videoPath)) {
            const r2 = await r2Storage.uploadLocalFile(soraResult.videoPath, userId, 'cinema/sora', 'video/mp4');
            if (r2.url && /^https?:\/\//.test(r2.url)) videoUrl = r2.url;
            if (r2.r2Key) r2Key = r2.r2Key;
          }
        } catch {}

        // If we kept the existing R2 URL (upload skipped), derive the key from it for metadata
        if (!r2Key && soraResult.videoUrl && /^https?:\/\//.test(soraResult.videoUrl)) {
          r2Key = extractR2Key(soraResult.videoUrl) ?? undefined;
        }

        // Complete
        await db.update(schema.creations).set({
          status: 'completed',
          fileUrl: videoUrl,
          metadata: {
            ...normalizeMetadata(meta),
            aiProvider: 'sora-2',
            pipeline_trace: 'completed',
            ...(retriesUsed > 0 ? { soraRetries: retriesUsed } : {}),
            ...(r2Key ? { r2Key } : {}),
          },
          updatedAt: new Date(),
        }).where(eq(schema.creations.id, creationId));

        // Approval (master = draft in Operations; NOT auto-saved to Library)
        try {
          await db.insert(schema.approvals).values({
            id: uuidv4(),
            userId,
            type: 'video',
            status: 'completed',
            payload: { assetId: creationId, title: prompt.slice(0, 60), videoUrl, platforms, status: 'completed', mode: 'single-shot', saved: false },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } catch {}

        // ── Export variants (16:9, 1:1, 2:3): pure FFmpeg contain/pad refits
        //    from the assembled master — no AI calls, no crop. Each becomes its
        //    own draft approval row (Operations), never auto-saved to Library.
        if (soraResult.videoPath && fs.existsSync(soraResult.videoPath)) {
          try {
            const { generateVideoExportVariants } = await import('./videoExportVariants.js');
            const variants = await generateVideoExportVariants(soraResult.videoPath, userId, 'video-projects');
            for (const v of variants) {
              try {
                await db.insert(schema.approvals).values({
                  id: uuidv4(),
                  userId,
                  type: 'video',
                  status: 'completed',
                  payload: {
                    assetId: uuidv4(),
                    title: `${prompt.slice(0, 50)} (${v.variant.aspectRatio})`,
                    videoUrl: v.fileUrl,
                    r2Key: v.r2Key,
                    platforms,
                    status: 'completed',
                    aspectRatio: v.variant.aspectRatio,
                    ratioLabel: v.variant.label,
                    shape: v.variant.shape,
                    mode: 'single-shot',
                    saved: false,
                  },
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });
              } catch {}
            }
            console.log(`[VideoQueue] Export variants published: ${variants.length} for ${creationId}`);
          } catch (varErr: any) {
            console.warn(`[VideoQueue] Export variants failed: ${varErr.message}`);
          }
        }

        console.log(`[VideoQueue] Job completed: ${creationId}`);
      } catch (err: any) {
        console.error(`[VideoQueue] Job failed: ${creationId} — ${err.message}`);
        try {
          await db.update(schema.creations).set({
            status: 'failed',
            metadata: { ...normalizeMetadata(meta), error: err.message, pipeline_trace: 'worker_failed' },
            updatedAt: new Date(),
          }).where(eq(schema.creations.id, creationId));
        } catch {}
      }
    } catch (pollErr: any) {
      // Don't crash the worker on transient DB errors
      console.error(`[VideoQueue] Poll error: ${pollErr.message}`);
    }
  }, 5000);
}
