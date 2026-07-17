import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { aiRouter, RouterDecision } from '../services/aiRouter.js';
import { soraVideoService } from '../services/soraVideoService.js';
import { ffmpegRenderService } from '../services/ffmpegRenderService.js';
import { renderingEngine } from '../services/renderingEngine.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

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
        // Call renderingEngine standalone for image generation
        try {
          const imageResult = await renderingEngine.render({
            scenes: [{
              sceneId: uuidv4().slice(0, 8),
              imagePrompt: decision.prompt,
              textOverlays: [],
              durationSeconds: 0,
            }],
            pacing: 'moderate',
          });

          if (imageResult.success && imageResult.sceneImages.length > 0) {
            const imgUrl = imageResult.sceneImages[0];
            assets.push({ type: 'image', url: imgUrl });
            // Store in creations table
            await db.insert(schema.creations).values({
              id: uuidv4(), userId: uid, type: 'design',
              title: decision.prompt.slice(0, 60), status: 'completed',
              fileUrl: imgUrl, metadata: { classification: decision.classification, prompt: decision.prompt },
            }).onConflictDoNothing();
          }
        } catch (imgErr: any) {
          console.error('[StudioRoute] Image generation failed:', imgErr.message);
        }
        break;
      }

      case 'video_creation': {
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
              }],
              pacing: 'slow',
            });
            if (imgResult.success) sourceImages = imgResult.sceneImages;
          } catch {}
        }

        // Generate video via Sora 2
        try {
          const soraResult = await soraVideoService.generateVideo(decision.prompt, {
            duration: decision.parameters.duration || 10,
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

            // Store in creations table
            await db.insert(schema.creations).values({
              id: uuidv4(), userId: uid, type: 'enhanced_video',
              title: decision.prompt.slice(0, 60), status: 'completed',
              fileUrl: soraResult.videoUrl || soraResult.videoPath,
              metadata: { classification: 'video_creation', prompt: decision.prompt, platforms },
            }).onConflictDoNothing();
          }
        } catch (vidErr: any) {
          console.error('[StudioRoute] Video creation failed:', vidErr.message);
        }
        break;
      }

      case 'video_editing': {
        // For video editing, we need an existing video — use attachments
        const sourceVideo = attachments?.[0] || decision.parameters.sourceVideo;
        if (sourceVideo) {
          try {
            const renderResult = await ffmpegRenderService.render(sourceVideo, {
              platforms: decision.parameters.platform ? [decision.parameters.platform] : undefined,
              enableWatermark: !!decision.parameters.brandName,
              callToAction: decision.parameters.callToAction,
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
              platforms: undefined, // all platforms
              enableWatermark: !!decision.parameters.brandName,
              titleOverlay: decision.parameters.titleOverlay,
              callToAction: decision.parameters.callToAction,
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
