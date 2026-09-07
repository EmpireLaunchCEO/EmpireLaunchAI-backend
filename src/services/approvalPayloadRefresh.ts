import { r2Storage } from './r2StorageService.js';
import { r2KeyFromUrl } from './neuralFeedbackClassifier.js';

/**
 * Re-sign a stored R2 presigned URL so it is fresh for immediate playback.
 * Mirrors `refreshR2Url` in src/routes/studioRoutes.ts — any non-R2 URL passes
 * through unchanged; any failure falls back to the stored URL. Key extraction
 * reuses the battle-tested `r2KeyFromUrl` (handles path-style + virtual-host R2).
 */
export async function refreshR2Url(storedUrl: string): Promise<string> {
  if (!storedUrl.includes('r2.cloudflarestorage.com')) return storedUrl;
  try {
    const key = r2KeyFromUrl(storedUrl);
    if (!key) return storedUrl;
    const fresh = await r2Storage.getSignedUrl(key);
    return fresh || storedUrl;
  } catch {
    return storedUrl; // fall back to stored URL on any failure
  }
}

/** URL-bearing string fields inside an approval payload. */
export const PAYLOAD_URL_FIELDS = ['videoUrl', 'thumbnailUrl', 'audioUrl', 'imageUrl', 'previewUrl'] as const;

/**
 * Return an approval payload copy with any R2-backed media URLs re-signed to
 * fresh, unexpired links. Non-R2 URLs and non-URL fields pass through untouched.
 */
export async function refreshApprovalPayloadUrls(payload: any): Promise<any> {
  if (!payload || typeof payload !== 'object') return payload;
  const out: any = { ...payload };
  for (const field of PAYLOAD_URL_FIELDS) {
    if (typeof out[field] === 'string') {
      out[field] = await refreshR2Url(out[field]);
    }
  }
  // Array-of-URL fields (e.g. Faceless screenshot source images)
  if (Array.isArray(out.sourceImages)) {
    out.sourceImages = await Promise.all(
      out.sourceImages.map((u: any) => (typeof u === 'string' ? refreshR2Url(u) : u))
    );
  }
  if (Array.isArray(out.images)) {
    out.images = await Promise.all(
      out.images.map((u: any) => (typeof u === 'string' ? refreshR2Url(u) : u))
    );
  }
  return out;
}