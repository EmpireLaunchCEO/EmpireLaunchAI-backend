import { Request, Response } from 'express';
import { empireStudioService, StyleDNA } from '../services/empireStudioService.js';
import { creationEngine } from '../services/creationEngine.js';
import { visualProxyService } from '../services/visualProxyService.js';
import { dnaVaultService, DnaStrand } from '../services/dnaVaultService.js';
import { cinemaEngineService } from '../services/cinemaEngineService.js';
import { reasoningEngine } from '../services/reasoningEngine.js';
import { usageService } from '../services/usageService.js';
import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

export class EmpireStudioController {
  /**
   * POST /api/studio/chat
   * Conversational consultant for design goals.
   * If the response contains [GENERATE], triggers the creation pipeline.
   */
  async chat(req: Request, res: Response) {
    const userId = (req as any).userId;
    const { message, niche } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    try {
      const result = await reasoningEngine.consult(userId, message, niche);

      // Check if the consultant wants to generate
      if (result.message.includes('[GENERATE]')) {
        try {
          const creationResult = await creationEngine.generateMasterAsset({
            userId,
            campaignId: uuidv4(),
            niche: niche || 'Custom Video',
            productName: message,
            platforms: ['tiktok'],
            archetype: 'creator',
          });
          res.json({
            message: result.message.replace('[GENERATE]', '').trim(),
            generated: true,
            assetUrl: creationResult.masterAssetUrl,
            creationResult,
          });
          return;
        } catch (genError) {
          console.error('[EmpireStudioController] chat-triggered generation failed:', genError);
          // Fall through — return the consultant message without generation
        }
      }

      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[EmpireStudioController] chat failed:', error);
      res.status(500).json({ error: msg });
    }
  }

