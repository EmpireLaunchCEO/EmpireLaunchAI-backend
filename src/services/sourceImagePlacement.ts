/**
 * ─── UPLOADED-PHOTO PLACEMENT CONTRACT (owner Oct 30) ────────────────────────
 *
 * Owner rule: "anything the client uploads or agrees to in chat must actually
 * change the output". A client-uploaded photo used to be stamped on EVERY still
 * scene (a wall of identical shots) and there was no way for anyone — chip or
 * chat — to say WHERE it belongs. This module is the single source of truth for
 * that answer:
 *
 *   1. `parseSourceImagePlacement(text)` — deterministic, pure, no model call:
 *      reads the client's own words ("background for the whole video", "scene 3",
 *      "the last scene", "for the first 5 seconds", "from scene 3 on",
 *      "don't use the photo") and returns a placement, or `undefined` when it is
 *      not confident. It NEVER guesses.
 *   2. `normalizeSourceImagePlacement(raw)` — the tolerant read-path normaliser:
 *      any persisted / explicit value becomes the canonical spec, or `null`.
 *   3. `resolveSourceImagePlacementInput(raw, ctx)` — the STRICT entry point for
 *      the project-create routes: absent ⇒ null, malformed ⇒ `{ok:false, error}`
 *      (the route answers 400). A half-parsed object is never stored.
 *   4. `scenesForSourceImagePlacement` / `sourceImageForScene` — the per-scene
 *      projection: a scene gets the reference ONLY if the placement names it;
 *      `background` ⇒ every scene; `none` ⇒ no scene; ABSENT ⇒ scene 1 only
 *      (byte-identical to the pre-placement behaviour).
 *   5. `deriveSceneSourceImageMetadata` — the derived per-scene
 *      `metadata.sourceImage` ({role, placementIndex, sha256}). `visualPrompt`
 *      is never rewritten.
 *
 * ── WHOLE-SCENE QUANTIZATION (hard rule, owner Oct 30) ──────────────────────
 * A scene is NEVER split to honour a timestamp. Each seam costs 0.8s of dissolve
 * overlap (`DISSOLVE_OVERLAP_SECONDS`) and truncates that clip's narration, so
 * "show the photo for N seconds" is converted to a WHOLE-SCENE set:
 *
 *     scenesOwned = clamp(round(N / averageSceneSeconds), 1, sceneCount)
 *
 *   • N shorter than one scene  → 1 whole scene.
 *   • N spanning two scenes     → those 2 consecutive whole scenes.
 *   • N longer than the video   → clamp to sceneCount (effectively background).
 *
 * The delivered length is therefore untouched and narration is never cut. An
 * explicit scene reference ("scene 3") always beats a duration guess; the
 * stated seconds are still recorded as `requestedSeconds` for the receipt.
 */

import { normalizeSpokenSeconds } from './plannerFidelity.js';

/** Where the uploaded photo goes. */
export type SourceImagePlacementMode = 'background' | 'scene' | 'none';
/** Where a whole-scene run of the photo starts (only used by duration phrasings). */
export type SourceImagePlacementAnchor = 'start' | 'center' | 'end';
/** How the photo fills its frame. */
export type SourceImageFit = 'cover' | 'contain';
/** `full` = the photo IS the frame; `blurred-backdrop` = photo blurred behind the AI still. */
export type SourceImageTreatment = 'full' | 'blurred-backdrop';

export interface SourceImagePlacementSource {
  url?: string;
  localPath?: string;
  sha256?: string;
  bytes?: number;
}

/**
 * The persisted shape (`video_projects.metadata.sourceImagePlacement`).
 * `mode:'scene'` + `sceneNumbers:[]` is only valid together with a legacy
 * `window` (see below); the parser always emits concrete scene numbers.
 */
export interface SourceImagePlacement {
  mode: SourceImagePlacementMode;
  /** 1-based, ascending. `[]` for `background` / `none` (and for a legacy window). */
  sceneNumbers: number[];
  /** What the client actually said ("show it for 5 seconds"). */
  requestedSeconds?: number;
  /** Σ sceneSeconds of `sceneNumbers` — the real on-screen length after quantization. */
  effectiveSeconds?: number;
  anchor: SourceImagePlacementAnchor;
  fit: SourceImageFit;
  treatment: SourceImageTreatment;
  /** `false` ⇒ we applied the default (scene 1); the receipt must say so. */
  stated: boolean;
  /**
   * LEGACY seconds form (pre-parser API callers / already-persisted specs):
   * `{mode:'time', startSec, endSec}`. Kept working because it is inherently
   * whole-scene — a scene is included iff it overlaps the window, so a scene is
   * never split. The chat parser never emits it.
   */
  window?: { startSec: number; endSec?: number };
  source?: SourceImagePlacementSource;
}

