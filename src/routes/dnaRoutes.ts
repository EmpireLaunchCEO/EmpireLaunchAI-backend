import { Router, Request, Response } from 'express';
import { canvaDnaHarvesterService } from '../services/canvaDnaHarvesterService.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

const router = Router();

/**
 * POST /api/dna/harvest-canva
 * Triggers a full Canva DNA harvest across all 14 design categories.
 * Uses stored Canva credentials from the Neural Handshake.
 * 
 * Body (optional): { userId?: string } — defaults to the owner account
 */
router.post('/harvest-canva', async (req: Request, res: Response) => {
  try {
    const userId = req.body?.userId || '00000000-0000-0000-0000-000000000000';

    // Check if Canva credentials exist before starting
    const [integration] = await db.select()
      .from(schema.integrations)
      .where(eq(schema.integrations.platform, 'canva'))
      .limit(1);

    if (!integration || !integration.credentials) {
      return res.status(400).json({
        status: 'error',
        error: 'no_canva_integration',
        message: 'Canva credentials not found. Please link your Canva account through the Neural Link Center first.',
      });
    }

    // Trigger the harvest (this is async and may take a while)
    console.log(`[DNA Harvest] Starting Canva harvest for user ${userId}...`);

    const result = await canvaDnaHarvesterService.harvestForUser(userId);

    res.json({
      status: 'success',
      totalStrands: result.totalStrands,
      categoriesHarvested: result.categoriesHarvested,
      message: `Harvested ${result.totalStrands} DNA strands from ${result.categoriesHarvested}/14 categories.`,
    });
  } catch (error: any) {
    console.error('[DNA Harvest] Error:', error.message);

    if (error.message?.includes('No Canva integration found')) {
      return res.status(400).json({
        status: 'error',
        error: 'no_canva_integration',
        message: 'Canva credentials not found. Please link your Canva account through the Neural Link Center first.',
      });
    }

    res.status(500).json({
      status: 'error',
      error: 'harvest_failed',
      message: error.message || 'DNA harvest failed',
    });
  }
});

/**
 * GET /api/dna/harvest-canva/status
 * Check if Canva credentials exist before attempting a harvest.
 */
router.get('/harvest-canva/status', async (_req: Request, res: Response) => {
  try {
    const [integration] = await db.select()
      .from(schema.integrations)
      .where(eq(schema.integrations.platform, 'canva'))
      .limit(1);

    if (!integration) {
      return res.json({
        status: 'ready',
        canvaLinked: false,
        message: 'Canva is not linked. Use the Neural Link Center to connect your Canva account.',
      });
    }

    res.json({
      status: 'ready',
      canvaLinked: true,
      hasCredentials: !!integration.credentials,
      isActive: integration.isActive,
      platformAccountHandle: integration.platformAccountHandle || null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
