import { Router, Request, Response } from 'express';
import { etsyHarvesterService } from '../services/etsyHarvesterService.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

/**
 * POST /api/etsy/harvest
 * On-demand: harvests Etsy trend data for a niche and stores
 * results as DNA strands in the Global DNA Pool.
 *
 * Body: { niche: string }
 * Rate-limited at 4,500 calls/day (90% of 5K Etsy quota).
 */
router.post('/harvest', mobileAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.headers['x-user-id'] as string;
    const { niche } = req.body;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!niche || typeof niche !== 'string') {
      return res.status(400).json({ error: 'niche (string) is required' });
    }

    // Check rate limit before starting
    const rateStatus = etsyHarvesterService.getRateLimitStatus();
    if (rateStatus === 'blocked') {
      const usage = etsyHarvesterService.getDailyUsage();
      return res.status(429).json({
        error: 'Trend data temporarily limited — upgrading soon.',
        rateLimited: true,
        dailyCallsUsed: usage.count,
        dailyCallsLimit: usage.limit,
      });
    }

    console.log(`[EtsyRoutes] Starting harvest for user ${userId}, niche: ${niche}`);
    const result = await etsyHarvesterService.runHarvest(userId, niche);

    res.json({
      status: result.success ? 'success' : 'partial',
      strandsStored: result.strandsStored,
      keywords: result.keywords,
      listingsFound: result.listingsFound,
      errors: result.errors.length > 0 ? result.errors : undefined,
      rateLimited: result.rateLimited,
      dailyCallsUsed: result.dailyCallsUsed,
      dailyCallsLimit: result.dailyCallsLimit,
    });
  } catch (error: any) {
    console.error('[EtsyRoutes] Harvest failed:', error.message);
    res.status(500).json({ error: error.message || 'Harvest failed' });
  }
});

/**
 * GET /api/etsy/usage
 * Returns current daily Etsy API usage stats.
 */
router.get('/usage', mobileAuth, async (_req: Request, res: Response) => {
  try {
    const usage = etsyHarvesterService.getDailyUsage();
    const status = etsyHarvesterService.getRateLimitStatus();
    res.json({
      ...usage,
      status,
      isConfigured: etsyHarvesterService.isConfigured,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