/** Everything the parser may know about the video it is placing a photo into. */
export interface SourceImagePlacementContext {
  sceneCount?: number;
  /** Per-scene durations in scene order (preferred — exact). */
  sceneSeconds?: number[];
  /** Total delivered duration, used with `sceneCount` to derive an average scene. */
  durationSeconds?: number;
}

/** Minimal structural scene shape (mirrors plannerFidelity's deliberate no-import rule). */
export interface SceneTiming {
  sceneNumber: number;
  duration: number;
}

/** Derived per-scene projection written to `video_scenes.metadata.sourceImage`. */
export interface SceneSourceImageMetadata {
  role: 'full-frame' | 'backdrop';
  placementIndex: number;
  sha256?: string;
}

/** Absent placement ⇒ scene 1 only, `stated:false` (the pre-placement default). */
export const DEFAULT_SOURCE_IMAGE_PLACEMENT: SourceImagePlacement = {
  mode: 'scene',
  sceneNumbers: [1],
  anchor: 'start',
  fit: 'cover',
  treatment: 'full',
  stated: false,
};

const clampInt = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.trunc(n)));

function toFiniteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeAnchor(value: unknown, fallback: SourceImagePlacementAnchor = 'start'): SourceImagePlacementAnchor {
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'end' || s === 'last' || s === 'final') return 'end';
  if (s === 'center' || s === 'centre' || s === 'middle') return 'center';
  if (s === 'start' || s === 'first' || s === 'beginning' || s === 'opening') return 'start';
  return fallback;
}

function normalizeFit(value: unknown): SourceImageFit {
  return String(value ?? '').trim().toLowerCase() === 'contain' ? 'contain' : 'cover';
}

function normalizeTreatment(value: unknown): SourceImageTreatment {
  return String(value ?? '').trim().toLowerCase() === 'blurred-backdrop' ? 'blurred-backdrop' : 'full';
}

function normalizeSource(raw: unknown): SourceImagePlacementSource | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as any;
  const out: SourceImagePlacementSource = {};
  if (typeof v.url === 'string' && v.url.trim()) out.url = v.url.trim();
  if (typeof v.localPath === 'string' && v.localPath.trim()) out.localPath = v.localPath.trim();
  if (typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(v.sha256.trim())) out.sha256 = v.sha256.trim().toLowerCase();
  const bytes = toFiniteNumber(v.bytes);
  if (bytes !== undefined && bytes > 0) out.bytes = Math.trunc(bytes);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Tolerant normaliser (READ path + already-persisted metadata).
 * Accepts the canonical object, a JSON string of it, and the legacy
 * `{mode:'scene', sceneNumber}` / `{mode:'time', startSec, endSec}` forms.
 * Anything unusable degrades to `null` (⇒ scene 1 only), never to a throw —
 * mirrors the `visualPromptOverrides` normaliser next to it.
 */
