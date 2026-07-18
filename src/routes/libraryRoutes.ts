import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
import { eq, desc, and, sql } from 'drizzle-orm';

const router = Router();
const { libraryItems } = schema;

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** GET /api/library — List user's library items */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req.query.userId as string) || (req as any).userId || 'system';
    const type = req.query.type as string;
    const category = req.query.category as string;
    const favorite = req.query.favorite as string;

    let query = db.select().from(libraryItems).where(eq(libraryItems.userId, userId));

    if (type) query = query.where(eq(libraryItems.type, type));
    if (category) query = query.where(eq(libraryItems.category, category));
    if (favorite === 'true') query = query.where(eq(libraryItems.isFavorite, true));

    const items = await query.orderBy(desc(libraryItems.updatedAt)).limit(100);
    res.json({ items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/library — Add item to library */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.body.userId || 'system';
    const { name, description, type, category, tags, fileUrl, thumbnailUrl, sourceCreationId, sourceDnaStrandId, sourceStyleDnaId, metadata } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'name and type are required' });
    }

    const [item] = await db.insert(libraryItems).values({
      id: uuidv4(),
      userId,
      name,
      description,
      type,
      category,
      tags: tags || [],
      fileUrl,
      thumbnailUrl,
      sourceCreationId,
      sourceDnaStrandId,
      sourceStyleDnaId,
      metadata,
    }).returning();

    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** PUT /api/library/:id — Update library item */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, category, tags, isFavorite, isPublic, metadata } = req.body;
    const updateData: any = { updatedAt: new Date() };

    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (tags !== undefined) updateData.tags = tags;
    if (isFavorite !== undefined) updateData.isFavorite = isFavorite;
    if (isPublic !== undefined) updateData.isPublic = isPublic;
    if (metadata !== undefined) updateData.metadata = metadata;

    const [item] = await db.update(libraryItems)
      .set(updateData)
      .where(eq(libraryItems.id, req.params.id))
      .returning();

    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** DELETE /api/library/:id — Remove item from library */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await db.delete(libraryItems).where(eq(libraryItems.id, req.params.id));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Integration Hooks ──────────────────────────────────────────────────────

/** POST /api/library/save-from-creation — Save a creation to library */
router.post('/save-from-creation', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.body.userId || 'system';
    const { creationId } = req.body;
    if (!creationId) return res.status(400).json({ error: 'creationId required' });

    const [creation] = await db.select().from(schema.creations).where(eq(schema.creations.id, creationId)).limit(1);
    if (!creation) return res.status(404).json({ error: 'Creation not found' });

    const [item] = await db.insert(libraryItems).values({
      id: uuidv4(),
      userId,
      name: creation.title || 'Untitled',
      type: creation.type === 'design' ? 'design' : creation.type === 'facial_dna' ? 'image' : 'video',
      fileUrl: creation.fileUrl,
      thumbnailUrl: creation.thumbnailUrl,
      sourceCreationId: creationId,
      metadata: creation.metadata,
    }).returning();

    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/library/save-from-dna — Save a DNA strand to library */
router.post('/save-from-dna', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.body.userId || 'system';
    const { strandId } = req.body;
    if (!strandId) return res.status(400).json({ error: 'strandId required' });

    const [strand] = await db.select().from(schema.dnaStrands).where(eq(schema.dnaStrands.id, strandId)).limit(1);
    if (!strand) return res.status(404).json({ error: 'DNA strand not found' });

    const [item] = await db.insert(libraryItems).values({
      id: uuidv4(),
      userId,
      name: (strand.manifest as any)?.title || `DNA Strand ${strand.category}`,
      type: 'dna_strand',
      category: strand.category,
      sourceDnaStrandId: strandId,
      metadata: { manifest: strand.manifest, performanceScore: strand.performanceScore },
    }).returning();

    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** POST /api/library/bulk-import — Import multiple strands from DNA vault */
router.post('/bulk-import', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || req.body.userId || 'system';
    const { strandIds } = req.body;
    if (!strandIds || !Array.isArray(strandIds)) return res.status(400).json({ error: 'strandIds array required' });

    const strands = await db.select().from(schema.dnaStrands)
      .where(sql`${schema.dnaStrands.id} = ANY(${strandIds})`)
      .limit(200);

    const items = [];
    for (const strand of strands) {
      const [item] = await db.insert(libraryItems).values({
        id: uuidv4(),
        userId,
        name: (strand.manifest as any)?.title || `${strand.category} Strand`,
        type: 'dna_strand',
        category: strand.category,
        sourceDnaStrandId: strand.id,
        metadata: { manifest: strand.manifest, performanceScore: strand.performanceScore },
      }).onConflictDoNothing().returning();
      if (item) items.push(item);
    }

    res.json({ imported: items.length, items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
