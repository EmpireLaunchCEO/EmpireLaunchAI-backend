import { Router, Request, Response } from 'express';
import { massDnaHarvester } from '../services/massDnaHarvestWorker.js';
import { dnaVaultService } from '../services/dnaVaultService.js';
import { canvaDnaHarvesterService } from '../services/canvaDnaHarvesterService.js';

const router = Router();

/**
 * GET /api/mass-dna/stats
 * Get real-time stats for the mass DNA ingestion worker.
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const workerStats = massDnaHarvester.getStats();
    const vaultStats = await dnaVaultService.getVaultStats();

    res.json({
      success: true,
      stats: {
        totalStrands: vaultStats.totalStrands,
        ingestionRunning: workerStats.isRunning,
        nichesProcessed: workerStats.nichesProcessed,
        nichesTotal: workerStats.nichesTotal,
        estimatedStorageMB: vaultStats.estimatedStorageMB,
        elapsedMs: workerStats.elapsedMs
      }
    });
  } catch (error: any) {
    console.error('[MassDnaRoute] Failed to fetch mass DNA stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve mass DNA ingestion stats' 
    });
  }
});

/**
 * POST /api/mass-dna/start
 * Manually trigger the mass DNA ingestion worker.
 */
router.post('/start', async (req: Request, res: Response) => {
  try {
    const stats = massDnaHarvester.getStats();
    if (stats.isRunning) {
      return res.status(400).json({ success: false, error: 'Worker is already running' });
    }

    // Start asynchronously
    massDnaHarvester.start();

    res.json({ success: true, message: 'Mass DNA harvest started' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/mass-dna/canva-gallery-harvest
 * Manually trigger the Canva gallery template DNA harvest.
 * Logs into Canva via Playwright using saved credentials and browses
 * trending templates across 14 categories (public + Pro).
 */
router.post('/canva-gallery-harvest', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.body.userId || 'system';
    res.json({ success: true, message: 'Canva gallery harvest starting...' });

    // Fire-and-forget: harvest runs asynchronously
    canvaDnaHarvesterService.harvestForUser(userId).then(result => {
      console.log(`[MassDnaRoute] Canva gallery harvest completed: ${result.totalStrands} strands`);
    }).catch(err => {
      console.error('[MassDnaRoute] Canva gallery harvest failed:', err.message);
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