export function normalizeSourceImagePlacement(raw: unknown): SourceImagePlacement | null {
  if (raw === null || raw === undefined) return null;
  let value: any = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try { value = JSON.parse(trimmed); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const modeRaw = String(value.mode ?? '').trim().toLowerCase();
  if (modeRaw !== 'background' && modeRaw !== 'scene' && modeRaw !== 'none' && modeRaw !== 'time') return null;

  const anchor = normalizeAnchor(value.anchor);
  const fit = normalizeFit(value.fit);
  const treatment = normalizeTreatment(value.treatment);
  const stated = value.stated === false ? false : true;
  const requestedSecondsRaw = toFiniteNumber(value.requestedSeconds);
  const requestedSeconds = requestedSecondsRaw !== undefined && requestedSecondsRaw > 0 ? requestedSecondsRaw : undefined;
  const source = normalizeSource(value.source);

  if (modeRaw === 'background') {
    return { mode: 'background', sceneNumbers: [], anchor, fit, treatment, stated, ...(requestedSeconds !== undefined ? { requestedSeconds } : {}), ...(source ? { source } : {}) };
  }
  if (modeRaw === 'none') {
    return { mode: 'none', sceneNumbers: [], anchor, fit, treatment, stated, ...(source ? { source } : {}) };
  }

  // 'scene' (canonical) — sceneNumbers[] | legacy sceneNumber | scenes[]
  const collected: number[] = [];
  const pushScene = (v: unknown) => {
    const n = toFiniteNumber(v);
    if (n !== undefined && n >= 1) collected.push(Math.floor(n));
  };
  if (Array.isArray(value.sceneNumbers)) value.sceneNumbers.forEach(pushScene);
  if (Array.isArray(value.scenes)) value.scenes.forEach(pushScene);
  pushScene(value.sceneNumber);
  const sceneNumbers = [...new Set(collected)].sort((a, b) => a - b);

  // 'time' (legacy) — a seconds window; projected to whole scenes by overlap.
  const startSec = toFiniteNumber(value.startSec);
  const endSec = toFiniteNumber(value.endSec);
  const hasWindow = modeRaw === 'time' || startSec !== undefined || endSec !== undefined;
  let window: { startSec: number; endSec?: number } | undefined;
  if (hasWindow && (startSec !== undefined || endSec !== undefined)) {
    const start = Math.max(0, startSec ?? 0);
    if (endSec !== undefined && !Number.isFinite(endSec)) return null;
    const end = endSec === undefined ? undefined : Math.max(start, endSec);
    window = { startSec: start, ...(end === undefined ? {} : { endSec: end }) };
  }
  if (!sceneNumbers.length && !window) return null;
  if (modeRaw === 'time' && !window) return null;

  const effectiveSecondsRaw = toFiniteNumber(value.effectiveSeconds);
  const effectiveSeconds = effectiveSecondsRaw !== undefined && effectiveSecondsRaw > 0 ? effectiveSecondsRaw : undefined;

  return {
    mode: 'scene',
    sceneNumbers,
    ...(requestedSeconds !== undefined ? { requestedSeconds } : {}),
    ...(effectiveSeconds !== undefined ? { effectiveSeconds } : {}),
    anchor,
    fit,
    treatment,
    stated,
    ...(window ? { window } : {}),
    ...(source ? { source } : {}),
  };
}

/* ─────────────────────────── deterministic parser ─────────────────────────── */

/** A sentence is about the photo only if it says so — by naming it, by pointing
 *  at it ("use it", "show it"), or by being an unambiguous placement phrase
 *  ("background for the whole video", "only the last scene", "for the first 5
 *  seconds"). Without this gate "make the video 30 seconds" would be read as the
 *  photo duration, and "background music for the whole video" as a placement. */
const PHOTO_TERM = '(?:photo|photos|picture|pictures|pic|pics|image|images|upload|uploaded|headshot|selfie|portrait|logo|shot of me|my face|my picture)';
const PHOTO_REFERENCE_RE = new RegExp(`\\b${PHOTO_TERM}\\b|\\b(?:use|using|show|showing|put|place|display|keep|include)\\s+(?:it|this|that|them)\\b`, 'i');
/** Not about the photo at all — a background MUSIC/voice instruction. */
const NOT_PHOTO_MEDIA_RE = /\b(?:music|song|soundtrack|audio|voice|voiceover|narration|beat)\b/i;
/** Editing talk about a scene, never a photo placement. */
const SCENE_EDITING_RE = /\b(?:longer|shorter|faster|slower|duration|length)\b/i;
const FIRST_LAST_SCENE_RE = /\b(?:first|last|final|opening|closing)\s+scene\b|\bscene\s+(?:at\s+the\s+)?(?:very\s+)?(?:end|last)\b/i;
const FOR_FIRST_SECONDS_RE = /\bfor\s+the\s+(?:first|last|final)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s)\b/i;
/** Verbs/nouns that make a neighbouring sentence a placement instruction. */
const PLACEMENT_CUE_RE = /\b(?:background|backdrop|behind|throughout|whole|entire|every\s+scene|all\s+scenes|scene|scenes|show|shows|showing|use|using|put|place|display|keep|appear|starts?|starting|ends?|ending|first|last|final|opening|closing|for)\b/i;

