import { Router, Request, Response } from 'express';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { aiRouter, RouterDecision } from '../services/aiRouter.js';
import { soraVideoService } from '../services/soraVideoService.js';
import { ffmpegRenderService } from '../services/ffmpegRenderService.js';
import { renderingEngine } from '../services/renderingEngine.js';
import { db, schema } from '../db/index.js';
import { eq, and, gte, count, desc } from 'drizzle-orm';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { r2Storage } from '../services/r2StorageService.js';

const router = Router();

// Keep rejected fire-and-forget pipeline promises visible in Railway logs. This
// is installed once at module load (rather than once per request) to avoid
// accumulating process listeners under load.
process.on('unhandledRejection', (reason: unknown) => {
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
  process.stderr.write(`[PIPELINE_UNHANDLED_REJECTION] ${detail}\n`);
});

// ─── Types ──────────────────────────────────────────────────────────────────

interface StudioRequest {
  userId?: string;
  brandId?: string;
  mode?: 'consult' | 'generate';            // 'consult' = chat-only, no generation
  request: string;
  attachments?: string[];
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface StudioResponse {
  status: 'completed' | 'needs_refinement' | 'ai_response' | 'error' | 'processing';
  mode?: 'consult' | 'generate';
  classification?: string;
  response?: string;                         // Natural language for user
  creationId?: string;                       // For async video tracking
  metadata?: any;                            // Pipeline trace + provider tags
  assets?: Array<{
    type: 'image' | 'video';
    url: string;
    thumbnailUrl?: string;
    platform?: string;
  }>;
  error?: string;
}

// ─── POST /api/studio/process ────────────────────────────────────────────────

// Reusable helper: resolve non-UUID user identifiers to real UUIDs
// (needed for FK inserts in creations, approvals, etc.)
const resolveUserId = async (raw: string): Promise<string | null> => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(raw)) {
    // It's a valid UUID — check if user exists, auto-create if not
    try {
      const [existing] = await db.select({ id: schema.users.id })
        .from(schema.users).where(eq(schema.users.id, raw)).limit(1);
      if (existing) return existing.id;

      // Auto-create minimal user record (frontend generates UUIDs via crypto.randomUUID)
      // email is .notNull().unique() per schema — use synthetic to satisfy both constraints
      await db.insert(schema.users).values({
        id: raw,
        email: `${raw.slice(0, 8)}@empirelaunch.ai`,
        accessKey: null,
      }).onConflictDoNothing();

      // Re-read to handle race: another request may have created between our SELECT and INSERT
      const [created] = await db.select({ id: schema.users.id })
        .from(schema.users).where(eq(schema.users.id, raw)).limit(1);
      return created?.id ?? null;
    } catch (err) {
      console.warn('[StudioRoute] resolveUserId failed to verify/create user:', (err as Error).message);
      return null;
    }
  }

  // Try lookup by accessKey
  try {
    const [byKey] = await db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.accessKey, raw)).limit(1);
    if (byKey) return byKey.id;
  } catch {}

  // Try email: raw@empirelaunch.ai
  try {
    const [byEmail] = await db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.email, `${raw}@empirelaunch.ai`)).limit(1);
    if (byEmail) return byEmail.id;
  } catch {}

  return null;
};

// ─── Background Video Pipeline (called via setImmediate) ──────────────────

interface VideoPipelinePayload {
  creationId: string;
  prompt: string;
  platforms: string[];
  sourceImages: string[];
  resolvedUserId: string;
  brandContext: any;
}

