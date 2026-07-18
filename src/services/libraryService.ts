import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
import { eq, and, desc, sql, count } from 'drizzle-orm';

const { libraryAssets } = schema;
const EXPIRATION_DAYS = 90;

export interface LibraryAssetInput {
  userId: string;
  brandId?: string;
  type: 'video' | 'twin_video' | 'edit' | 'faceless' | 'design';
  name?: string;
  filePath: string;
  thumbnailPath?: string;
  mimeType?: string;
  fileSize?: number;
  metadata?: Record<string, any>;
}

export class LibraryService {
  private baseDir: string;

  constructor() {
    this.baseDir = path.join(process.cwd(), 'public', 'assets', 'library');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /** Generate default name: "Video Design - Jul 17, 2026" */
  private defaultName(type: string): string {
    const label = type === 'twin_video' ? 'Neural Twin' :
      type === 'faceless' ? 'Faceless Video' :
      type === 'edit' ? 'Edited Video' :
      type === 'design' ? 'Design' : 'Video';
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${label} - ${date}`;
  }

  /** Compute file storage path */
  storagePath(userId: string, type: string, ext: string): string {
    const dir = path.join(this.baseDir, type, userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${uuidv4()}.${ext}`);
  }

  /** Create a library asset record */
  async create(input: LibraryAssetInput) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRATION_DAYS * 24 * 60 * 60 * 1000);

    const [asset] = await db.insert(libraryAssets).values({
      id: uuidv4(),
      userId: input.userId,
      brandId: input.brandId || null,
      type: input.type,
      name: input.name || this.defaultName(input.type),
      filePath: input.filePath,
      thumbnailPath: input.thumbnailPath || null,
      mimeType: input.mimeType || null,
      fileSize: input.fileSize || null,
      metadata: input.metadata || {},
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }).returning();

    return asset;
  }

  /** List assets with pagination and filters */
  async list(params: {
    userId: string;
    brandId?: string;
    type?: string;
    page?: number;
    limit?: number;
    includeExpired?: boolean;
  }) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const offset = (page - 1) * limit;

    let conditions = [eq(libraryAssets.userId, params.userId)];
    if (params.brandId) conditions.push(eq(libraryAssets.brandId, params.brandId));
    if (params.type) conditions.push(eq(libraryAssets.type, params.type as any));
    if (!params.includeExpired) {
      conditions.push(sql`${libraryAssets.expiresAt} > NOW()`);
    }

    const whereClause = and(...conditions);

    const [result] = await db.select({ value: count() }).from(libraryAssets).where(whereClause);
    const total = (result as any)?.value || 0;

    const assets = await db.select()
      .from(libraryAssets)
      .where(whereClause)
      .orderBy(desc(libraryAssets.createdAt))
      .limit(limit)
      .offset(offset);

    return { assets, total, page, limit };
  }

  /** Get single asset */
  async getById(id: string) {
    const [asset] = await db.select().from(libraryAssets).where(eq(libraryAssets.id, id)).limit(1);
    return asset || null;
  }

  /** Rename an asset */
  async rename(id: string, name: string) {
    const [asset] = await db.update(libraryAssets)
      .set({ name, updatedAt: new Date() })
      .where(eq(libraryAssets.id, id))
      .returning();
    return asset || null;
  }

  /** Set name (for operations page naming flow) */
  async setName(id: string, name: string) {
    return this.rename(id, name);
  }

  /** Delete asset — removes file + DB record */
  async delete(id: string): Promise<boolean> {
    const [asset] = await db.select().from(libraryAssets).where(eq(libraryAssets.id, id)).limit(1);
    if (!asset) return false;

    // Remove files from disk
    try { if (asset.filePath) fs.unlinkSync(asset.filePath); } catch {}
    try { if (asset.thumbnailPath) fs.unlinkSync(asset.thumbnailPath); } catch {}

    await db.delete(libraryAssets).where(eq(libraryAssets.id, id));
    return true;
  }

  /** Get counts by type for the 5 category boxes */
  async getCounts(userId: string, brandId?: string) {
    const types = ['video', 'twin_video', 'edit', 'faceless', 'design'] as const;
    const result: Record<string, number> = {};

    for (const type of types) {
      let conditions = [eq(libraryAssets.userId, userId), eq(libraryAssets.type, type), sql`${libraryAssets.expiresAt} > NOW()`];
      if (brandId) conditions.push(eq(libraryAssets.brandId, brandId));
      const [row] = await db.select({ value: count() }).from(libraryAssets).where(and(...conditions));
      result[type] = (row as any)?.value || 0;
    }

    return result;
  }

  /** Get expired assets */
  async getExpired(userId: string) {
    return db.select()
      .from(libraryAssets)
      .where(and(
        eq(libraryAssets.userId, userId),
        sql`${libraryAssets.expiresAt} <= NOW()`,
      ))
      .orderBy(desc(libraryAssets.expiresAt));
  }

  /** Clean up expired assets (delete files + records) */
  async cleanupExpired(userId: string): Promise<number> {
    const expired = await this.getExpired(userId);
    let deleted = 0;
    for (const asset of expired) {
      try { if (asset.filePath) fs.unlinkSync(asset.filePath); } catch {}
      try { if (asset.thumbnailPath) fs.unlinkSync(asset.thumbnailPath); } catch {}
      await db.delete(libraryAssets).where(eq(libraryAssets.id, asset.id));
      deleted++;
    }
    return deleted;
  }
}

export const libraryService = new LibraryService();