const NEGATION_PATTERNS: RegExp[] = [
  new RegExp(`\\bno\\s+${PHOTO_TERM}\\b`, 'i'),
  new RegExp(`\\b(?:don'?t|do\\s+not|does\\s+not|doesn'?t|never|without|skip|remove|omit|ignore|drop)\\b[^.!?;\\n]{0,48}\\b(?:use|using|include|show|showing|display|put|place|apply|want|need)?\\s*(?:the|my|that|this|her|his|their)?\\s*${PHOTO_TERM}\\b`, 'i'),
  new RegExp(`\\b${PHOTO_TERM}\\b[^.!?;\\n]{0,24}\\b(?:isn'?t|is\\s+not|not|never)\\s+(?:needed|required|necessary|wanted|used|included|shown)\\b`, 'i'),
];

const BACKGROUND_RE = /\b(?:background|backdrop|behind\s+(?:everything|it\s+all|the\s+scenes)|throughout|whole\s+video|entire\s+video|full\s+video|whole\s+thing|entire\s+thing|every\s+scene|all\s+(?:of\s+)?the\s+scenes|the\s+whole\s+time|the\s+entire\s+time|end\s+to\s+end)\b/i;

/** "scenes 2 through 4" / "scenes 2-4" — an explicit inclusive range. */
const SCENE_RANGE_RE = /\bscenes?\s*#?\s*(\d+)\s*(?:-|–|—|through|thru|to|until|till)\s*#?\s*(\d+)\b/i;
/** "from scene 3 on" / "scene 3 onwards" — a run to the end. */
const SCENE_FROM_ON_RE = /\b(?:from\s+(?:the\s+)?scene\s*#?\s*(\d+)|scene\s*#?\s*(\d+))\s*(?:on|onwards?|and\s+on|to\s+the\s+end|through\s+the\s+end|until\s+the\s+end|till\s+the\s+end)\b/i;
/** "scenes 2 and 4" / "scene 3, 5 and 6" — an explicit list. */
const SCENE_LIST_RE = /\bscenes?\s*#?\s*(\d+)\s*(?:,|and|&|\+)\s*(?:scene\s*#?\s*)?(\d+)(?:(?:\s*,\s*|\s+and\s+|\s*&\s*)(?:scene\s*#?\s*)?(\d+))?/i;
/** "scene 3" — one scene. */
const SCENE_SINGLE_RE = /\bscene\s*#?\s*(\d+)\b/i;
/** "the last scene" / "final scene" / "closing scene" (needs sceneCount). */
const SCENE_LAST_RE = /\b(?:last|final|closing|ending)\s+scene\b|\bscene\s+(?:at\s+the\s+)?(?:very\s+)?(?:end|last)\b/i;
/** "the first scene" / "opening scene". */
const SCENE_FIRST_RE = /\b(?:first|opening|starting|initial)\s+scene\b|\bscene\s+(?:at\s+the\s+)?(?:very\s+)?(?:start|beginning)\b/i;

/** "for the first 5 seconds" / "for 4s" / "5 seconds of the photo". */
const SECONDS_PATTERNS: RegExp[] = [
  /\bfor\s+(?:the\s+)?(?:first|last|final|opening)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i,
  /\b(?:first|last|final|opening)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i,
  /\bfor\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i,
  /\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?)\s+(?:of\s+)?(?:the\s+|my\s+|this\s+)?(?:photo|picture|pic|image)\b/i,
  /\b(?:photo|picture|pic|image)\b[^.!?;\n]{0,24}\bfor\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i,
];
/**
 * Is this sentence a placement instruction at all? Without this gate "make the
 * video 30 seconds" would be read as the photo duration, "background music for
 * the whole video" as a background placement, and "make the last scene longer"
 * as "photo in the last scene".
 */
function isPlacementSentence(sentence: string): boolean {
  if (PHOTO_REFERENCE_RE.test(sentence)) return true;
  const talksAboutVideo = /\b(?:video|scene|scenes|clip)\b/i.test(sentence);
  if (BACKGROUND_RE.test(sentence) && talksAboutVideo && !NOT_PHOTO_MEDIA_RE.test(sentence)) return true;
  if (FOR_FIRST_SECONDS_RE.test(sentence)) return true;
  if (FIRST_LAST_SCENE_RE.test(sentence) && !SCENE_EDITING_RE.test(sentence) && !NOT_PHOTO_MEDIA_RE.test(sentence)) return true;
  return false;
}

