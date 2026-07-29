import { Router, Request, Response } from 'express';
import { etsyHarvesterService } from '../services/etsyHarvesterService.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

/**
 * POST /api/etsy/harvest
 * Manual trigger: harvests Etsy trend data for a niche and stores
 * results as DNA strands in the Global DNA Pool.
 *
 * Body: { niche: string }
 * Requires: Etsy integration connected in Link Center
 */
router.post('/harvest', mobileAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.headers['x-user-id'] as string;
    const { niche } = req.body;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!niche || typeof niche !== 'string') {
      return res.status(400).json({ error: 'niche (string) is required' });
    }

    console.log(`[EtsyRoutes] Starting harvest for user ${userId}, niche: ${niche}`);
    const result = await etsyHarvesterService.runHarvest(userId, niche);

    res.json({
      status: result.success ? 'success' : 'partial',
      strandsStored: result.strandsStored,
      keywords: result.keywords,
      listingsFound: result.listingsFound,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error: any) {
    console.error('[EtsyRoutes] Harvest failed:', error.message);
    res.status(500).json({ error: error.message || 'Harvest failed' });
  }
});

export default router;
