import { Request, Response } from 'express';
import { empireStudioService, StyleDNA } from '../services/empireStudioService.js';
import { visualProxyService } from '../services/visualProxyService.js';
import { dnaVaultService, DnaStrand } from '../services/dnaVaultService.js';

export class EmpireStudioController {
  /**
   * POST /api/studio/create
   * Create a master asset and distribute to selected platforms.
   */
  async create(req: Request, res: Response) {
    const userId = (req as any).userId;
    const {
      campaignId,
      niche,
      angle,
      styleDna,
      platforms,
      title,
      description,
      price,
      scheduleInMinutes,
    } = req.body;

    if (!niche || !angle || !styleDna || !platforms || !Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: niche, angle, styleDna, platforms (non-empty array)',
      });
    }

    // Validate StyleDNA
    if (!styleDna.colors || !styleDna.fonts || !styleDna.hooks || !styleDna.keywords || !styleDna.tone) {
      return res.status(400).json({
        error: 'styleDna must include: colors, fonts, hooks, keywords, tone',
      });
    }

    // Validate platforms
    const validPlatforms = ['tiktok', 'instagram', 'youtube', 'facebook'];
    for (const p of platforms) {
      if (!validPlatforms.includes(p)) {
        return res.status(400).json({
          error: `Invalid platform: ${p}. Valid options: ${validPlatforms.join(', ')}`,
        });
      }
    }

    try {
      const result = await empireStudioService.createAndDistribute({
        userId,
        campaignId,
        niche,
        angle,
        styleDna: styleDna as StyleDNA,
        platforms,
        title,
        description,
        price,
        scheduleInMinutes,
      });

      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[EmpireStudioController] create failed:', error);
      res.status(500).json({ error: msg });
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