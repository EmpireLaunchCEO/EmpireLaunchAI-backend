import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
import { eq, and, desc, sql, count } from 'drizzle-orm';
import { r2Storage } from './r2StorageService.js';

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

  /** Create a library asset record. If R2 is available, uploads local file to R2 first. */
  async create(input: LibraryAssetInput) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRATION_DAYS * 24 * 60 * 60 * 1000);

    // If R2 is available and the file is local (not an http URL), upload it
    let finalPath = input.filePath;
    let finalThumbPath = input.thumbnailPath;

    if (r2Storage.isAvailable) {
      const ext = path.extname(input.filePath).replace('.', '') || 'mp4';
      const r2Key = r2Storage.generateKey('library', input.userId, ext);
      const uploaded = await r2Storage.uploadFile(input.filePath, r2Key, input.mimeType);
      if (uploaded.success && uploaded.url !== input.filePath) {
        finalPath = uploaded.url;
        // Remove local file after successful upload (keep only in R2)
        try { fs.unlinkSync(input.filePath); } catch {}
      }

      if (input.thumbnailPath && fs.existsSync(input.thumbnailPath)) {
        const thumbExt = path.extname(input.thumbnailPath).replace('.', '') || 'png';
        const thumbKey = r2Storage.generateKey('library/thumb', input.userId, thumbExt);
        const thumbUploaded = await r2Storage.uploadFile(input.thumbnailPath, thumbKey, 'image/' + thumbExt);
        if (thumbUploaded.success && thumbUploaded.url !== input.thumbnailPath) {
          finalThumbPath = thumbUploaded.url;
          try { fs.unlinkSync(input.thumbnailPath); } catch {}
        }
      }
    }

    const fileSize = input.fileSize || (fs.existsSync(input.filePath) ? fs.statSync(input.filePath).size : undefined);

    const [asset] = await db.insert(libraryAssets).values({
      id: uuidv4(),
      userId: input.userId,
      brandId: input.brandId || null,
      type: input.type,
      name: input.name || this.defaultName(input.type),
      filePath: finalPath,
      thumbnailPath: finalThumbPath || null,
      mimeType: input.mimeType || null,
      fileSize: fileSize || null,
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

  /** Delete asset — removes file (local + R2) + DB record */
  async delete(id: string): Promise<boolean> {
    const [asset] = await db.select().from(libraryAssets).where(eq(libraryAssets.id, id)).limit(1);
    if (!asset) return false;

    // Remove from R2 if available (extract key from URL)
    if (r2Storage.isAvailable && asset.filePath) {
      const r2Key = this.extractKeyFromUrl(asset.filePath);
      if (r2Key) await r2Storage.deleteObject(r2Key);
    }
    if (r2Storage.isAvailable && asset.thumbnailPath) {
      const thumbKey = this.extractKeyFromUrl(asset.thumbnailPath);
      if (thumbKey) await r2Storage.deleteObject(thumbKey);
    }

    // Remove local files
    try { if (asset.filePath && fs.existsSync(asset.filePath)) fs.unlinkSync(asset.filePath); } catch {}
    try { if (asset.thumbnailPath && fs.existsSync(asset.thumbnailPath)) fs.unlinkSync(asset.thumbnailPath); } catch {}

    await db.delete(libraryAssets).where(eq(libraryAssets.id, id));
    return true;
  }

  /** Extract R2 object key from a stored URL */
  private extractKeyFromUrl(url: string): string | null {
    if (!url.startsWith('http')) return null;
    try {
      const u = new URL(url);
      return u.pathname.replace(/^\//, '');
    } catch {
      return null;
    }
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

  /** Clean up expired assets (delete from local + R2 + DB) */
  async cleanupExpired(userId: string): Promise<number> {
    const expired = await this.getExpired(userId);
    let deleted = 0;
    for (const asset of expired) {
      // Remove from R2
      if (r2Storage.isAvailable && asset.filePath) {
        const r2Key = this.extractKeyFromUrl(asset.filePath);
        if (r2Key) await r2Storage.deleteObject(r2Key);
      }
      if (r2Storage.isAvailable && asset.thumbnailPath) {
        const thumbKey = this.extractKeyFromUrl(asset.thumbnailPath);
        if (thumbKey) await r2Storage.deleteObject(thumbKey);
      }
      // Remove local files
      try { if (asset.filePath && fs.existsSync(asset.filePath)) fs.unlinkSync(asset.filePath); } catch {}
      try { if (asset.thumbnailPath && fs.existsSync(asset.thumbnailPath)) fs.unlinkSync(asset.thumbnailPath); } catch {}
      await db.delete(libraryAssets).where(eq(libraryAssets.id, asset.id));
      deleted++;
    }
    return deleted;
  }
}

export const libraryService = new LibraryService();
