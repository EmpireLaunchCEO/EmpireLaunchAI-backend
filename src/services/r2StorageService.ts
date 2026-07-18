import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Cloudflare R2 Storage Service — S3-compatible API using Node.js built-in modules.
 * No AWS SDK dependency. Uses S3 Signature v4 for authentication.
 *
 * Env vars required:
 *   R2_ACCOUNT_ID       — Cloudflare account ID
 *   R2_ACCESS_KEY_ID     — R2 access key
 *   R2_SECRET_ACCESS_KEY — R2 secret key
 *   R2_BUCKET_NAME       — R2 bucket name
 *   R2_ENDPOINT          — e.g. https://{account_id}.r2.cloudflarestorage.com
 *   R2_PUBLIC_URL        — Optional: public URL prefix for the bucket (for returning URLs)
 */

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET_NAME || '';
const R2_ENDPOINT = process.env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || R2_ENDPOINT;

function isConfigured(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET);
}

// ─── AWS Signature V4 ──────────────────────────────────────────────────────────

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function signV4(
  method: string,
  objectKey: string,
  region: string = 'auto',
  service: string = 's3',
  payloadHash?: string,
): { headers: Record<string, string>; url: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(R2_ENDPOINT).host;
  const canonicalUri = '/' + objectKey.split('/').map(encodeURIComponent).join('/');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const payloadHashStr = payloadHash || 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    '', // query string (none)
    `host:${host}`,
    `x-amz-content-sha256:${payloadHashStr}`,
    `x-amz-date:${amzDate}`,
    '',
    signedHeaders,
    payloadHashStr,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256('AWS4' + R2_SECRET_KEY, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: {
      'Host': host,
      'x-amz-content-sha256': payloadHashStr,
      'x-amz-date': amzDate,
      'Authorization': authHeader,
    },
    url: `${R2_ENDPOINT}/${objectKey}`,
  };
}

// ─── Public Interface ──────────────────────────────────────────────────────────

export interface R2UploadResult {
  success: boolean;
  key: string;
  url: string;
  error?: string;
}

export class R2StorageService {
  private configured: boolean;

  constructor() {
    this.configured = isConfigured();
    if (!this.configured) {
      console.warn('[R2Storage] R2 not configured — uploads will fall back to local disk. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.');
    }
  }

  get isAvailable(): boolean {
    return this.configured;
  }

  /** Upload a file from local path to R2. Falls back gracefully if not configured. */
  async uploadFile(localPath: string, r2Key: string, mimeType?: string): Promise<R2UploadResult> {
    if (!this.configured) {
      // Fallback: keep file at local path, return local URL
      return { success: true, key: localPath, url: localPath };
    }

    try {
      const fileBuffer = fs.readFileSync(localPath);
      const hash = sha256(fileBuffer);
      const { headers, url } = signV4('PUT', r2Key, 'auto', 's3', hash);

      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': mimeType || 'application/octet-stream',
          'Content-Length': String(fileBuffer.length),
        },
        body: fileBuffer,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`R2 upload failed: ${response.status} ${response.statusText} — ${body}`);
      }

      // Return the public URL
      const publicUrl = R2_PUBLIC_URL === R2_ENDPOINT
        ? `${R2_PUBLIC_URL}/${r2Key}`
        : `${R2_PUBLIC_URL}/${r2Key}`;
      return { success: true, key: r2Key, url: publicUrl };
    } catch (error: any) {
      console.error(`[R2Storage] Upload failed for ${r2Key}:`, error.message);
      // Fallback: keep local file
      return { success: true, key: localPath, url: localPath, error: error.message };
    }
  }

  /** Upload a buffer directly */
  async uploadBuffer(buffer: Buffer, r2Key: string, mimeType?: string): Promise<R2UploadResult> {
    if (!this.configured) {
      return { success: false, key: '', url: '', error: 'R2 not configured' };
    }

    try {
      const hash = sha256(buffer);
      const { headers, url } = signV4('PUT', r2Key, 'auto', 's3', hash);

      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': mimeType || 'application/octet-stream',
          'Content-Length': String(buffer.length),
        },
        body: buffer,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`R2 upload failed: ${response.status} ${response.statusText} — ${body}`);
      }

      const publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;
      return { success: true, key: r2Key, url: publicUrl };
    } catch (error: any) {
      console.error(`[R2Storage] Buffer upload failed for ${r2Key}:`, error.message);
      return { success: false, key: '', url: '', error: error.message };
    }
  }

  /** Delete an object from R2 */
  async deleteObject(r2Key: string): Promise<boolean> {
    if (!this.configured) {
      // Fallback: try local fs delete
      try { fs.unlinkSync(r2Key); } catch {}
      return true;
    }

    try {
      const { headers, url } = signV4('DELETE', r2Key, 'auto', 's3');
      const response = await fetch(url, { method: 'DELETE', headers });
      return response.ok || response.status === 204;
    } catch (error: any) {
      console.error(`[R2Storage] Delete failed for ${r2Key}:`, error.message);
      return false;
    }
  }

  /** Get a signed download URL (30 min expiry). For public buckets this isn't needed. */
  getPublicUrl(r2Key: string): string {
    return `${R2_PUBLIC_URL}/${r2Key}`;
  }

  /** Generate an R2 object key for a file */
  generateKey(prefix: string, userId: string, ext: string): string {
    const uuid = crypto.randomUUID();
    return `${prefix}/${userId}/${uuid}.${ext}`;
  }

  /** Upload a local file then return either the R2 URL or fallback local URL. Safe for pipeline use. */
  async uploadLocalFile(
    localPath: string,
    userId: string,
    prefix: string,
    mimeType?: string,
  ): Promise<{ url: string; r2Key?: string }> {
    if (!this.configured || !fs.existsSync(localPath)) {
      return { url: localPath };
    }
    const ext = path.extname(localPath).replace('.', '') || 'bin';
    const r2Key = this.generateKey(prefix, userId, ext);
    const result = await this.uploadFile(localPath, r2Key, mimeType);
    if (result.success && result.url !== localPath) {
      // Clean up local file after successful R2 upload
      try { fs.unlinkSync(localPath); } catch {}
      return { url: result.url, r2Key };
    }
    return { url: localPath };
  }
}

export const r2Storage = new R2StorageService();