async function executeVideoPipeline(payload: VideoPipelinePayload): Promise<void> {
  const { creationId, prompt, platforms, sourceImages, resolvedUserId, brandContext } = payload;

  process.stderr.write(`[PIPELINE_V2] pipeline_fn_entered creation=${creationId}\n`);

  // Railway-safe failsafe: short interval checks instead of long timers.
  let safetyElapsed = 0;
  const safetyInterval = setInterval(async () => {
    safetyElapsed += 5000;
    process.stderr.write(`[PIPELINE_V2] safety_check creation=${creationId} elapsed_ms=${safetyElapsed}\n`);
    if (safetyElapsed < 300000) return;
    clearInterval(safetyInterval);
    try {
      const [current] = await db.select({ status: schema.creations.status, metadata: schema.creations.metadata })
        .from(schema.creations).where(eq(schema.creations.id, creationId)).limit(1);
      if (current?.status === 'processing') await db.update(schema.creations).set({ status: 'failed', metadata: { ...(current.metadata as any || {}), error: 'Pipeline timed out after 5 minutes' } }).where(eq(schema.creations.id, creationId));
    } catch (err: any) { process.stderr.write(`[PIPELINE_V2] safety_failure creation=${creationId} error=${err.message}\n`); }
  }, 5000);

  try {
    // Trace: started
    try {
      await db.update(schema.creations).set({
        metadata: { prompt, platforms, pipeline_trace: 'pipeline_started', pipeline_started_at: new Date().toISOString() },
      }).where(eq(schema.creations.id, creationId));
      process.stderr.write(`[PIPELINE_V2] trace=started creation=${creationId}\n`);
    } catch (traceErr: unknown) {
      const detail = traceErr instanceof Error ? traceErr.message : String(traceErr);
      process.stderr.write(`[PIPELINE_V2] trace_start_failed creation=${creationId}: ${detail}\n`);
    }

    // Trace: calling Sora
    try {
      await db.update(schema.creations).set({
        metadata: { prompt, platforms, pipeline_trace: 'sora_calling' },
      }).where(eq(schema.creations.id, creationId));
      process.stderr.write(`[PIPELINE_V2] trace=sora_calling creation=${creationId}\n`);
    } catch {}

    process.stderr.write(`[PIPELINE_V2] sora_call_start creation=${creationId}\n`);
    const soraResult = await soraVideoService.generateVideo(prompt, { userId: resolvedUserId });
    process.stderr.write(`[PIPELINE_V2] sora_call_end creation=${creationId} success=${soraResult.success}\n`);

    if (!soraResult.success || !soraResult.videoPath) {
      await db.update(schema.creations)
        .set({
          status: 'failed',
          metadata: { prompt, platforms, error: soraResult.error || 'Sora returned no video' },
        })
        .where(eq(schema.creations.id, creationId));
      return;
    }

    // Validate video file
    try {
      const stat = fs.statSync(soraResult.videoPath);
      if (stat.size < 1024) {
        await db.update(schema.creations)
          .set({
            status: 'failed',
            metadata: { prompt, platforms, error: `Sora output too small (${stat.size} bytes)` },
          })
          .where(eq(schema.creations.id, creationId));
        try { fs.unlinkSync(soraResult.videoPath); } catch {}
        return;
      }
    } catch {}

    // FFmpeg render
    let videoUrl = soraResult.videoUrl || soraResult.videoPath;
    try {
      process.stderr.write(`[PIPELINE_V2] ffmpeg_start creation=${creationId}\n`);
      const renderResult = await ffmpegRenderService.render(soraResult.videoPath, {
        platforms,
        enableWatermark: !!brandContext?.name,
      });
      process.stderr.write(`[PIPELINE_V2] ffmpeg_end creation=${creationId} success=${renderResult.success}\n`);
      if (renderResult.success && renderResult.outputs.length > 0) {
        videoUrl = renderResult.outputs[0]?.videoUrl || videoUrl;
      }
    } catch (ffmpegErr: any) {
      process.stderr.write(`[PIPELINE_V2] ffmpeg_failed creation=${creationId}: ${ffmpegErr.message}\n`);
    }

    // R2 upload
    try {
      if (r2Storage.isAvailable) {
        process.stderr.write(`[PIPELINE_V2] r2_upload_start creation=${creationId}\n`);
        const r2 = await r2Storage.uploadLocalFile(soraResult.videoPath, resolvedUserId, 'cinema/sora', 'video/mp4');
        if (r2.url) videoUrl = r2.url;
        process.stderr.write(`[PIPELINE_V2] r2_upload_end creation=${creationId} url_present=${!!r2.url}\n`);
      }
    } catch {}

    // Mark completed
    process.stderr.write(`[PIPELINE_V2] db_completed_start creation=${creationId}\n`);
    await db.update(schema.creations)
      .set({
        status: 'completed',
        fileUrl: videoUrl,
        metadata: {
          prompt,
          platforms,
          aiProvider: 'sora-2',
          sourceImages,
          pipeline_trace: 'completed',
        },
      })
      .where(eq(schema.creations.id, creationId));

    // Create approval
    try {
      await db.insert(schema.approvals).values({
        id: uuidv4(),
        userId: resolvedUserId,
        type: 'video',
        status: 'completed',
        payload: { assetId: creationId, title: prompt.slice(0, 60), videoUrl, platforms, status: 'completed' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch {}

    process.stderr.write(`[PIPELINE_V2] pipeline_complete creation=${creationId}\n`);
  } catch (bgErr: any) {
    process.stderr.write(`[PIPELINE_V2] pipeline_failed creation=${creationId}: ${bgErr.message}\n`);
    try {
      await db.update(schema.creations)
        .set({
          status: 'failed',
          metadata: { prompt, platforms, error: bgErr.message, pipeline_trace: 'failed' },
        })
        .where(eq(schema.creations.id, creationId));
    } catch {}
  } finally {
    clearInterval(safetyInterval);
  }
}

router.post('/process', async (req: Request, res: Response) => {
  try {
    const { userId, brandId, request, attachments, conversationHistory } = req.body as StudioRequest;
    const mode: 'consult' | 'generate' = (req.body as StudioRequest).mode || 'generate';

    if (!request || typeof request !== 'string') {
      return res.status(400).json({ status: 'error', error: 'request is required' });
    }

    const uid = userId || (req as any).userId || 'system';

    // 1. Fetch brand context if brandId provided
    let brandContext: any = undefined;
    if (brandId) {
      try {
        const [brand] = await db.select()
          .from(schema.goals)
          .where(eq(schema.goals.id, brandId))
          .limit(1);
        if (brand) {
          brandContext = {
            name: brand.title,
            niche: brand.description?.match(/Empire Niche:\s*(.*?)(?:\.|$)/)?.[1] || '',
            archetype: brand.archetype,
          };
        }
      } catch {}
    }

    // 2. Route via AI Router
    const decision = await aiRouter.route({
      userId: uid,
      request,
      mode,
      brandContext,
      conversationHistory,
    });

    console.log(`[StudioRoute] Routed: ${decision.classification} ${decision.needsRefinement ? '(needs refinement)' : ''}`);

    // Consult mode — chat only, never trigger generation pipeline
    if (mode === 'consult') {
      const genTypes = ['video_creation', 'image_creation', 'video_editing', 'image_editing', 'final_rendering'];
      if (genTypes.includes(decision.classification)) {
        decision.classification = 'ai_assistant';
      }
      // needs_refinement and ai_assistant pass through normally below
    }

    // 3. Handle each classification
    if (decision.needsRefinement) {
      return res.json({
        status: 'needs_refinement',
        classification: decision.classification,
        response: decision.response || "Let me understand better — what specifically would you like to create?",
      } as StudioResponse);
    }

    if (decision.classification === 'ai_assistant') {
      return res.json({
        status: 'ai_response',
        classification: 'ai_assistant',
        response: decision.response || 'How can I help with your creative project?',
      } as StudioResponse);
    }

    // 4. Execute based on classification
    let assets: StudioResponse['assets'] = [];

    switch (decision.classification) {
      case 'image_creation':
      case 'image_editing': {
        try {
          const imageResult = await renderingEngine.renderImage(decision.prompt, uid);

          if (!imageResult.success) {
            return res.status(500).json({
              status: 'error',
              classification: decision.classification,
              response: `Image generation failed: ${imageResult.error || 'Unknown error'}`,
            } as StudioResponse);
          }

          if (imageResult.imageUrl) {
            const imgUrl = imageResult.imageUrl;
            const aiProvider = 'GPT Image 2';
            const assetType = decision.classification === 'image_editing' ? 'edit' : 'design';
            assets.push({ type: 'image', url: imgUrl });

            // Store in creations table with AI provider tag
            const creationId = uuidv4();
            try {
              await db.insert(schema.creations).values({
                id: creationId, userId: uid, type: 'design',
                title: decision.prompt.slice(0, 60), status: 'completed',
                fileUrl: imgUrl,
                metadata: { classification: decision.classification, prompt: decision.prompt, aiProvider },
              });
            } catch (creationErr: any) {
              console.warn('[StudioRoute] Failed to insert creation record:', creationErr.message);
            }

            // Create approval for Operations page
            try {
              await db.insert(schema.approvals).values({
                id: uuidv4(),
                userId: uid,
                type: assetType,
                status: 'pending',
                payload: { assetId: creationId, title: decision.prompt.slice(0, 60), imageUrl: imgUrl, status: 'pending' },
                createdAt: new Date(),
                updatedAt: new Date(),
              });
            } catch (approvalErr: any) {
              console.warn('[StudioRoute] Failed to insert approval record:', approvalErr.message);
            }
          }
        } catch (imgErr: any) {
          console.error('[StudioRoute] Image generation failed:', imgErr.message);
          return res.status(500).json({
            status: 'error',
            classification: decision.classification,
            response: `Image generation failed: ${imgErr.message}`,
          } as StudioResponse);
        }
        break;
      }

      case 'video_creation': {
        // Resolve userId to a valid UUID — creation FK requires it
        const resolvedUserId = await resolveUserId(uid);
        if (!resolvedUserId) {
          return res.status(400).json({
            status: 'error',
            error: `Cannot create video: user "${uid}" not found. Please log in again.`,
          } as StudioResponse);
        }

        // Quota check — rolling 7-day window, no subscription table needed
        let videoCount = 0;
        try {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const [countResult] = await db.select({ count: count() })
            .from(schema.creations)
            .where(and(
              eq(schema.creations.userId, resolvedUserId),
              eq(schema.creations.type, 'video_creation'),
              gte(schema.creations.createdAt, sevenDaysAgo)
            ));
          videoCount = Number(countResult?.count ?? 0);
        } catch (quotaErr: any) {
          console.warn('[StudioRoute] Quota check failed, allowing video creation:', quotaErr.message);
        }
        if (Number(videoCount) >= 7) {
          return res.status(429).json({
            status: 'error',
            error: 'You\'ve used 7/7 videos this week. Try again later when a slot frees up (rolling 7-day window).',
          } as StudioResponse);
        }

        // Generate source images if needed (sync — fast enough)
        let sourceImages: string[] = [];
        if (decision.requiresSourceImages) {
          try {
            const imgResult = await renderingEngine.render({
              scenes: [{
                sceneId: uuidv4().slice(0, 8),
                imagePrompt: `Product scene: ${decision.prompt}`,
                textOverlays: [],
                durationSeconds: 0,
                transition: 'none',
              }],
              pacing: 'slow',
            });
            if (imgResult.success) sourceImages = imgResult.sceneImages;
          } catch {}
        }

        // Create creation record with status 'processing'
        const creationId = uuidv4();
        const platforms = decision.parameters.platform
          ? [decision.parameters.platform]
          : ['tiktok', 'instagram_reel', 'youtube_shorts'];

        try {
          await db.insert(schema.creations).values({
            id: creationId, userId: resolvedUserId, type: 'enhanced_video',
            title: decision.prompt.slice(0, 60), status: 'processing',
            metadata: { classification: 'video_creation', prompt: decision.prompt, platforms, pipeline_trace: 'pending' },
          });
        } catch (creationErr: any) {
          console.error('[StudioRoute] Failed to insert creation record:', creationErr.message);
          return res.status(500).json({
            status: 'error',
            error: 'Failed to create video record — please try again.',
          } as StudioResponse);
        }

        // Respond immediately — don't wait for Sora
        res.json({
          status: 'processing',
          classification: 'video_creation',
          creationId,
          response: 'Video generation started — this takes 60–90 seconds. Check back shortly.',
        } as StudioResponse);

        // Fire and forget — Sora pipeline runs in background
        // Use setImmediate instead of IIFE — IIFE pattern was silently
        // not executing in production (Railway) despite working locally.
        const pipelinePayload = {
          creationId,
          prompt: decision.prompt,
          platforms,
          sourceImages,
          resolvedUserId,
          brandContext,
        };
        setImmediate(() => {
          executeVideoPipeline(pipelinePayload).catch((err: unknown) => {
            const detail = err instanceof Error ? err.stack || err.message : String(err);
            process.stderr.write(`[PIPELINE_SETIMMEDIATE_REJECTED] creation=${pipelinePayload.creationId} ${detail}\n`);
          });
        });

        return; // Exit handler after sending response
      }

      case 'video_editing': {
        const sourceVideo = attachments?.[0] || decision.parameters.sourceVideo;
        if (sourceVideo) {
          try {
            // ── Cleanup intent detection ────────────────────────────
            const cleanupKeywords = ['edit', 'clean up', 'cleanup', 'fix', 'trim', 'cut out pauses',
              'remove mistakes', 'remove filler', 'tighten', 'polish', 'refine'];
            const wantsCleanup = cleanupKeywords.some(kw =>
              request.toLowerCase().includes(kw.toLowerCase()),
            );

            let cleanedSource = sourceVideo;
            let cleanupEdits = 0;

            if (wantsCleanup) {
              console.log('[StudioRoute] Cleanup intent detected — running speech cleanup pipeline');
              try {
                const cleanupResult = await renderingEngine.renderWithCleanup(
                  sourceVideo,
                  sourceVideo, // overwrite in place
                  uid,
                );
                if (cleanupResult.success) {
                  cleanedSource = cleanupResult.outputPath || sourceVideo;
                  cleanupEdits = cleanupResult.editsApplied;
                  console.log(`[StudioRoute] Cleanup applied: ${cleanupEdits} edits`);
                }
              } catch (cleanupErr: any) {
                console.warn('[StudioRoute] Cleanup failed, proceeding with original:', cleanupErr.message);
              }
            }

            const aiProvider = cleanupEdits > 0 ? 'Whisper + FFmpeg' : 'FFmpeg';
            console.log(`[PIPELINE] ffmpeg_start creation=${creationId}`);
                const renderResult = await ffmpegRenderService.render(cleanedSource, {
              platforms: decision.parameters.platform ? [decision.parameters.platform] : undefined,
              enableWatermark: !!decision.parameters.brandName,
              callToAction: decision.parameters.callToAction,
            });

            if (!renderResult.success) {
              return res.status(500).json({
                status: 'error',
                classification: decision.classification,
                response: `Video editing failed: ${(renderResult as any).error || 'FFmpeg render returned no output'}`,
              } as StudioResponse);
            }

            const creationId = uuidv4();
            for (const out of renderResult.outputs) {
              assets.push({
                type: 'video',
                url: out.videoUrl,
                thumbnailUrl: out.thumbnailUrl,
                platform: out.platform,
              });
            }

              // Create approval for Operations page
              try {
                await db.insert(schema.approvals).values({
                  id: uuidv4(),
                  userId: uid,
                  type: 'edit',
                  status: 'pending',
                  payload: {
                    assetId: creationId,
                    title: cleanupEdits > 0
                      ? `Cleaned & Edited Video - ${decision.parameters.platform || 'custom'}`
                      : `Edited Video - ${decision.parameters.platform || 'custom'}`,
                    videoUrl: renderResult.outputs[0]?.videoUrl,
                    platforms: decision.parameters.platform ? [decision.parameters.platform] : ['custom'],
                    status: 'pending',
                    cleanupEdits,
                  },
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });
              } catch (approvalErr: any) {
                console.warn('[StudioRoute] Failed to insert approval record:', approvalErr.message);
              }
          } catch (editErr: any) {
            console.error('[StudioRoute] Video editing failed:', editErr.message);
            return res.status(500).json({
              status: 'error',
              classification: decision.classification,
              response: `Video editing failed: ${editErr.message}`,
            } as StudioResponse);
          }
        }
        break;
      }

      case 'final_rendering': {
        const sourceVideo = attachments?.[0] || decision.parameters.sourceVideo;
        if (sourceVideo) {
          try {
            console.log(`[PIPELINE] ffmpeg_start creation=${creationId}`);
                const renderResult = await ffmpegRenderService.render(sourceVideo, {
              platforms: undefined,
              enableWatermark: !!decision.parameters.brandName,
              titleOverlay: decision.parameters.titleOverlay,
              callToAction: decision.parameters.callToAction,
            });

            if (!renderResult.success) {
              return res.status(500).json({
                status: 'error',
                classification: decision.classification,
                response: `Final rendering failed: ${(renderResult as any).error || 'FFmpeg render returned no output'}`,
              } as StudioResponse);
            }

            const creationId = uuidv4();
            const aiProvider = 'FFmpeg';
            for (const out of renderResult.outputs) {
              assets.push({
                type: 'video',
                url: out.videoUrl,
                thumbnailUrl: out.thumbnailUrl,
                platform: out.platform,
              });
            }

              // Create approval for Operations page
              try {
                await db.insert(schema.approvals).values({
                  id: uuidv4(),
                  userId: uid,
                  type: 'render',
                  status: 'pending',
                  payload: {
                    assetId: creationId,
                    title: `Final Render - ${decision.prompt.slice(0, 50)}`,
                    videoUrl: renderResult.outputs[0]?.videoUrl,
                    status: 'pending',
                  },
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });
              } catch (approvalErr: any) {
                console.warn('[StudioRoute] Failed to insert approval record:', approvalErr.message);
              }
          } catch (renderErr: any) {
            console.error('[StudioRoute] Final rendering failed:', renderErr.message);
            return res.status(500).json({
              status: 'error',
              classification: decision.classification,
              response: `Final rendering failed: ${renderErr.message}`,
            } as StudioResponse);
          }
        }
        break;
      }
    }

    if (assets.length === 0) {
      return res.status(500).json({
        status: 'error',
        classification: decision.classification,
        response: 'No assets were generated — the pipeline produced no output.',
      } as StudioResponse);
    }

    return res.json({
      status: 'completed',
      classification: decision.classification,
      response: `Generated ${assets.length} asset(s) from your request.`,
      assets,
    } as StudioResponse);
  } catch (error: any) {
    console.error('[StudioRoute] Processing failed:', error.message);
    return res.status(500).json({ status: 'error', error: error.message } as StudioResponse);
  }
});

// ─── GET /api/studio/creation/:id — Poll async video status ──────────────────

router.get('/creation/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [creation] = await db.select()
      .from(schema.creations)
      .where(eq(schema.creations.id, id))
      .limit(1);

    if (!creation) {
      return res.status(404).json({ status: 'error', error: 'Creation not found' });
    }

    const meta = (creation.metadata as any) || {};
    const response: StudioResponse = {
      status: creation.status === 'completed' ? 'completed'
        : creation.status === 'failed' ? 'error'
        : 'processing',
      classification: meta.classification || 'video_creation',
      creationId: creation.id,
      metadata: meta, // Include pipeline_trace for frontend visibility
      response: creation.status === 'completed' ? 'Video is ready.'
        : creation.status === 'failed' ? `Generation failed: ${meta.error || 'unknown error'}\n\nPrompt sent: "${meta.prompt || 'unknown'}"`
        : 'Still generating...',
    };

    if (creation.status === 'completed' && creation.fileUrl) {
      response.assets = [{
        type: 'video',
        url: creation.fileUrl,
        platform: (meta.platforms?.[0]) || 'tiktok',
      }];
    }

    return res.json(response);
  } catch (err: any) {
    console.error('[StudioRoute] Failed to fetch creation:', err.message);
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

// ─── GET /api/studio/assets — List user's creations for Operations page ─────

/**
 * Regenerate an expiring R2 signed URL. Cloudflare signed URLs expire after
 * 1 hour — calling this on read ensures Library always shows working URLs.
 */

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

async function refreshR2Url(storedUrl: string): Promise<string> {
  if (!storedUrl.includes('r2.cloudflarestorage.com')) return storedUrl;
  try {
    // Extract key from URL: https://{host}/{bucket}/{key}?{params}
    const url = new URL(storedUrl);
    const pathParts = url.pathname.split('/');
    // pathname is like /{bucket}/brands/... — skip bucket prefix
    const key = pathParts.slice(2).join('/');
    const fresh = await r2Storage.getSignedUrl(key);
    return fresh || storedUrl;
  } catch {
    return storedUrl; // fall back to stored URL on any failure
  }
}

router.get('/assets', async (req: Request, res: Response) => {
  try {
    const uid = (req as any).userId || req.query.userId || req.headers['x-user-id'];
    if (!uid) return res.status(400).json({ status: 'error', error: 'userId required' });

    const resolvedUserId = await resolveUserId(String(uid));
    if (!resolvedUserId) return res.status(400).json({ status: 'error', error: 'User not found' });

    const creations = await db.select()
      .from(schema.creations)
      .where(eq(schema.creations.userId, resolvedUserId))
      .orderBy(desc(schema.creations.createdAt))
      .limit(50);

    const assets = await Promise.all(creations.map(async c => {
      const fileUrl = c.fileUrl ? await refreshR2Url(c.fileUrl) : null;
      const thumbnailUrl = c.thumbnailUrl ? await refreshR2Url(c.thumbnailUrl) : null;
      return {
        id: c.id,
        type: c.type,
        title: c.title,
        status: c.status,
        fileUrl,
        thumbnailUrl,
        metadata: c.metadata,
        createdAt: c.createdAt,
      };
    }));

    res.json({ status: 'ok', assets });
  } catch (err: any) {
    console.error('[StudioRoute] Failed to fetch assets:', err.message);
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

// ─── GET /api/studio/download/:id — Proxy download (solves R2 CORS on mobile) ─

// ─── GET /api/studio/download/:id — Proxy download (solves R2 CORS on mobile) ─
router.get('/download/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [creation] = await db.select()
      .from(schema.creations).where(eq(schema.creations.id, id)).limit(1);

    if (!creation?.fileUrl) return res.status(404).json({ error: 'Not found' });

    // Extract R2 key and download via S3 client (avoids signed URL expiry entirely)
    const r2Key = extractR2Key(creation.fileUrl);
    if (!r2Key) {
      return res.status(502).json({ error: 'Could not parse R2 key from URL' });
    }

    const { r2Storage } = await import('../services/r2StorageService.js');
    const buffer = await r2Storage.downloadBuffer(r2Key);
    if (!buffer) return res.status(502).json({ error: 'R2 download failed' });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="empirelaunch-${id.slice(0, 8)}.mp4"`);
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
  } catch (err: any) {
    console.error('[StudioRoute] Download proxy failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/studio/creation/:id — Delete a creation + R2 file + approval ─
router.delete('/creation/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [creation] = await db.select()
      .from(schema.creations).where(eq(schema.creations.id, id)).limit(1);
    if (!creation) return res.status(404).json({ error: 'Creation not found' });

    // Delete R2 file first
    if (creation.fileUrl) {
      const r2Key = extractR2Key(creation.fileUrl);
      if (r2Key) {
        const { r2Storage } = await import('../services/r2StorageService.js');
        await r2Storage.deleteFile(r2Key);
      }
    }

    // Delete creation record
    await db.delete(schema.creations).where(eq(schema.creations.id, id));

    // Delete associated approval (by payload.assetId or id match)
    try {
      await db.delete(schema.approvals).where(eq(schema.approvals.id, id));
    } catch {}

    res.json({ status: 'ok', deleted: id });
  } catch (err: any) {
    console.error('[StudioRoute] Delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;


// Diagnostic: test API connectivity
router.get('/diag', async (_req: Request, res: Response) => {
  // 15-second hard deadline for the entire diag response
  let sent = false;
  const timer = setTimeout(() => {
    if (!sent) { sent = true; res.json({ timeout: true, message: 'Diag timed out' }); }
  }, 15000);

  const results: any = {};
  // Test OpenAI first (primary provider)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        signal: AbortSignal.timeout(5000)
      });
      results.openai = { status: r.status, ok: r.ok };
    } catch (e: any) { results.openai = { error: e.message }; }
  } else { results.openai = { error: 'No key configured' }; }

  // Test Gemini
  const geminiKey = process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }] }),
          signal: AbortSignal.timeout(5000) }
      );
      results.gemini = { status: r.status, ok: r.ok };
      if (!r.ok) results.gemini.body = await r.text().catch(() => '');
    } catch (e: any) { results.gemini = { error: e.message }; }
  } else { results.gemini = { error: 'No key configured' }; }

  if (!sent) { sent = true; clearTimeout(timer); res.json(results); }
});

// ─── GET /api/studio/trace — Quick check: latest creation trace ──────────────
router.get('/trace', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.headers['x-user-id'] as string;
    if (!userId) return res.status(401).json({ error: 'No user ID' });
    const [latest] = await db.select({
      id: schema.creations.id,
      status: schema.creations.status,
      metadata: schema.creations.metadata,
      created_at: schema.creations.createdAt,
    }).from(schema.creations)
      .where(and(eq(schema.creations.userId, userId), eq(schema.creations.type, 'video')))
      .orderBy(desc(schema.creations.createdAt))
      .limit(1);
    if (!latest) return res.json({ message: 'No video creations yet' });
    const meta = latest.metadata as any;
    res.json({
      id: latest.id,
      status: latest.status,
      pipeline_trace: meta?.pipeline_trace || 'no_trace',
      created_at: latest.created_at,
      error: meta?.error,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
