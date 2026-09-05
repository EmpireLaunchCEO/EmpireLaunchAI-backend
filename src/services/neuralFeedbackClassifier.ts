/**
 * Pure deterministic helpers for the Neural Feedback → auto-fix loop.
 * NO DB, NO network, NO AI — safe to import anywhere (including unit tests)
 * without touching the database or spending anything.
 */

export type FeedbackIntent = 'audio' | 'smoothness' | 'line_change' | 'repetitive' | 'none';

/** Rich multi-intent view of a feedback string (a sentence can carry several wishes:
 *  "fix the voiceover AND get rid of repetitive parts" → audio + repetitive).
 *  The service satisfies EVERY detected intent — we never silently ignore part of
 *  a request. */
export interface FeedbackIntents {
  audio: boolean;
  smoothness: boolean;
  lineChange: boolean;
  repetitive: boolean;
}

export interface LineChangeMatch {
  /** Explicit scene number if the user named one (e.g. "scene 3 line"). */
  sceneNumber?: number;
  /** Old text the user quoted / wants replaced (may be undefined). */
  oldText?: string;
  /** The NEW text the line should say (replacement). */
  newText?: string;
}

// ── REPETITIVE intent (task 5c058d1f): "cut the repeats", "same scene twice",
//    "redundant", "drags", "too long / shorten the video", "remove duplicates".
//    "repeat" ALONE is ambiguous ("please repeat the voiceover" = audio playback),
//    so the bare token only counts when it co-occurs with a dedup/trim signal or
//    an explicit repetition complaint (repeats/repeating/repeated/repetitive). ──
const REPETITIVE_WORD_RE = /\b(repetitive|repeats|repeating|repeated|redundant|duplicate|duplicates|drags|dragging)\b/i;
const REPETITIVE_BARE_REPEAT_RE = /\brepeat\b/i;
const REPETITIVE_PHRASE_RE = /same scene twice|too long|cut (the )?repeats?|shorten the video|remove (the )?duplicates?/i;
const REPETITIVE_CONTEXT_RE = /cut|trim|drop|remove|dedup|duplicate|shorten|short|scene|part|section|bit|clip|too long|again and again|over and over/i;

/** Pure, deterministic: does the text ask to cut/deduplicate repetitive scenes? */
export function classifyRepetitive(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (REPETITIVE_WORD_RE.test(t)) return true;
  // "repeat" alone is ambiguous — require a dedup/trim/shorten context.
  if (REPETITIVE_BARE_REPEAT_RE.test(t) && REPETITIVE_CONTEXT_RE.test(t)) return true;
  return REPETITIVE_PHRASE_RE.test(t);
}

/**
 * Rich intent detection — returns ALL intents present in a feedback string.
 * Cheap, deterministic, no LLM. Keeps the shared audio/smoothness/line-change
 * signals (identical words as classifyFeedback) so downstream routing is honest.
 */
export function classifyFeedbackIntents(text: string): FeedbackIntents {
  const t = (text || '').toLowerCase();
  // Shared signals (must stay identical to the single-intent classifier below).
  const hasAudioBleed = t.includes('audio') || t.includes('voice') || t.includes('sound') ||
    t.includes('narration') || t.includes('bleed') || t.includes('mute') ||
    t.includes('speaker') || t.includes('talking') || t.includes('speak');
  const hasSmoothness = t.includes('choppy') || t.includes('judder') || t.includes('stutter') ||
    t.includes('smooth') || t.includes('jitter') || t.includes('fps') ||
    t.includes('frame rate') || t.includes('framerate') || t.includes('jerky') ||
    t.includes('laggy') || t.includes('stuck') || t.includes('freeze');
  // LINE_CHANGE wins only when there is NO audio/smoothness signal (a pure line
  // edit means changing WORDS, not complaining about sound/motion).
  const rawLineSignal = /line|reword|rewrite|say .* instead|replace .* with|change .* to say|edit the script|fix the script|fix .* line/.test(t);
  return {
    audio: hasAudioBleed,
    smoothness: hasSmoothness,
    lineChange: rawLineSignal && !hasAudioBleed && !hasSmoothness,
    repetitive: classifyRepetitive(t),
  };
}

/** Deterministic single-intent classification (cheap, no LLM in the hot path).
 *  For a combined request the PRIMARY label follows priority
 *  line_change → audio → repetitive → smoothness; the service routes on the rich
 *  intents (classifyFeedbackIntents) so EVERY detected intent is satisfied. */
