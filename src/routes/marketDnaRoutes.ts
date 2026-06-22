import { Router, Request, Response } from 'express';
import { dnaVaultService } from '../services/dnaVaultService.js';

const router = Router();

/**
 * GET /api/market-dna/global
 * Retrieve all global Style DNA strands from viral market trends.
 */
router.get('/global', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const strands = await dnaVaultService.findGlobalStrands(limit);
    
    res.json({
      success: true,
      count: strands.length,
      strands
    });
  } catch (error: any) {
    console.error('[MarketDnaRoute] Failed to fetch global DNA:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve global market DNA pool' 
    });
  }
});

export default router;