  /**
   * POST /api/studio/cinema/twin
   * Create a Neural Twin video from a photo and script.
   */
  async createNeuralTwin(req: Request, res: Response) {
    const userId = (req as any).userId;
    const { photoUrl, script, voiceId } = req.body;

    if (!photoUrl || !script) {
      return res.status(400).json({ error: 'photoUrl and script are required' });
    }

    try {
      const asset = await cinemaEngineService.createNeuralTwin({
        userId,
        photoUrl,
        script,
        voiceId
      });
      res.json(asset);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  }

  /**
   * POST /api/studio/create
   * Create a master asset using DALL-E + FFmpeg native pipeline.
   */
  async create(req: Request, res: Response) {
    const userId = (req as any).userId;
    const {
      campaignId,
      niche,
      angle,
      platforms,
      title,
      archetype,
    } = req.body;

    if (!niche || !angle) {
      return res.status(400).json({
        error: 'Missing required fields: niche, angle',
      });
    }

    try {
      const campaignIdValue = campaignId || uuidv4();
      const assetId = uuidv4();
      const approvalId = uuidv4();
      const safePlatforms = platforms || ['tiktok'];

      // Create campaign
      try {
        await db.insert(schema.campaigns).values({
          id: campaignIdValue,
          userId,
          name: title || angle || 'Studio Creation',
          tone: 'professional',
          frequency: 'weekly',
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (campErr) {
        console.log('[EmpireStudioController] Campaign insert skipped (may already exist):', (campErr as Error).message);
      }

      // Enforce usage limit
      await usageService.enforceLimit(userId, 'neural_twin');

      // Create the approval immediately so it shows up in Operations
      try {
        await db.insert(schema.approvals).values({
          id: approvalId,
          userId,
          type: 'video',
          payload: {
            assetId,
            title: title || angle,
            description: `AI-generated ${niche} video: ${title || angle}`,
            niche,
            platforms: safePlatforms,
            status: 'generating',
          },
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (dbErr) {
        console.warn('[EmpireStudioController] Failed to create approval:', (dbErr as Error).message);
      }

      // Track usage
      try {
        await usageService.logUsage(userId, 'neural_twin', {
          assetId,
          title: title || angle,
          niche,
          source: 'studio_create',
        });
      } catch (usageErr) {
        console.warn('[EmpireStudioController] Failed to track usage:', (usageErr as Error).message);
      }

      // Return immediately — pipeline runs in background
      res.json({ status: 'processing', assetId, message: 'Video generation started' });

      // Run pipeline in background (don't await — let it complete asynchronously)
      creationEngine.generateMasterAsset({
        userId,
        campaignId: campaignIdValue,
        niche,
        productName: angle,
        platforms: safePlatforms,
        archetype: archetype || 'creator',
      }).then(async (result) => {
        // Update the approval with the video URL
        if (result.masterAssetUrl) {
          await db.update(schema.approvals)
            .set({
              payload: {
                assetId,
                title: title || angle,
                description: `AI-generated ${niche} video: ${title || angle}`,
                videoUrl: result.masterAssetUrl,
                niche,
                platforms: safePlatforms,
                status: 'completed',
              },
              updatedAt: new Date(),
            })
            .where(eq(schema.approvals.id, approvalId));
        }

        // Save to masterAssets
        try {
          await db.insert(schema.masterAssets).values({
            id: assetId,
            userId,
            campaignId: campaignIdValue,
            assetType: 'video',
            status: 'completed',
            masterVideoUrl: result.masterAssetUrl || null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } catch (dbErr) {
          console.warn('[EmpireStudioController] Failed to save masterAsset:', (dbErr as Error).message);
        }
      }).catch(async (error) => {
        console.error('[EmpireStudioController] Background pipeline failed:', error);
        // Mark approval as failed
        try {
          await db.update(schema.approvals)
            .set({
              payload: {
                assetId,
                title: title || angle,
                description: `AI-generated ${niche} video: ${title || angle}`,
                niche,
                platforms: safePlatforms,
                status: 'failed',
                error: (error as Error).message,
              },
              updatedAt: new Date(),
            })
            .where(eq(schema.approvals.id, approvalId));
        } catch (updateErr) {
          console.error('[EmpireStudioController] Failed to update failed approval:', updateErr);
        }
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[EmpireStudioController] create failed:', error);
      // Try to return error, but response may already be sent
      try { res.status(500).json({ error: msg }); } catch {}
    }
  }

  /**
   * GET /api/studio/assets/campaign/:campaignId
   * Get all assets for a campaign.
   */
  async getCampaignAssets(req: Request, res: Response) {
    const userId = (req as any).userId;
    const campaignId = req.params.campaignId;

    if (typeof campaignId !== 'string') {
      return res.status(400).json({ error: 'campaignId must be a string' });
    }

    try {
      const assets = await empireStudioService.getCampaignAssets(userId, campaignId);
      res.json(assets);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  }

  /**
   * GET /api/studio/assets
   * Get all user assets.
   */
  async getUserAssets(req: Request, res: Response) {
    const userId = (req as any).userId;

    try {
      const assets = await empireStudioService.getUserAssets(userId);
      res.json(assets);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  }

  /**
   * GET /api/studio/assets/:assetId
   * Get a single asset by ID.
   */
  async getAssetById(req: Request, res: Response) {
    const assetId = req.params.assetId;

    if (typeof assetId !== 'string') {
      return res.status(400).json({ error: 'assetId must be a string' });
    }

    try {
      const asset = await empireStudioService.getAssetById(assetId);
      if (!asset) {
        res.status(404).json({ error: 'Asset not found' });
        return;
      }
      res.json(asset);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  }

  /**
   * POST /api/studio/preview
   * Generate a VisualSummary from DNA strand IDs or a raw manifest.
   * This lets the frontend show design 'vibe' previews before the user hits create.
   * 
   * Body options:
   * - { strandIds: string[] } — fetch strands from the Vault and summarize them
   * - { manifest: object } — pass a raw DnaStrand manifest directly
   * - { strandIds: string[], manifest: object } — combine both
   */
  async getPreview(req: Request, res: Response) {
    const userId = (req as any).userId;
    const { strandIds, manifest } = req.body;

    if (!strandIds && !manifest) {
      return res.status(400).json({
        error: 'Provide either strandIds (string[]) or manifest (object) to generate a preview',
      });
    }

    try {
      let visualSummary;

      if (Array.isArray(strandIds) && strandIds.length > 0) {
        // Fetch strands from the Vault
        const strands: DnaStrand[] = [];
        for (const id of strandIds) {
          const strand = await dnaVaultService.getStrand(id as string);
          if (strand) strands.push(strand);
        }

        if (strands.length === 0) {
          return res.status(404).json({ error: 'No strands found for the given IDs' });
        }

        visualSummary = await visualProxyService.summarizeMultiple(userId, strands);
      } else if (manifest) {
        // Create a stub DnaStrand from the raw manifest
        const stubStrand: DnaStrand = {
          category: manifest.category || 'layout',
          subCategory: manifest.subCategory || 'custom',
          manifest: manifest,
          performanceScore: manifest.performanceScore || 50,
          sourcePlatform: manifest.sourcePlatform || 'studio',
          metadata: manifest.metadata || { tags: ['custom'], brandTrait: 'user_defined' },
        };

        visualSummary = await visualProxyService.summarizeStrand(userId, stubStrand);
      }

      res.json(visualSummary);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[EmpireStudioController] preview failed:', error);
      res.status(500).json({ error: msg });
    }
  }
}

export const empireStudioController = new EmpireStudioController();