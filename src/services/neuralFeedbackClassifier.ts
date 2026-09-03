/**
 * Pure deterministic helpers for the Neural Feedback → auto-fix loop.
 * NO DB, NO network, NO AI — safe to import anywhere (including unit tests)
 * without touching the database or spending anything.
 */

export type FeedbackIntent = 'audio' | 'smoothness' | 'none';

/** Deterministic keyword classification (cheap, no LLM in the hot path). */
export function classifyFeedback(text: string): FeedbackIntent {
  const t = (text || '').toLowerCase();
  // Audio-bleed / voiceover complaints → AUDIO_REMIX
  // (loose stem matching: 'voice' matches 'voiceover', 'second voice')
  if (t.includes('audio') || t.includes('voice') || t.includes('sound') ||
      t.includes('narration') || t.includes('bleed') || t.includes('mute') ||
      t.includes('speaker') || t.includes('talking') || t.includes('speak')) {
    return 'audio';
  }
  // Choppy / judder / stutter / smoothness → SMOOTHNESS_REMIX
  // (loose: 'smooth' matches 'smoother', 'frame rate' matches 'framerate')
  if (t.includes('choppy') || t.includes('judder') || t.includes('stutter') ||
      t.includes('smooth') || t.includes('jitter') || t.includes('fps') ||
      t.includes('frame rate') || t.includes('framerate') || t.includes('jerky') ||
      t.includes('laggy') || t.includes('stuck') || t.includes('freeze')) {
    return 'smoothness';
  }
  return 'none';
}

/**
 * Extract the R2 object key from a stored URL (signed, public, custom domain).
 * Deterministic and env-free (no process.env reads) so it stays unit-testable.
 *
 * Handles BOTH R2 URL styles produced by this codebase (S3 client uses
 * forcePathStyle:true, so signed URLs are PATH-style):
 *
 * 1. PATH-STYLE (what prod video_scenes actually stores):
 *      https://<ACCOUNT_ID>.<ACCT>.r2.cloudflarestorage.com/<BUCKET>/<KEY>
 *    Cloudflare R2 account IDs are 32-hex (e.g. 2ac5a2e3cb490826386d96fe89d58ab4).
 *    When the hostname's first label is a 32-hex account ID, the FIRST path
 *    segment is the BUCKET and the rest is the object key → strip it.
 *    (Mirrors studioRoutes.extractR2Key's bucket-strip — proven against the
 *    production download proxy.)
 *
 * 2. VIRTUAL-HOST style:
 *      https://<BUCKET>.<ACCOUNT>.r2.cloudflarestorage.com/<KEY>
 *    (bucket in hostname, "abc123"-style non-hex first label) → whole path is key.
 *
 * 3. CUSTOM PUBLIC DOMAIN (no 'r2.cloudflarestorage.com'):
 *      https://<custom>/<KEY> → whole path is key (R2_PUBLIC_URL serves keys at
 *    the path root).
 *
 * Returns null for unparseable/empty input.
 */
export function r2KeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const pathParts = u.pathname.split('/').filter(Boolean);
    if (pathParts.length === 0) return null;
    const hostname = u.hostname;
    const firstLabel = hostname.split('.')[0] || '';
    // PATH-STYLE R2 endpoint: first host label is the 32-hex account id, so the
    // first path segment is the BUCKET and must be stripped from the key.
    if (hostname.endsWith('.r2.cloudflarestorage.com') && /^[a-f0-9]{32}$/i.test(firstLabel)) {
      return decodeURIComponent(pathParts.slice(1).join('/')) || null;
    }
    // VIRTUAL-HOST R2 or custom public domain: the whole path is the key.
    const key = decodeURIComponent(pathParts.join('/'));
    return key || null;
  } catch {
    return null;
  }
}