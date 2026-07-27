import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { aiRouter, RouterDecision } from '../services/aiRouter.js';
import { soraVideoService } from '../services/soraVideoService.js';
import { ffmpegRenderService } from '../services/ffmpegRenderService.js';
import { renderingEngine } from '../services/renderingEngine.js';
import { libraryService } from '../services/libraryService.js';
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
          const imageResult = await renderingEngine.render({
            scenes: [{
              sceneId: uuidv4().slice(0, 8),
              imagePrompt: decision.prompt,
              textOverlays: [],
              durationSeconds: 0,
              transition: 'none',
            }],
            pacing: 'moderate',
            userId: uid,
          });

          if (imageResult.success && imageResult.sceneImages.length > 0) {
            const imgUrl = imageResult.sceneImages[0];
            const aiProvider = imageResult.videoUrl ? 'Sora 2' : 'GPT Image 2';
            const assetType = decision.classification === 'image_editing' ? 'edit' : 'design';
            assets.push({ type: 'image', url: imgUrl });

            // Store in creations table with AI provider tag
            const creationId = uuidv4();
            await db.insert(schema.creations).values({
              id: creationId, userId: uid, type: 'design',
              title: decision.prompt.slice(0, 60), status: 'completed',
              fileUrl: imgUrl,
              metadata: { classification: decision.classification, prompt: decision.prompt, aiProvider },
            }).onConflictDoNothing();

            // Also create approval for Operations page
            await db.insert(schema.approvals).values({
              id: uuidv4(),
              userId: uid,
              type: assetType,
              status: 'completed',
              payload: { assetId: creationId, title: decision.prompt.slice(0, 60), imageUrl: imgUrl, status: 'completed' },
              createdAt: new Date(),
              updatedAt: new Date(),
            });

            // Auto-save to library
            try {
              await libraryService.create({
                userId: uid,
                brandId: brandId || uid,
                type: assetType,
                name: decision.prompt.slice(0, 60),
                filePath: imgUrl,
                mimeType: 'image/png',
                metadata: { aiProvider, source: 'studio', creationId },
              });
            } catch (libErr: any) {
              console.warn('[StudioRoute] Library save failed:', libErr.message);
            }
          }
        } catch (imgErr: any) {
          console.error('[StudioRoute] Image generation failed:', imgErr.message);
        }
        break;
      }

      case 'video_creation': {
        // Quota check — anchored to subscription date, resets same day each week
        const [sub] = await db.select().from(schema.subscriptions)
          .where(eq(schema.subscriptions.userId, uid))
          .orderBy(desc(schema.subscriptions.paidAt))
          .limit(1);
        const anchor = sub?.paidAt ? new Date(sub.paidAt) : new Date();
        const msPerWeek = 7 * 24 * 60 * 60 * 1000;
        const weeksSinceAnchor = Math.floor((Date.now() - anchor.getTime()) / msPerWeek);
        const currentWeekStart = new Date(anchor.getTime() + weeksSinceAnchor * msPerWeek);
        const nextReset = new Date(currentWeekStart.getTime() + msPerWeek);

        const [{ count: videoCount }] = await db.select({ count: count() })
          .from(schema.creations)
          .where(and(
            eq(schema.creations.userId, uid),
            eq(schema.creations.type, 'video_creation'),
            gte(schema.creations.createdAt, currentWeekStart)
          ));
        if (Number(videoCount) >= 7) {
          return res.status(429).json({
            status: 'error',
            error: `You've used 7/7 videos this week. Your quota resets on ${nextReset.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`,
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
          const soraResult = await soraVideoService.generateVideo(decision.prompt, {
            duration: decision.parameters.duration || 60,
            size: decision.parameters.aspectRatio === '9:16' ? '1080x1920' : '1024x1024',
          });

          if (soraResult.success && soraResult.videoPath) {
            // Package for platforms via FFmpeg Render
            const platforms = decision.parameters.platform
              ? [decision.parameters.platform]
              : ['tiktok', 'instagram_reel', 'youtube_shorts'];

            const renderResult = await ffmpegRenderService.render(soraResult.videoPath, {
              platforms,
              enableWatermark: !!decision.parameters.brandName,
            });

            if (renderResult.success) {
              for (const out of renderResult.outputs) {
                assets.push({
                  type: 'video',
                  url: out.videoUrl,
                  thumbnailUrl: out.thumbnailUrl,
                  platform: out.platform,
                });
              }
            }

            // Store in creations table with AI provider tag
            const creationId = uuidv4();
            const aiProvider = 'Sora 2 + FFmpeg';
            await db.insert(schema.creations).values({
              id: creationId, userId: uid, type: 'enhanced_video',
              title: decision.prompt.slice(0, 60), status: 'completed',
              fileUrl: soraResult.videoUrl || soraResult.videoPath,
              metadata: { classification: 'video_creation', prompt: decision.prompt, platforms, aiProvider },
            }).onConflictDoNothing();

            // Also create approval for Operations page
            await db.insert(schema.approvals).values({
              id: uuidv4(),
              userId: uid,
              type: 'video',
              status: 'completed',
              payload: { assetId: creationId, title: decision.prompt.slice(0, 60), videoUrl: soraResult.videoUrl || soraResult.videoPath, platforms, status: 'completed' },
              createdAt: new Date(),
              updatedAt: new Date(),
            });

            // Auto-save each output to library
            for (const out of renderResult.outputs) {
              try {
                await libraryService.create({
                  userId: uid,
                  brandId: brandId || uid,
                  type: 'video',
                  name: `${decision.prompt.slice(0, 50)} - ${out.platform}`,
                  filePath: out.videoUrl,
                  thumbnailPath: out.thumbnailUrl,
                  mimeType: 'video/mp4',
                  metadata: { aiProvider, source: 'studio', creationId, platform: out.platform },
                });
              } catch (libErr: any) {
                console.warn('[StudioRoute] Library save failed:', libErr.message);
              }
            }
          } else {
            // Sora 2 failed — fall back to GPT Image 2 + FFmpeg via rendering engine
            console.log('[StudioRoute] Sora 2 failed, falling back to GPT Image 2 + FFmpeg');
            try {
              const fallbackResult = await renderingEngine.render({
                scenes: [{
                  sceneId: uuidv4().slice(0, 8),
                  imagePrompt: decision.prompt,
                  textOverlays: [],
                  durationSeconds: 0,
                  transition: 'none',
                }],
                pacing: 'moderate',
                userId: uid,
              });
              if (fallbackResult.success && fallbackResult.videoUrl) {
                const creationId = uuidv4();
                const aiProvider = 'GPT Image 2 + FFmpeg';
                assets.push({ type: 'video', url: fallbackResult.videoUrl });

                await db.insert(schema.creations).values({
                  id: creationId, userId: uid, type: 'enhanced_video',
                  title: decision.prompt.slice(0, 60), status: 'completed',
                  fileUrl: fallbackResult.videoUrl,
                  metadata: { classification: 'video_creation', prompt: decision.prompt, platforms: ['tiktok'], aiProvider },
                }).onConflictDoNothing();

                await db.insert(schema.approvals).values({
                  id: uuidv4(), userId: uid, type: 'video', status: 'completed',
                  payload: { assetId: creationId, title: decision.prompt.slice(0, 60), videoUrl: fallbackResult.videoUrl, platforms: ['tiktok'], status: 'completed' },
                  createdAt: new Date(), updatedAt: new Date(),
                });
              } else {
                return res.json({
                  status: 'error',
                  classification: 'video_creation',
                  response: `Video generation failed: ${soraResult.error || 'Sora 2 unavailable'}. Fallback also failed: ${fallbackResult.error || 'unknown'}.`,
                  error: 'all_pipelines_failed',
                } as StudioResponse);
              }
            } catch (fallbackErr: any) {
              return res.json({
                status: 'error',
                classification: 'video_creation',
                response: `Video generation failed: ${soraResult.error || 'Sora 2 unavailable'}. Fallback error: ${fallbackErr.message}.`,
                error: 'all_pipelines_failed',
              } as StudioResponse);
            }
          }
        } catch (vidErr: any) {
          console.error('[StudioRoute] Video creation failed:', vidErr.message);
          return res.json({
            status: 'error',
            classification: 'video_creation',
            response: `Video generation error: ${(vidErr as Error).message}. Please try again.`,
            error: (vidErr as Error).message,
          } as StudioResponse);
        }
        break;
      }

      case 'video_editing': {
        const sourceVideo = attachments?.[0] || decision.parameters.sourceVideo;
        if (sourceVideo) {
          try {
            const renderResult = await ffmpegRenderService.render(sourceVideo, {
              platforms: decision.parameters.platform ? [decision.parameters.platform] : undefined,
              enableWatermark: !!decision.parameters.brandName,
              callToAction: decision.parameters.callToAction,
            });

            if (renderResult.success) {
              const creationId = uuidv4();
              const aiProvider = 'FFmpeg';
              for (const out of renderResult.outputs) {
                assets.push({
                  type: 'video',
                  url: out.videoUrl,
                  thumbnailUrl: out.thumbnailUrl,
                  platform: out.platform,
                });
                // Auto-save to library
                try {
                  await libraryService.create({
                    userId: uid,
                    brandId: brandId || uid,
                    type: 'edit',
                    name: `Edited Video - ${out.platform}`,
                    filePath: out.videoUrl,
                    thumbnailPath: out.thumbnailUrl,
                    mimeType: 'video/mp4',
                    metadata: { aiProvider, source: 'studio', creationId, platform: out.platform },
                  });
                } catch (libErr: any) {
                  console.warn('[StudioRoute] Library save failed:', libErr.message);
                }
              }

              // Create approval record for Operations page
              await db.insert(schema.approvals).values({
                id: uuidv4(),
                userId: uid,
                type: 'edit',
                status: 'completed',
                payload: {
                  assetId: creationId,
                  title: `Edited Video - ${decision.parameters.platform || 'custom'}`,
                  videoUrl: renderResult.outputs[0]?.videoUrl,
                  platforms: decision.parameters.platform ? [decision.parameters.platform] : ['custom'],
                  status: 'completed',
                },
                createdAt: new Date(),
                updatedAt: new Date(),
              }).onConflictDoNothing();
            }
          } catch (editErr: any) {
            console.error('[StudioRoute] Video editing failed:', editErr.message);
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

            if (renderResult.success) {
              const creationId = uuidv4();
              const aiProvider = 'FFmpeg';
              for (const out of renderResult.outputs) {
                assets.push({
                  type: 'video',
                  url: out.videoUrl,
                  thumbnailUrl: out.thumbnailUrl,
                  platform: out.platform,
                });
                // Auto-save to library
                try {
                  await libraryService.create({
                    userId: uid,
                    brandId: brandId || uid,
                    type: 'video',
                    name: `Rendered - ${out.platform}`,
                    filePath: out.videoUrl,
                    thumbnailPath: out.thumbnailUrl,
                    mimeType: 'video/mp4',
                    metadata: { aiProvider, source: 'studio', creationId, platform: out.platform },
                  });
                } catch (libErr: any) {
                  console.warn('[StudioRoute] Library save failed:', libErr.message);
                }
              }

              // Create approval record for Operations page
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
              }).onConflictDoNothing();
            }
          } catch (renderErr: any) {
            console.error('[StudioRoute] Final rendering failed:', renderErr.message);
          }
        }
        break;
      }
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
