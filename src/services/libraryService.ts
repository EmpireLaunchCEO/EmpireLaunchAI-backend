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
  brandId: string;
  type: 'video' | 'twin_video' | 'edit' | 'faceless' | 'design';
  name?: string;
  filePath: string; // R2 key or local path
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

  private defaultName(type: string): string {
    const label = type === 'twin_video' ? 'Neural Twin' :
      type === 'faceless' ? 'Faceless Video' :
      type === 'edit' ? 'Edited Video' :
      type === 'design' ? 'Design' : 'Video';
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${label} - ${date}`;
  }

  /** Compute local file storage path (fallback when R2 is unavailable). */
  storagePath(userId: string, type: string, ext: string): string {
    const dir = path.join(this.baseDir, type, userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${uuidv4()}.${ext}`);
  }

  /** Upload a file buffer to R2 and create a library asset record. */
  async uploadAndCreate(
    buffer: Buffer,
    mimeType: string,
    brandId: string,
    userId: string,
    type: LibraryAssetInput['type'],
    name?: string,
    metadata?: Record<string, any>,
  ) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRATION_DAYS * 24 * 60 * 60 * 1000);

    let filePath: string;
    let fileSize: number;

    if (r2Storage.isAvailable) {
      // Upload to R2, store the object key
      const ext = mimeType.split('/')[1] || 'bin';
      const key = r2Storage.buildKey(brandId, type, ext);
      const result = await r2Storage.uploadBuffer(buffer, key, mimeType);
      if (!result.success) throw new Error(result.error || 'R2 upload failed');
      filePath = key;
      fileSize = buffer.length;
    } else {
      // Fallback: write to local disk
      const ext = mimeType.split('/')[1] || 'bin';
      const localPath = this.storagePath(userId, type, ext);
      fs.writeFileSync(localPath, buffer);
      filePath = localPath;
      fileSize = buffer.length;
    }

    const [asset] = await db.insert(libraryAssets).values({
      id: uuidv4(),
      userId,
      brandId: brandId || null,
      type,
      name: name || this.defaultName(type),
      filePath,
      thumbnailPath: null,
      mimeType,
      fileSize,
      metadata: metadata || {},
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }).returning();

    return asset;
  }

  /** Create a library asset record from an existing local file. Uploads to R2 if available. */
  async create(input: LibraryAssetInput) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRATION_DAYS * 24 * 60 * 60 * 1000);

    let finalKey = input.filePath;
    let finalThumb = input.thumbnailPath;

    if (r2Storage.isAvailable) {
      // If filePath is a local path (not already an R2 key), upload it
      if (!input.filePath.startsWith('brands/') && fs.existsSync(input.filePath)) {
        const ext = path.extname(input.filePath).replace('.', '') || 'mp4';
        const brandId = input.brandId || 'unknown';
        const result = await r2Storage.uploadFile(input.filePath, brandId, input.type, input.mimeType);
        if (result.success && result.key) {
          finalKey = result.key;
          try { fs.unlinkSync(input.filePath); } catch {}
        }
      }

      if (input.thumbnailPath && !input.thumbnailPath.startsWith('brands/') && fs.existsSync(input.thumbnailPath)) {
        const thumbExt = path.extname(input.thumbnailPath).replace('.', '') || 'png';
        const brandId = input.brandId || 'unknown';
        const thumbResult = await r2Storage.uploadFile(input.thumbnailPath, brandId, 'thumb', 'image/' + thumbExt);
        if (thumbResult.success && thumbResult.key) {
          finalThumb = thumbResult.key;
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
      filePath: finalKey,
      thumbnailPath: finalThumb || null,
      mimeType: input.mimeType || null,
      fileSize: fileSize || null,
      metadata: input.metadata || {},
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }).returning();

    return asset;
  }

  /** Resolve a stored filePath (R2 key or local path) to a presigned URL for download. */
  private async resolveUrl(storedPath: string | null): Promise<string | null> {
    if (!storedPath) return null;
    if (storedPath.startsWith('http')) return storedPath;
    if (storedPath.startsWith('brands/') && r2Storage.isAvailable) {
      return await r2Storage.getSignedUrl(storedPath) || r2Storage.getFileUrl(storedPath);
    }
    // Local path — return as-is (served by Express static)
    return storedPath;
  }

  /** List assets with pagination and filters. Returns presigned URLs. */
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

    const rows = await db.select()
      .from(libraryAssets)
      .where(whereClause)
      .orderBy(desc(libraryAssets.createdAt))
      .limit(limit)
      .offset(offset);

    // Resolve file paths to presigned URLs
    const assets = await Promise.all(rows.map(async (row) => ({
      ...row,
      filePath: await this.resolveUrl(row.filePath),
      thumbnailPath: await this.resolveUrl(row.thumbnailPath),
    })));

    return { assets, total, page, limit };
  }

  /** Get single asset with presigned URLs. */
  async getById(id: string) {
    const [asset] = await db.select().from(libraryAssets).where(eq(libraryAssets.id, id)).limit(1);
    if (!asset) return null;

    return {
      ...asset,
      filePath: await this.resolveUrl(asset.filePath),
      thumbnailPath: await this.resolveUrl(asset.thumbnailPath),
    };
  }

  /** Rename an asset. */
  async rename(id: string, name: string) {
    const [asset] = await db.update(libraryAssets)
      .set({ name, updatedAt: new Date() })
      .where(eq(libraryAssets.id, id))
      .returning();
    return asset || null;
  }

  async setName(id: string, name: string) {
    return this.rename(id, name);
  }

  /** Delete asset — removes from R2 first, then local disk, then DB. */
  async delete(id: string): Promise<boolean> {
    const [asset] = await db.select().from(libraryAssets).where(eq(libraryAssets.id, id)).limit(1);
    if (!asset) return false;

    // Remove from R2 first
    if (r2Storage.isAvailable) {
      if (asset.filePath?.startsWith('brands/')) await r2Storage.deleteFile(asset.filePath);
      if (asset.thumbnailPath?.startsWith('brands/')) await r2Storage.deleteFile(asset.thumbnailPath);
    }

    // Clean up local fallback files
    try { if (asset.filePath && fs.existsSync(asset.filePath)) fs.unlinkSync(asset.filePath); } catch {}
    try { if (asset.thumbnailPath && fs.existsSync(asset.thumbnailPath)) fs.unlinkSync(asset.thumbnailPath); } catch {}

    await db.delete(libraryAssets).where(eq(libraryAssets.id, id));
    return true;
  }

  /** Get counts by type for category boxes. Filters by brandId. */
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

  async getExpired(userId: string) {
    return db.select()
      .from(libraryAssets)
      .where(and(
        eq(libraryAssets.userId, userId),
        sql`${libraryAssets.expiresAt} <= NOW()`,
      ))
      .orderBy(desc(libraryAssets.expiresAt));
  }

  async cleanupExpired(userId: string): Promise<number> {
    const expired = await this.getExpired(userId);
    let deleted = 0;
    for (const asset of expired) {
      if (r2Storage.isAvailable) {
        if (asset.filePath?.startsWith('brands/')) await r2Storage.deleteFile(asset.filePath);
        if (asset.thumbnailPath?.startsWith('brands/')) await r2Storage.deleteFile(asset.thumbnailPath);
      }
      try { if (asset.filePath && fs.existsSync(asset.filePath)) fs.unlinkSync(asset.filePath); } catch {}
      try { if (asset.thumbnailPath && fs.existsSync(asset.thumbnailPath)) fs.unlinkSync(asset.thumbnailPath); } catch {}
      await db.delete(libraryAssets).where(eq(libraryAssets.id, asset.id));
      deleted++;
    }
    return deleted;
  }
}

export const libraryService = new LibraryService();
