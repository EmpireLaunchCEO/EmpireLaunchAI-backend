import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Cloudflare R2 Storage Service — S3-compatible using @aws-sdk/client-s3.
 *
 * Env vars:
 *   CLOUDFLARE_ACCOUNT_ID          — Cloudflare account ID
 *   CLOUDFLARE_R2_ACCESS_KEY_ID     — R2 access key
 *   CLOUDFLARE_R2_SECRET_ACCESS_KEY — R2 secret key
 *   R2_BUCKET_NAME                  — R2 bucket name
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const ACCESS_KEY = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '';
const SECRET_KEY = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.R2_BUCKET_NAME || '';
const ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;

function isConfigured(): boolean {
  return !!(ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && BUCKET);
}

let s3Client: S3Client | null = null;
function getClient(): S3Client | null {
  if (!isConfigured()) return null;
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: ENDPOINT,
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface R2UploadResult {
  success: boolean;
  key?: string;
  url?: string;
  error?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class R2StorageService {
  get isAvailable(): boolean {
    return isConfigured();
  }

  /** Build a brand-isolated R2 object key: brands/{brandId}/{type}/{uuid}.{ext} */
  buildKey(brandId: string, type: string, ext?: string): string {
    const id = crypto.randomUUID();
    const suffix = ext ? `.${ext.replace(/^\./, '')}` : '';
    return `brands/${brandId}/${type}/${id}${suffix}`;
  }

  /** Upload a local file to R2. Returns the object key on success. */
  async uploadFile(localPath: string, brandId: string, type: string, mimeType?: string): Promise<R2UploadResult> {
    const client = getClient();
    if (!client) return { success: false, error: 'R2 not configured' };

    try {
      const ext = path.extname(localPath);
      const key = this.buildKey(brandId, type, ext);
      const fileBuffer = fs.readFileSync(localPath);

      await client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType || 'application/octet-stream',
      }));

      return { success: true, key };
    } catch (error: any) {
      console.error('[R2Storage] Upload failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /** Upload a buffer directly to R2. */
  async uploadBuffer(buffer: Buffer, key: string, mimeType?: string): Promise<R2UploadResult> {
    const client = getClient();
    if (!client) return { success: false, error: 'R2 not configured' };

    try {
      await client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimeType || 'application/octet-stream',
      }));

      return { success: true, key };
    } catch (error: any) {
      console.error('[R2Storage] Buffer upload failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /** Get a presigned download URL (default 1 hour expiry). */
  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string | null> {
    const client = getClient();
    if (!client) return null;

    try {
      return await getSignedUrl(client, new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }), { expiresIn });
    } catch (error: any) {
      console.error('[R2Storage] getSignedUrl failed:', error.message);
      return null;
    }
  }

  /** Get the raw public URL for an object (if bucket is public). */
  getFileUrl(key: string): string {
    // R2 public URLs follow the pattern: https://{bucket}.{account_id}.r2.cloudflarestorage.com/{key}
    // For custom domains with public buckets, use R2_PUBLIC_URL env var
    const publicBase = process.env.R2_PUBLIC_URL || `${ENDPOINT}/${BUCKET}`;
    return `${publicBase}/${key}`;
  }

  /** Delete an object from R2. */
  async deleteFile(key: string): Promise<boolean> {
    const client = getClient();
    if (!client) return false;

    try {
      await client.send(new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }));
      return true;
    } catch (error: any) {
      console.error('[R2Storage] Delete failed:', error.message);
      return false;
    }
  }

  /** Compatibility: upload a local file using userId + prefix. Uses userId as fallback brandId. */
  async uploadLocalFile(
    localPath: string,
    userId: string,
    prefix: string,
    mimeType?: string,
  ): Promise<{ url: string; r2Key?: string }> {
    if (!this.isAvailable || !fs.existsSync(localPath)) {
      return { url: localPath };
    }
    const ext = path.extname(localPath).replace('.', '') || 'bin';
    const key = this.buildKey(userId, prefix, ext);
    const result = await this.uploadFile(localPath, userId, prefix, mimeType);
    if (result.success && result.key) {
      const url = await this.getSignedUrl(result.key) || this.getFileUrl(result.key);
      try { fs.unlinkSync(localPath); } catch {}
      return { url, r2Key: result.key };
    }
    return { url: localPath };
  }
}

export const r2Storage = new R2StorageService();
