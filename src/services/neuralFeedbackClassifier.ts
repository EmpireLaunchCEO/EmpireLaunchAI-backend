/**
 * Pure deterministic helpers for the Neural Feedback → auto-fix loop.
 * NO DB, NO network, NO AI — safe to import anywhere (including unit tests)
 * without touching the database or spending anything.
 */

export type FeedbackIntent = 'audio' | 'smoothness' | 'line_change' | 'none';

export interface LineChangeMatch {
  /** Explicit scene number if the user named one (e.g. "scene 3 line"). */
  sceneNumber?: number;
  /** Old text the user quoted / wants replaced (may be undefined). */
  oldText?: string;
  /** The NEW text the line should say (replacement). */
  newText?: string;
}

/** Deterministic keyword classification (cheap, no LLM in the hot path). */
export function classifyFeedback(text: string): FeedbackIntent {
  const t = (text || '').toLowerCase();
  // ── LINE_CHANGE (checked FIRST: "change this line to X", "line should say", etc.
  //    must win over the generic 'audio'/'smoothness' buckets that share words
  //    like "say"/"line" with no audio/smoothness signal). ──
  if (/line|reword|rewrite|say .* instead|replace .* with|change .* to say|edit the script|fix the script|fix .* line/.test(t)) {
    // But "fix the audio" / "fix the line audio" stays AUDIO; a pure line edit
    // means the user is changing WORDS, not complaining about sound.
    const hasAudioBleed = t.includes('audio') || t.includes('voice') || t.includes('sound') || t.includes('bleed');
    const hasSmoothness = t.includes('choppy') || t.includes('judder') || t.includes('stutter') ||
      t.includes('smooth') || t.includes('jitter') || t.includes('fps') || t.includes('frame rate') ||
      t.includes('jerky') || t.includes('laggy') || t.includes('stuck') || t.includes('freeze');
    if (!hasAudioBleed && !hasSmoothness) {
      return 'line_change';
    }
  }
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
 * Parse a LINE_CHANGE request into { sceneNumber?, oldText?, newText? }.
 * Deterministic regex extraction — NEVER guesses; returns a best-effort parse.
 * Patterns supported (per design LINE_CHANGE_LIP_SYNC_DESIGN.md, task 6428c854):
 *   - "scene 3 line should say X" / "change scene 2's line to X"
 *   - "change this line to X" / "change the line to X"
 *   - "this line: OLD I want NEW" / "replace 'OLD' with 'NEW'"
 *   - "say X instead (of) Y" / "instead of OLD say NEW"
 */
export function parseLineChange(text: string): LineChangeMatch {
  const t = (text || '').trim();
  if (!t) return {};
  // Explicit scene number: "scene 3", "scene 2's", "line 4", "scene N line"
  let sceneNumber: number | undefined;
  const sceneMatch = t.match(/\bscene\s*([1-9]\d*)\b/i) || t.match(/\bline\s*([1-9]\d*)\b/i);
  if (sceneMatch && sceneMatch[1]) sceneNumber = parseInt(sceneMatch[1], 10);

  // NEW text extraction (replacement) — try the strongest patterns first.
  // Robust strategy: skip an optional quoted OLD phrase, then capture the text
  // that FOLLOWS the command ("to …", "instead of OLD say NEW", "I want …").
  let newText: string | undefined;
  // "change the line to X" / "change the line "OLD" to X" / "line should say X"
  const toMatch = t.match(/(?:change|replace|edit|make|have|want)\s+(?:this\s+)?(?:the\s+)?line\s*(?:["'“”][^"'“”]*["'“”]\s*)?(?:to|should\s+say|say)\s+["'“”]?([^"'“”.]+?)["'“”]?\s*$/i)
    || t.match(/line\s+should\s+say\s+["'“”]?([^"'“”.]+)["'“”]?/i)
    || t.match(/say\s+["'“”]?([^"'“”.]+?)["'“”]?\s+instead\b/i)
    || t.match(/instead\s+of\s+["'“”]?[^"'“”.]+["'“”]?\s*,\s*say\s+["'“”]?([^"'“”.]+?)["'“”]?$/i)
    || t.match(/(?:replace|swap)\s+(?:it|the\s+line)\s+with\s+["'“”]?([^"'“”.]+?)["'“”]?$/i)
    || t.match(/line\s+to\s+["'“”]?([^"'“”.]+)["'“”]?/i);
  // "this line: OLD I want NEW" / "scene N line: OLD ... I want NEW"
  // (capture the text AFTER "I want" / "change it to" / "make it" / "replace with")
  const colonMatch = t.match(/(?:this|scene\s*[1-9]\d*)\s+line\s*[:：]\s*["'“”]?([^"'“”.!?]*?)["'“”]?\s*(?:i\s+want|change\s+it\s+to|make\s+it|replace\s+it\s+with|replace\s+with)\s+["'“”]?([^"'“”.]+?)["'“”]?$/i);

  if (colonMatch && colonMatch[2]) {
    newText = colonMatch[2].trim();
  } else if (toMatch) {
    newText = toMatch[toMatch.length - 1]?.trim();
  }
  // oldText (the line the user is referring to): "line: OLD ... I want NEW" or a quoted old.
  let oldText: string | undefined;
  const oldQuote = t.match(/["'“”]([^"'“”]{3,})["'“”]/g);
  if (colonMatch && colonMatch[1]) oldText = colonMatch[1].trim();
  // If we have oldText candidates as quotes, prefer one that is NOT the newText.
  if (oldQuote && !oldText) {
    const newT = (newText || '').toLowerCase();
    for (const q of oldQuote) {
      const inner = q.replace(/["'“”]/g, '');
      if (inner.toLowerCase() !== newT) { oldText = inner; break; }
    }
  }
  return { sceneNumber, oldText, newText };
}

/**
 * Match a line-change request to a STORED scene row.
 * Priority: explicit scene number → exact narration match (normalized) →
 * fuzzy "contains" on narration (normalized) → null (no match).
 * NEVER guesses — returns null when the line can't be confidently tied to a scene
 * so the caller can surface the honest "which line?" prompt instead of re-rendering.
 */
export function matchLineToScene(
  scenes: Array<{ sceneNumber: number; narration: string | null }>,
  target: LineChangeMatch,
): { sceneNumber: number; narration: string } | null {
  if (!target) return null;
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // 1) Explicit scene number
  if (typeof target.sceneNumber === 'number' && Number.isFinite(target.sceneNumber)) {
    const byNum = scenes.find(s => s.sceneNumber === target.sceneNumber);
    if (byNum) return { sceneNumber: byNum.sceneNumber, narration: byNum.narration || '' };
  }

  const oldNorm = norm(target.oldText || '');
  if (!oldNorm) return null;

  // 2) Exact normalized match on stored narration
  const exact = scenes.find(s => norm(s.narration || '') === oldNorm);
  if (exact) return { sceneNumber: exact.sceneNumber, narration: exact.narration || '' };

  // 3) Contains match (old text is a meaningful substring of a scene narration)
  const contains = scenes.find(s => {
    const n = norm(s.narration || '');
    return n.length > 0 && (n.includes(oldNorm) || oldNorm.split(' ').length >= 3 && oldNorm.split(' ').every((w: string) => n.includes(w)));
  });
  if (contains) return { sceneNumber: contains.sceneNumber, narration: contains.narration || '' };

  return null;
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