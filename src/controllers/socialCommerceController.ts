import { Request, Response } from 'express';
import { metaCatalogService } from '../services/metaCatalogService.js';
import { tiktokShopService } from '../services/tiktokShopService.js';
import { db } from '../db/index.js';
import { products } from '../db/sqlite-schema.js';
import { eq } from 'drizzle-orm';

export const syncMetaCatalog = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const { catalogId } = req.body;

    if (!catalogId) {
      return res.status(400).json({ error: 'catalogId is required' });
    }

    // Fetch user products from DB
    const userProducts = await db.select().from(products).where(eq(products.userId, userId));

    if (userProducts.length === 0) {
      return res.status(400).json({ error: 'No products found to sync' });
    }

    const result = await metaCatalogService.syncCatalog(userId, catalogId, userProducts);
    res.json(result);
  } catch (error: any) {
    console.error('Error syncing Meta catalog:', error);
    res.status(500).json({ error: error.message });
  }
};

export const syncTikTokShop = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';

    const userProducts = await db.select().from(products).where(eq(products.userId, userId));

    if (userProducts.length === 0) {
      return res.status(400).json({ error: 'No products found to sync' });
    }

    const result = await tiktokShopService.syncProducts(userId, userProducts);
    res.json(result);
  } catch (error: any) {
    console.error('Error syncing TikTok shop:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getMetaCatalogs = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const catalogs = await metaCatalogService.getCatalogs(userId);
    res.json(catalogs);
  } catch (error: any) {
    console.error('Error fetching Meta catalogs:', error);
    res.status(500).json({ error: error.message });
  }
};
