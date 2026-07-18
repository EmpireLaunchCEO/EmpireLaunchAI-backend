import { Router, Request, Response } from 'express';
import { libraryService } from '../services/libraryService.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

const router = Router();

// ─── GET /api/library/counts — Category counts ───────────────────────────────

router.get('/counts', async (req: Request, res: Response) => {
  try {
    const userId = (req.query.userId as string) || (req as any).userId || 'system';
    const brandId = req.query.brandId as string | undefined;
    const counts = await libraryService.getCounts(userId, brandId);
    res.json(counts);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/library/expired — Expired assets ────────────────────────────────

router.get('/expired', async (req: Request, res: Response) => {
  try {
    const userId = (req.query.userId as string) || (req as any).userId || 'system';
    const assets = await libraryService.getExpired(userId);
    res.json({ assets, total: assets.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/library/expired — Clean up expired assets ────────────────────

router.delete('/expired', async (req: Request, res: Response) => {
  try {
    const userId = (req.query.userId as string) || (req as any).userId || 'system';
    const deleted = await libraryService.cleanupExpired(userId);
    res.json({ deleted, message: `${deleted} expired asset(s) cleaned up` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/library — List assets (paginated) ───────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req.query.userId as string) || (req as any).userId || 'system';
    const type = req.query.type as string | undefined;
    const brandId = req.query.brandId as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const includeExpired = req.query.includeExpired === 'true';

    const result = await libraryService.list({ userId, brandId, type, page, limit, includeExpired });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/library — Create a library asset (integration hook) ────────────

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.body.userId || 'system';
    const { brandId, type, name, filePath, thumbnailPath, mimeType, fileSize, metadata } = req.body;

    if (!type || !filePath) {
      return res.status(400).json({ error: 'type and filePath are required' });
    }

    const asset = await libraryService.create({
      userId, brandId, type, name, filePath, thumbnailPath, mimeType, fileSize, metadata,
    });

    res.json({ asset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/library/:id — Single asset details ──────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const asset = await libraryService.getById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ asset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /api/library/:id/rename — Rename an asset ────────────────────────────

router.put('/:id/rename', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const asset = await libraryService.rename(req.params.id, name);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ asset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/library/:id/name — Set name (operations page naming flow) ──────

router.post('/:id/name', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const asset = await libraryService.setName(req.params.id, name);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ asset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/library/:id — Delete asset (file + DB) ───────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await libraryService.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Asset not found' });
    res.json({ success: true, message: 'Asset deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
