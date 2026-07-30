import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { aiRouter, RouterDecision } from '../services/aiRouter.js';
import { soraVideoService } from '../services/soraVideoService.js';
import { ffmpegRenderService } from '../services/ffmpegRenderService.js';
import { renderingEngine } from '../services/renderingEngine.js';
import { db, schema } from '../db/index.js';
import { eq, and, gte, count, desc } from 'drizzle-orm';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

// ─── Types ──────────────────────────────────────────────────────────────────

interface StudioRequest {
  userId?: string;
  brandId?: string;
  request: string;
  attachments?: string[];
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface StudioResponse {
  status: 'completed' | 'needs_refinement' | 'ai_response' | 'error';
  classification?: string;
  response?: string;                         // Natural language for user
  assets?: Array<{
    type: 'image' | 'video';
    url: string;
    thumbnailUrl?: string;
    platform?: string;
  }>;
  error?: string;
}

// ─── POST /api/studio/process ────────────────────────────────────────────────

router.post('/process', async (req: Request, res: Response) => {
  try {
    const { userId, brandId, request, attachments, conversationHistory } = req.body as StudioRequest;

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

    // 2. Route via Gemini AI Router
    const decision = await aiRouter.route({
      userId: uid,
      request,
      brandContext,
      conversationHistory,
    });

    console.log(`[StudioRoute] Routed: ${decision.classification} ${decision.needsRefinement ? '(needs refinement)' : ''}`);

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
                status: 'completed',
                payload: { assetId: creationId, title: decision.prompt.slice(0, 60), imageUrl: imgUrl, status: 'completed' },
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
        // Quota check — rolling 7-day window, no subscription table needed
        let videoCount = 0;
        try {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const [countResult] = await db.select({ count: count() })
            .from(schema.creations)
            .where(and(
              eq(schema.creations.userId, uid),
              eq(schema.creations.type, 'video_creation'),
              gte(schema.creations.createdAt, sevenDaysAgo)
            ));
          videoCount = Number(countResult?.count ?? 0);
        } catch (quotaErr: any) {
          console.warn('[StudioRoute] Quota check failed, allowing video creation:', quotaErr.message);
          // Skip quota — let the user create the video despite DB issues
        }
        if (Number(videoCount) >= 7) {
          return res.status(429).json({
            status: 'error',
            error: 'You\'ve used 7/7 videos this week. Try again later when a slot frees up (rolling 7-day window).',
          } as StudioResponse);
        }

        // Generate source images if needed
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

        // Generate video via Sora 2
        try {
          const soraResult = await soraVideoService.generateVideo(decision.prompt);

          if (!soraResult.success) {
            return res.status(500).json({
              status: 'error',
              classification: decision.classification,
              response: `Video generation failed: ${soraResult.error || 'Sora returned no video'}`,
            } as StudioResponse);
          }

          if (soraResult.videoPath) {
            // Package for platforms via FFmpeg Render
            const platforms = decision.parameters.platform
              ? [decision.parameters.platform]
              : ['tiktok', 'instagram_reel', 'youtube_shorts'];

            const renderResult = await ffmpegRenderService.render(soraResult.videoPath, {
              platforms,
              enableWatermark: !!decision.parameters.brandName,
            });

            if (!renderResult.success) {
              return res.status(500).json({
                status: 'error',
                classification: decision.classification,
                response: `Video rendering failed: ${(renderResult as any).error || 'FFmpeg render returned no output'}`,
              } as StudioResponse);
            }

            for (const out of renderResult.outputs) {
              assets.push({
                type: 'video',
                url: out.videoUrl,
                thumbnailUrl: out.thumbnailUrl,
                platform: out.platform,
              });
            }

            // Store in creations table with AI provider tag
            const creationId = uuidv4();
            const aiProvider = 'Sora 2 + FFmpeg';
            try {
              await db.insert(schema.creations).values({
                id: creationId, userId: uid, type: 'enhanced_video',
                title: decision.prompt.slice(0, 60), status: 'completed',
                fileUrl: soraResult.videoPath,
                metadata: { classification: 'video_creation', prompt: decision.prompt, platforms, aiProvider },
              });
            } catch (creationErr: any) {
              console.warn('[StudioRoute] Failed to insert creation record:', creationErr.message);
            }

            // Create approval for Operations page
            try {
              await db.insert(schema.approvals).values({
                id: uuidv4(),
                userId: uid,
                type: 'video',
                status: 'completed',
                payload: { assetId: creationId, title: decision.prompt.slice(0, 60), videoUrl: soraResult.videoUrl || soraResult.videoPath, platforms, status: 'completed' },
                createdAt: new Date(),
                updatedAt: new Date(),
              });
            } catch (approvalErr: any) {
              console.warn('[StudioRoute] Failed to insert approval record:', approvalErr.message);
            }
          }
        } catch (vidErr: any) {
          console.error('[StudioRoute] Video creation failed:', vidErr.message);
          return res.status(500).json({
            status: 'error',
            classification: decision.classification,
            response: `Video generation failed: ${vidErr.message}`,
          } as StudioResponse);
        }
        break;
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
                  status: 'completed',
                  payload: {
                    assetId: creationId,
                    title: cleanupEdits > 0
                      ? `Cleaned & Edited Video - ${decision.parameters.platform || 'custom'}`
                      : `Edited Video - ${decision.parameters.platform || 'custom'}`,
                    videoUrl: renderResult.outputs[0]?.videoUrl,
                    platforms: decision.parameters.platform ? [decision.parameters.platform] : ['custom'],
                    status: 'completed',
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
                  status: 'completed',
                  payload: {
                    assetId: creationId,
                    title: `Final Render - ${decision.prompt.slice(0, 50)}`,
                    videoUrl: renderResult.outputs[0]?.videoUrl,
                    status: 'completed',
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