/** Average scene length, derived from whatever context we have. */
function averageSceneSeconds(ctx?: SourceImagePlacementContext): number | undefined {
  const seconds = (ctx?.sceneSeconds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (seconds.length) return seconds.reduce((a, b) => a + b, 0) / seconds.length;
  const count = Number(ctx?.sceneCount);
  const duration = Number(ctx?.durationSeconds);
  if (Number.isFinite(count) && count > 0 && Number.isFinite(duration) && duration > 0) return duration / count;
  return undefined;
}

/**
 * WHOLE-SCENE QUANTIZATION (the hard rule at the top of this file): convert a
 * stated number of seconds into a run of WHOLE scenes. Never splits a scene.
 * Returns `undefined` when we cannot size a scene (⇒ the parser is not
 * confident and returns nothing rather than guessing).
 */
export function wholeScenesForSeconds(
  seconds: number,
  context: SourceImagePlacementContext | undefined,
  anchor: SourceImagePlacementAnchor = 'start',
): { sceneNumbers: number[]; effectiveSeconds: number } | undefined {
  const sceneCount = Number(context?.sceneCount);
  if (!Number.isFinite(sceneCount) || sceneCount < 1) return undefined;
  const durations = (context?.sceneSeconds || []).map(Number);
  const exact = durations.length === sceneCount && durations.every((d) => Number.isFinite(d) && d > 0) ? durations : undefined;
  const avg = averageSceneSeconds(context);
  if (!avg || avg <= 0) return undefined;
  const owned = clampInt(Math.round(Number(seconds) / avg), 1, sceneCount);
  const start = anchor === 'end'
    ? sceneCount - owned + 1
    : anchor === 'center'
      ? clampInt(Math.round((sceneCount - owned) / 2) + 1, 1, Math.max(1, sceneCount - owned + 1))
      : 1;
  const sceneNumbers: number[] = [];
  let effectiveSeconds = 0;
  for (let i = 0; i < owned; i++) {
    const n = start + i;
    if (n > sceneCount) break;
    sceneNumbers.push(n);
    effectiveSeconds += exact ? exact[n - 1] : avg;
  }
  if (!sceneNumbers.length) return undefined;
  return { sceneNumbers, effectiveSeconds: Number(effectiveSeconds.toFixed(2)) };
}

/**
 * DETERMINISTIC PLACEMENT PARSER — pure, no model call, no I/O.
 *
 * Reads the client's own words and returns a placement, or `undefined` when it
 * is not confident (never guesses). Precedence: an explicit placement object
 * passed by the app beats this parser — the caller decides.
 */
export function parseSourceImagePlacement(
  text: unknown,
  context?: SourceImagePlacementContext,
): SourceImagePlacement | undefined {
  const raw = normalizeSpokenSeconds(String(text ?? '').replace(/\s+/g, ' ').trim());
  if (!raw) return undefined;
  const sentences = raw.split(/(?<=[.!?])\s+|[\n;]+/).map((s) => s.trim()).filter(Boolean);
  const photoSentenceIndexes = new Set<number>();
  sentences.forEach((s, i) => { if (isPlacementSentence(s)) photoSentenceIndexes.add(i); });
  if (!photoSentenceIndexes.size) return undefined; // not about the photo at all
  // A bare placement phrase next to a photo sentence belongs to it
  // ("Use my photo. Background, please.").
  const placementIndexes = new Set<number>(photoSentenceIndexes);
  sentences.forEach((s, i) => {
    if (photoSentenceIndexes.has(i)) return;
    const adjacent = photoSentenceIndexes.has(i - 1) || photoSentenceIndexes.has(i + 1);
    if (!adjacent) return;
    const words = s.split(/\s+/).filter(Boolean);
    if (PLACEMENT_CUE_RE.test(s) && (words.length <= 12 || /^(?:scene|scenes|background|backdrop|first|last|for|only|from|throughout|whole|use|show|put|keep|don'?t|no)\b/i.test(s))) {
      placementIndexes.add(i);
    }
  });
  const placementText = sentences.filter((_s, i) => placementIndexes.has(i)).join(' ');
  if (!placementText) return undefined;

  const base = { anchor: 'start' as SourceImagePlacementAnchor, fit: 'cover' as SourceImageFit, treatment: 'full' as SourceImageTreatment, stated: true };

  // 1. Explicit "don't use it" beats everything else.
  if (NEGATION_PATTERNS.some((re) => re.test(placementText))) {
    return { ...base, mode: 'none', sceneNumbers: [] };
  }

  // 2. Background for the whole video.
  if (BACKGROUND_RE.test(placementText)) {
    return { ...base, mode: 'background', sceneNumbers: [] };
  }

  const sceneCount = Number(context?.sceneCount);
  const hasSceneCount = Number.isFinite(sceneCount) && sceneCount > 0;

  // 3. Explicit scene references.
  const range = SCENE_RANGE_RE.exec(placementText);
  if (range) {
    const from = clampInt(Number(range[1]), 1, hasSceneCount ? sceneCount : Number.MAX_SAFE_INTEGER);
    const toRaw = clampInt(Number(range[2]), 1, hasSceneCount ? sceneCount : Number.MAX_SAFE_INTEGER);
    if (from >= 1 && toRaw >= from) {
      const sceneNumbers: number[] = [];
      for (let n = from; n <= toRaw; n++) sceneNumbers.push(n);
      if (sceneNumbers.length) return { ...base, mode: 'scene', sceneNumbers };
    }
  }
  const fromOn = SCENE_FROM_ON_RE.exec(placementText);
  if (fromOn) {
    const from = clampInt(Number(fromOn[1] ?? fromOn[2]), 1, hasSceneCount ? sceneCount : Number.MAX_SAFE_INTEGER);
    if (!hasSceneCount) return undefined; // "from scene 3 on" needs the scene count to be honest
    if (from >= 1 && from <= sceneCount) {
      const sceneNumbers: number[] = [];
      for (let n = from; n <= sceneCount; n++) sceneNumbers.push(n);
      return { ...base, mode: 'scene', sceneNumbers };
    }
  }
  const list = SCENE_LIST_RE.exec(placementText);
  if (list) {
    const sceneNumbers = [...new Set([list[1], list[2], list[3]].filter(Boolean).map((v) => Math.trunc(Number(v))).filter((n) => n >= 1))].sort((a, b) => a - b);
    if (sceneNumbers.length) return { ...base, mode: 'scene', sceneNumbers };
  }
  const single = SCENE_SINGLE_RE.exec(placementText);
  if (single) {
    const n = Math.trunc(Number(single[1]));
    if (n >= 1 && (!hasSceneCount || n <= sceneCount)) return { ...base, mode: 'scene', sceneNumbers: [n] };
    if (n >= 1 && hasSceneCount) return undefined; // "scene 9" in a 5-scene video: not confident
  }
  if (SCENE_FIRST_RE.test(placementText)) {
    return { ...base, mode: 'scene', sceneNumbers: [1] };
  }
  if (SCENE_LAST_RE.test(placementText)) {
    if (!hasSceneCount) return undefined; // "the last scene" is only honest with a scene count
    return { ...base, mode: 'scene', sceneNumbers: [sceneCount], anchor: 'end' };
  }

  // 4. A stated duration → WHOLE scenes (never a split).
  const secondsSentence = sentences
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => placementIndexes.has(i))
    .map(({ s }) => s)
    .find((s) => SECONDS_PATTERNS.some((re) => re.test(s)));
  if (secondsSentence) {
    for (const re of SECONDS_PATTERNS) {
      const m = re.exec(secondsSentence);
      if (!m) continue;
      const requestedSeconds = Number(m[1]);
      if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) continue;
      const anchor: SourceImagePlacementAnchor = /\b(?:last|final|end|closing)\b/i.test(secondsSentence)
        ? 'end'
        : /\b(?:middle|center|centre)\b/i.test(secondsSentence)
          ? 'center'
          : 'start';
      const quantized = wholeScenesForSeconds(requestedSeconds, context, anchor);
      if (!quantized) return undefined; // cannot size a scene ⇒ do not guess
      return {
        ...base,
        mode: 'scene',
        sceneNumbers: quantized.sceneNumbers,
        requestedSeconds,
        effectiveSeconds: quantized.effectiveSeconds,
        anchor,
      };
    }
  }

  // Nothing conclusive — never guess.
  return undefined;
}

/* ──────────────────────── strict entry point (routes) ─────────────────────── */

export type SourceImagePlacementInputResult =
  | { ok: true; placement: SourceImagePlacement | null }
  | { ok: false; error: string };

const PLACEMENT_HELP =
  'Say "background for the whole video", "use it in scene 3", "scenes 2 and 4", "only the last scene", "for the first 5 seconds" or "don\'t use the photo".';

function describePlacementProblem(raw: any): string {
  const mode = String(raw?.mode ?? '').trim().toLowerCase();
  if (!mode) return `Invalid sourceImagePlacement — "mode" is required (background, scene or none). ${PLACEMENT_HELP}`;
  if (!['background', 'scene', 'none', 'time'].includes(mode)) {
    return `Invalid sourceImagePlacement — unknown mode "${raw.mode}". Allowed: background, scene, none. ${PLACEMENT_HELP}`;
  }
  if (mode === 'scene' || mode === 'time') {
    return 'Invalid sourceImagePlacement — scene mode needs at least one scene (sceneNumbers: [3] or sceneNumber: 3) or a seconds window (startSec/endSec).';
  }
  return `Invalid sourceImagePlacement. ${PLACEMENT_HELP}`;
}

/**
 * STRICT validator for the project-create routes. Never stores a half-parsed
 * object:
 *   • absent / blank            → `{ok:true, placement:null}` (legacy: scene 1)
 *   • valid object / JSON string → `{ok:true, placement:<canonical spec>}`
 *   • free-text sentence        → parsed deterministically; not confident ⇒ 400
 *   • anything malformed        → `{ok:false, error}` (the route answers 400)
 * An explicit object ALWAYS beats the parser.
 */
export function resolveSourceImagePlacementInput(
  raw: unknown,
  context?: SourceImagePlacementContext,
): SourceImagePlacementInputResult {
  if (raw === undefined || raw === null) return { ok: true, placement: null };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, placement: null };
    const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
    if (looksJson) {
      let parsed: unknown;
      try { parsed = JSON.parse(trimmed); } catch {
        return { ok: false, error: 'Invalid sourceImagePlacement — the JSON could not be parsed.' };
      }
      return resolveSourceImagePlacementInput(parsed, context);
    }
    const parsed = parseSourceImagePlacement(trimmed, context);
    if (!parsed) {
      return { ok: false, error: `We could not tell where your photo should go from "${trimmed.slice(0, 80)}". ${PLACEMENT_HELP}` };
    }
    return { ok: true, placement: parsed };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `Invalid sourceImagePlacement — expected an object or a placement sentence. ${PLACEMENT_HELP}` };
  }
  const normalised = normalizeSourceImagePlacement(raw);
  if (!normalised) return { ok: false, error: describePlacementProblem(raw) };
  return { ok: true, placement: normalised };
}

