import { Router, Request, Response } from 'express';
import { dnaVaultService, DnaStrand } from '../services/dnaVaultService.js';

const router = Router();

/**
 * POST /api/vault/strand
 * Store a new DNA strand in the vault
 */
router.post('/strand', async (req: Request, res: Response) => {
  try {
    const strand: DnaStrand = req.body;
    const id = await dnaVaultService.storeStrand(strand);
    res.json({ id, status: 'stored' });
  } catch (error: any) {
    console.error('[VaultRoute] Store failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/vault/bulk
 * Bulk store multiple strands
 */
router.post('/bulk', async (req: Request, res: Response) => {
  try {
    const strands: DnaStrand[] = req.body.strands;
    const count = await dnaVaultService.bulkStore(strands);
    res.json({ stored: count, status: 'completed' });
  } catch (error: any) {
    console.error('[VaultRoute] Bulk store failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/vault/strand/:id
 * Retrieve a strand by ID
 */
router.get('/strand/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const strand = await dnaVaultService.getStrand(id);
    if (!strand) {
      res.status(404).json({ error: 'Strand not found' });
      return;
    }
    res.json(strand);
  } catch (error: any) {
    console.error('[VaultRoute] Get failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/vault/similar
 * Find similar strands by embedding vector
 */
router.post('/similar', async (req: Request, res: Response) => {
  try {
    const { embedding, category, limit } = req.body;
    const results = await dnaVaultService.findSimilar(embedding, category, limit || 10);
    res.json({ results, count: results.length });
  } catch (error: any) {
    console.error('[VaultRoute] Similar search failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/vault/top-performers/:category
 * Get top-performing strands by category
 */
router.get('/top-performers/:category', async (req: Request, res: Response) => {
  try {
    const category = req.params.category as string;
    const minScore = parseInt(req.query.minScore as string) || 70;
    const limit = parseInt(req.query.limit as string) || 20;
    const strands = await dnaVaultService.findTopPerformers(category, minScore, limit);
    res.json({ strands, count: strands.length });
  } catch (error: any) {
    console.error('[VaultRoute] Top performers failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/vault/source/:platform
 * Get strands by source platform
 */
router.get('/source/:platform', async (req: Request, res: Response) => {
  try {
    const platform = req.params.platform as string;
    const category = req.query.category as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const strands = await dnaVaultService.findBySource(platform, category, limit);
    res.json({ strands, count: strands.length });
  } catch (error: any) {
    console.error('[VaultRoute] Source search failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/vault/stats
 * Get vault statistics (storage budget, counts by category)
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await dnaVaultService.getVaultStats();
    res.json(stats);
  } catch (error: any) {
    console.error('[VaultRoute] Stats failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/vault/seed
 * Seed the vault with premium archetype strands
 */
router.post('/seed', async (_req: Request, res: Response) => {
  try {
    const count = await dnaVaultService.seedPremiumArchetypes();
    res.json({ seeded: count, status: 'completed' });
  } catch (error: any) {
    console.error('[VaultRoute] Seed failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/vault/strand/:id/score
 * Update a strand's performance score
 */
router.patch('/strand/:id/score', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { score } = req.body;
    await dnaVaultService.updatePerformanceScore(id, score);
    res.json({ status: 'updated' });
  } catch (error: any) {
    console.error('[VaultRoute] Score update failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/vault/strand/:id
 * Delete a strand
 */
router.delete('/strand/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await dnaVaultService.deleteStrand(id);
    res.json({ status: 'deleted' });
  } catch (error: any) {
    console.error('[VaultRoute] Delete failed:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;