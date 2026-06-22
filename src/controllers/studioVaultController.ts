import { Request, Response } from 'express';
import { dnaVaultService } from '../services/dnaVaultService.js';
import { visualProxyService } from '../services/visualProxyService.js';

/**
 * Studio Vault Controller
 * 
 * Serves AI-Synthesized DNA strands and their VisualSummaries to the Studio page.
 * Every strand returned is marked as isSynthesized=true — meaning it's an original
 * AI-generated derivative, NOT a copy of any source platform content.
 * 
 * The frontend uses these to populate the Inspiration Gallery with unique previews.
 */
export class StudioVaultController {

  /**
   * GET /api/studio/vault
   * Returns AI-Synthesized strands from all categories, enriched with VisualSummary.
   * 
   * Query params:
   *   category  - Filter by strand category (optional)
   *   limit     - Max results (default 20, max 50)
   *   minScore  - Minimum performance score (default 60)
   */
  async getSynthesizedStrands(req: Request, res: Response) {
    const userId = (req as any).userId;
    const category = req.query.category as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const minScore = parseInt(req.query.minScore as string) || 60;

    try {
      let strands;

      if (category) {
        strands = await dnaVaultService.findTopPerformers(category, minScore, limit);
      } else {
        // Fetch from each category and merge
        const categories = ['layout', 'palette', 'typography', 'niche_pattern', 'avatar', 'animal', 'background'];
        const results = await Promise.all(
          categories.map(cat =>
            dnaVaultService.findTopPerformers(cat, minScore, Math.ceil(limit / categories.length))
          )
        );
        strands = results.flat();
        // Sort by performance score and trim
        strands.sort((a: any, b: any) => (b.performanceScore || 0) - (a.performanceScore || 0));
        strands = strands.slice(0, limit);
      }

      // Enrich with VisualSummary for instant preview rendering
      const enriched = await Promise.all(
        strands.map(async (strand: any) => {
          try {
            const visual = await visualProxyService.summarizeStrand(userId, strand);
            return {
              ...strand,
              visualSummary: visual,
              // Frontend badge data
              badge: 'AI-Synthesized',
              badgeType: 'original',
            };
          } catch {
            return {
              ...strand,
              visualSummary: null,
              badge: 'AI-Synthesized',
              badgeType: 'original',
            };
          }
        })
      );

      res.json({
        strands: enriched,
        count: enriched.length,
        totalInVault: strands.length,
        synthesized: true,
        label: 'AI-Synthesized DNA — original designs inspired by trend intelligence',
      });
    } catch (error: any) {
      console.error('[StudioVaultController] getSynthesizedStrands failed:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/studio/vault/search
   * Search vault strands by category/niche.
   */
  async searchVault(req: Request, res: Response) {
    const userId = (req as any).userId;
    const category = req.query.category as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const minScore = parseInt(req.query.minScore as string) || 50;

    try {
      if (!category) {
        return res.status(400).json({ error: 'category query parameter is required' });
      }

      const strands = await dnaVaultService.findTopPerformers(category, minScore, limit);

      const enriched = await Promise.all(
        strands.map(async (strand: any) => {
          try {
            const visual = await visualProxyService.summarizeStrand(userId, strand);
            return { ...strand, visualSummary: visual, badge: 'AI-Synthesized', badgeType: 'original' };
          } catch {
            return { ...strand, visualSummary: null, badge: 'AI-Synthesized', badgeType: 'original' };
          }
        })
      );

      res.json({
        strands: enriched,
        count: enriched.length,
        category,
        synthesized: true,
        label: 'AI-Synthesized DNA',
      });
    } catch (error: any) {
      console.error('[StudioVaultController] searchVault failed:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

export const studioVaultController = new StudioVaultController();