/* ─────────────────────────── per-scene projection ─────────────────────────── */

/**
 * Which scene numbers should receive the uploaded reference image.
 * No placement spec ⇒ the FIRST scene only (scene 1) — byte-identical to the
 * pre-placement behaviour, never every scene (that produced the wall of
 * identical shots). `background` ⇒ every scene. `none` ⇒ no scene.
 */
export function scenesForSourceImagePlacement(
  placement: SourceImagePlacement | null | undefined,
  scenes: SceneTiming[],
): number[] {
  const ordered = [...(scenes || [])]
    .filter((s) => s && Number.isFinite(Number(s.sceneNumber)))
    .sort((a, b) => Number(a.sceneNumber) - Number(b.sceneNumber));
  if (!ordered.length) return [];
  if (!placement) return [Number(ordered[0].sceneNumber)];
  if (placement.mode === 'background') return ordered.map((s) => Number(s.sceneNumber));
  if (placement.mode === 'none') return [];
  // Legacy seconds window: a scene is included iff it overlaps [start, end) —
  // inherently whole-scene, so a scene is never split.
  if (placement.window) {
    const start = Math.max(0, Number(placement.window.startSec ?? 0));
    const end = placement.window.endSec === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(start, Number(placement.window.endSec));
    const hits: number[] = [];
    let cursor = 0;
    for (const scene of ordered) {
      const sceneStart = cursor;
      const sceneEnd = cursor + Math.max(0, Number(scene.duration) || 0);
      if (sceneStart < end && sceneEnd > start) hits.push(Number(scene.sceneNumber));
      cursor = sceneEnd;
    }
    return hits;
  }
  const wanted = new Set((placement.sceneNumbers || []).map(Number));
  return ordered.filter((s) => wanted.has(Number(s.sceneNumber))).map((s) => Number(s.sceneNumber));
}

