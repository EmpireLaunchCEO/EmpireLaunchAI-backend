import { Router, Request, Response } from 'express';
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
            metadata: { classification: 'video_creation', prompt: decision.prompt, platforms },
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
        (async () => {
          // 5-minute failsafe: if the pipeline hasn't finished by then, mark as failed
          const safetyTimeout = setTimeout(async () => {
            console.warn(`[StudioRoute] Video creation ${creationId} timed out after 5 minutes`);
            try {
              const [current] = await db.select({ status: schema.creations.status, metadata: schema.creations.metadata })
                .from(schema.creations).where(eq(schema.creations.id, creationId)).limit(1);
              if (current?.status === 'processing') {
                await db.update(schema.creations)
                  .set({
                    status: 'failed',
                    metadata: { ...(current.metadata as any || {}), error: 'Pipeline timed out after 5 minutes' },
                  })
                  .where(eq(schema.creations.id, creationId));
              }
            } catch {}
          }, 300_000);

          try {
            try {
              const soraResult = await soraVideoService.generateVideo(decision.prompt);

              if (!soraResult.success || !soraResult.videoPath) {
                await db.update(schema.creations)
                  .set({
                    status: 'failed',
                    metadata: { classification: 'video_creation', prompt: decision.prompt, platforms, error: soraResult.error || 'Sora returned no video' },
                  })
                  .where(eq(schema.creations.id, creationId));
                return;
              }

              // FFmpeg render — gracefully degrade to raw Sora video
              let videoUrl = soraResult.videoUrl || soraResult.videoPath;
              try {
                const renderResult = await ffmpegRenderService.render(soraResult.videoPath, {
                  platforms,
                  enableWatermark: !!decision.parameters.brandName,
                });
                if (renderResult.success && renderResult.outputs.length > 0) {
                  videoUrl = renderResult.outputs[0]?.videoUrl || videoUrl;
                }
              } catch (ffmpegErr: any) {
                console.warn('[StudioRoute] FFmpeg render unavailable, using raw Sora video:', ffmpegErr.message);
              }

              // R2 upload
              try {
                const { r2Storage } = await import('../services/r2StorageService.js');
                if (r2Storage.isAvailable) {
                  const r2 = await r2Storage.uploadLocalFile(soraResult.videoPath, resolvedUserId, 'cinema/sora', 'video/mp4');
                  if (r2.url) videoUrl = r2.url;
                }
              } catch {}

              // Update creation to completed
              await db.update(schema.creations)
                .set({
                  status: 'completed',
                  fileUrl: videoUrl,
                  metadata: {
                    classification: 'video_creation',
                    prompt: decision.prompt,
                    platforms,
                    aiProvider: 'Sora 2',
                    sourceImages,
                  },
                })
                .where(eq(schema.creations.id, creationId));

              // Create approval for Operations page
              try {
                await db.insert(schema.approvals).values({
                  id: uuidv4(),
                  userId: resolvedUserId,
                  type: 'video',
                  status: 'completed',
                  payload: { assetId: creationId, title: decision.prompt.slice(0, 60), videoUrl, platforms, status: 'completed' },
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });
              } catch (approvalErr: any) {
                console.warn('[StudioRoute] Failed to insert approval record:', approvalErr.message);
              }
            } catch (bgErr: any) {
              console.error('[StudioRoute] Background video creation failed:', bgErr.message);
              try {
                await db.update(schema.creations)
                  .set({
                    status: 'failed',
                    metadata: { classification: 'video_creation', prompt: decision.prompt, platforms, error: bgErr.message },
                  })
                  .where(eq(schema.creations.id, creationId));
              } catch {}
            }
          } finally {
            clearTimeout(safetyTimeout);
          }
        })();

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
      response: creation.status === 'completed' ? 'Video is ready.'
        : creation.status === 'failed' ? `Generation failed: ${meta.error || 'unknown error'}`
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

router.get('/download/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const [creation] = await db.select()
      .from(schema.creations).where(eq(schema.creations.id, id)).limit(1);

    if (!creation?.fileUrl) return res.status(404).json({ error: 'Not found' });

    // Refresh signed URL before fetching (stored URLs expire after 1 hour)
    const freshUrl = await refreshR2Url(creation.fileUrl);
    const r2Response = await fetch(freshUrl);
    if (!r2Response.ok) return res.status(502).json({ error: 'R2 fetch failed' });

    const contentType = r2Response.headers.get('content-type') || 'video/mp4';
    const buffer = Buffer.from(await r2Response.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="empirelaunch-${id.slice(0, 8)}.mp4"`);
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
  } catch (err: any) {
    console.error('[StudioRoute] Download proxy failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;

// Diagnostic: test API connectivity
router.get('/diag', async (_req: Request, res: Response) => {
  const results: any = {};
  
  // Test Gemini
  const geminiKey = process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }] }),
          signal: AbortSignal.timeout(10000) }
      );
      results.gemini = { status: r.status, ok: r.ok };
      if (!r.ok) results.gemini.body = await r.text().catch(() => '');
    } catch (e: any) { results.gemini = { error: e.message }; }
  } else { results.gemini = { error: 'No key configured' }; }

  // Test OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        signal: AbortSignal.timeout(10000)
      });
      results.openai = { status: r.status, ok: r.ok };
    } catch (e: any) { results.openai = { error: e.message }; }
  } else { results.openai = { error: 'No key configured' }; }

  res.json(results);
});
