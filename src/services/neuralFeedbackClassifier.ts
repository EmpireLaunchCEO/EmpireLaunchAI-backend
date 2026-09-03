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
 * Extract the R2 object key from a URL.
 * R2 host form: https://<bucket>.<account>.r2.cloudflarestorage.com/<key> —
 * the bucket lives in the HOSTNAME, so the whole path is the key.
 * The legacy public-endpoint form https://<custom>/<bucket>/<key>/... may
 * include a bucket segment; for custom domains (no 'r2.cloudflarestorage.com')
 * we keep the whole path (client custom domains serve keys at path root).
 * Returns null for unparseable/empty input.
 */
export function r2KeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const pathParts = u.pathname.split('/').filter(Boolean);
    const key = decodeURIComponent(pathParts.join('/'));
    return key || null;
  } catch {
    return null;
  }
}