/**
 * The reference image a given scene should be rendered from — the uploaded
 * photo when this scene is a placement target, otherwise undefined (text-to-image
 * exactly as a photo-less project). Used by BOTH the worker and regeneration so
 * re-running a scene can never quietly lose the client's photo.
 */
export function sourceImageForScene(
  heroSource: string | undefined,
  placement: SourceImagePlacement | null | undefined,
  scenes: SceneTiming[],
  sceneNumber: number,
): string | undefined {
  if (!heroSource) return undefined;
  return scenesForSourceImagePlacement(placement, scenes).includes(Number(sceneNumber)) ? heroSource : undefined;
}

/**
 * Derived per-scene projection written to `video_scenes.metadata.sourceImage`.
 * `role` follows the treatment (blurred backdrop vs full frame); `placementIndex`
 * is the scene's position inside the placement (always 0 for a background, which
 * is one continuous layer). `visualPrompt` is NEVER rewritten.
 */
export function deriveSceneSourceImageMetadata(
  placement: SourceImagePlacement | null | undefined,
  scenes: SceneTiming[],
): Record<number, SceneSourceImageMetadata> {
  const targets = scenesForSourceImagePlacement(placement, scenes);
  const role: SceneSourceImageMetadata['role'] = placement?.treatment === 'blurred-backdrop' ? 'backdrop' : 'full-frame';
  const sha256 = placement?.source?.sha256;
  const out: Record<number, SceneSourceImageMetadata> = {};
  targets.forEach((sceneNumber, index) => {
    out[sceneNumber] = {
      role,
      placementIndex: placement?.mode === 'background' ? 0 : index,
      ...(sha256 ? { sha256 } : {}),
    };
  });
  return out;
}