export function classifyFeedback(text: string): FeedbackIntent {
  const i = classifyFeedbackIntents(text);
  if (i.lineChange) return 'line_change';
  if (i.audio) return 'audio';
  if (i.repetitive) return 'repetitive';
  if (i.smoothness) return 'smoothness';
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

// ── REPETITIVE detection helpers (task 5c058d1f) ────────────────────────────
// Pure, deterministic, no AI / no ffmpeg in the hot path. The service feeds these
// hashes that are computed ONCE per scene component via sharp (still) or
// ffmpeg+sharp (first video frame).

/** Normalize narration text for duplicate comparison (punctuation/case/space-collapse). */
export function normalizeNarration(text: string | null | undefined): string {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Hamming distance between two dHash hex strings (default 64-bit = 8 hex chars). */
export function hammingDistance(h1: string, h2: string): number {
  if (!h1 || !h2) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  const len = Math.min(h1.length, h2.length);
  for (let i = 0; i < len; i++) {
    const a = parseInt(h1[i], 16), b = parseInt(h2[i], 16);
    let x = a ^ b;
    while (x) { dist += x & 1; x >>= 1; }
  }
  // Any length mismatch counts as "different" beyond the shared prefix.
  dist += Math.abs(h1.length - h2.length) * 8;
  return dist;
}

/**
 * Detect scenes that REPEAT an EARLIER kept scene (visual dHash OR near-exact
 * narration). Deterministic, keep-first/drop-later, guardrail-safe.
 *
 * Gestalt: a later scene is a duplicate when it is CONFIDENTLY the same as an
 * earlier kept scene by a strict dHash threshold (≤3/64 bits) OR its normalized
 * narration is essentially equal (≤1 token different). Both signals are pure and
 * cheap. Guardrails: NEVER drop the only scene; NEVER drop so fewer than 2 kept
 * remain; only drop on a confident match (an unmatched scene is kept). A scene
 * with neither a hash nor narration is never dropped.
 *
 * @returns the scenes to DROP (never the kept list) + a `kept` count.
 */
export function detectRepetitiveScenes(
  scenes: Array<{ sceneNumber: number; narration?: string | null; dhash?: string | null }>,
  opts?: { dhashThreshold?: number; narrationTolerance?: number },
): { dropped: Array<{ sceneNumber: number; oldNarration?: string; matchSceneNumber: number; reason: 'visual' | 'narration' }>; kept: number } {
  const thresh = opts?.dhashThreshold ?? 3;
  const narrationTol = opts?.narrationTolerance ?? 1;
  const kept: typeof scenes = [];
  const dropped: Array<{ sceneNumber: number; oldNarration?: string; matchSceneNumber: number; reason: 'visual' | 'narration' }> = [];

  for (const scene of scenes) {
    // Duplicate signal takes priority over keep-first, but ONLY when confident.
    let dup: { matchSceneNumber: number; reason: 'visual' | 'narration' } | null = null;
    for (const keptScene of kept) {
      // Visual: strict threshold. A missing hash is never a match (don't drop on nothing).
      if (scene.dhash && keptScene.dhash && hammingDistance(scene.dhash, keptScene.dhash) <= thresh) {
        dup = { matchSceneNumber: keptScene.sceneNumber, reason: 'visual' };
        break;
      }
      // Narration: essentially-equal normalized text. EXACT after normalization
      // (case/punct-collapse) drops regardless of length; a ≤ narrationTol
      // token-difference FALLBACK applies only to longer narrations (≥5 tokens)
      // where one word is not significant.
      const a = normalizeNarration(scene.narration).split(' ');
      const b = normalizeNarration(keptScene.narration).split(' ');
      const minLen = Math.min(a.length, b.length);
      let diffs = 0;
      for (let i = 0; i < minLen; i++) if (a[i] !== b[i]) diffs++;
      diffs += Math.abs(a.length - b.length);
      const exact = a.length === b.length && diffs === 0;
      const nearLong = a.length >= 5 && b.length >= 5 && diffs <= narrationTol;
      if (a.length > 0 && b.length > 0 && (exact || nearLong)) {
        dup = { matchSceneNumber: keptScene.sceneNumber, reason: 'narration' };
        break;
      }
    }
    if (dup) {
      dropped.push({ sceneNumber: scene.sceneNumber, oldNarration: scene.narration || undefined, matchSceneNumber: dup.matchSceneNumber, reason: dup.reason });
    } else {
      kept.push(scene);
    }
  }

  // Guardrails: never drop the only scene; never leave fewer than 2 kept.
  if (scenes.length > 0 && dropped.length === scenes.length) {
    // Everything got dropped — impossible for keep-first (first scene can't match an
    // earlier kept scene at the start, so at least one stays). Defensive only.
    const last = dropped.pop();
    if (last) kept.push(scenes.find(s => s.sceneNumber === last.sceneNumber) || scenes[0]);
  }
  if (kept.length < 2 && dropped.length > 0) {
    // Restore the earliest dropped scenes until ≥2 kept (safety net).
    while (kept.length < 2 && dropped.length > 0) {
      const d = dropped[0];
      const orig = scenes.find(s => s.sceneNumber === d.sceneNumber);
      if (orig) kept.push(orig);
      dropped.shift();
    }
  }

  return { dropped, kept: kept.length };
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