/**
 * Human-readable receipt of what the renderer understood — what the app shows
 * back to the client ("so the frontend can display what was understood").
 */
export function describeSourceImagePlacement(
  placement: SourceImagePlacement | null | undefined,
  targetSceneNumbers: number[],
): string {
  if (!placement) {
    return targetSceneNumbers.length
      ? 'We placed your photo in the opening scene — say "background" to use it throughout.'
      : 'No photo was used in this video.';
  }
  if (placement.mode === 'none') return 'Your photo is not used in this video.';
  if (placement.mode === 'background') {
    return placement.treatment === 'blurred-backdrop'
      ? 'Your photo is the blurred background behind every scene, for the whole video.'
      : 'Your photo is used as the background for the whole video.';
  }
  const scenes = [...targetSceneNumbers].sort((a, b) => a - b);
  if (!scenes.length) return 'Your photo is not used in this video.';
  const list = scenes.length === 1
    ? `scene ${scenes[0]}`
    : `scenes ${scenes.slice(0, -1).join(', ')} and ${scenes[scenes.length - 1]}`;
  const seconds = placement.effectiveSeconds ?? placement.requestedSeconds;
  const timing = seconds !== undefined && Number.isFinite(Number(seconds)) ? ` (about ${Math.round(Number(seconds))}s)` : '';
  return `Your photo appears in ${list}${timing}.`;
}

/**
 * The resolved placement exposed on the project READ path (GET
 * /api/studio/video-project/:id). `undefined` when there is neither a photo nor
 * a stated placement — a photo-less project's payload stays byte-identical.
 */
export function resolveProjectSourceImagePlacement(
  projectMetadata: any,
  scenes: SceneTiming[],
): (SourceImagePlacement & { targetScenes: number[]; summary: string; photoPresent: boolean }) | undefined {
  const meta = projectMetadata || {};
  const photos: string[] = Array.isArray(meta.sourceImages)
    ? meta.sourceImages.filter((u: any) => typeof u === 'string' && u.length > 0)
    : [];
  const stated = normalizeSourceImagePlacement(meta.sourceImagePlacement);
  if (!photos.length && !stated) return undefined;
  const placement = stated ?? { ...DEFAULT_SOURCE_IMAGE_PLACEMENT };
  const targetScenes = photos.length ? scenesForSourceImagePlacement(placement, scenes) : [];
  return {
    ...placement,
    targetScenes,
    summary: describeSourceImagePlacement(photos.length ? placement : null, targetScenes),
    photoPresent: photos.length > 0,
  };
}
