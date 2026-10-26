/**
 * USER-REQUESTED ELEMENTS (task 08041dff — owner ADJUST #2 Oct 19):
 * deterministic extraction + planner/overlay derivation for the faceless /
 * regular path so that explicit user asks in a brief survive the
 * transformation → planner → scene-prompt chain:
 *   (a) dictated openings ("Introducing EmpireLaunch AI …") are spoken
 *       VERBATIM — never rephrased by the planner;
 *   (b) on-screen bullet points turn into assembly overlays (screen-fitted,
 *       marker+bring-in, mirroring the launch-video mechanics);
 *   (c) an end-flash domain ("make EmpireLaunchAI.com flash at the end")
 *       turns into an end-flash overlay on the final scene;
 *   (d) brief-given mood/subject ("people relaxing, doing what they love —
 *       NOT stuck on a phone") is carried into every visual prompt, with the
 *       negated alternative expressed as NEVER (no pain-point inversion).
 *
 * Pure + deterministic: absent asks → empty result (no overlays, no
 * directives; never invents). All inputs are the user's own text.
 */
export interface RequestedMood {
  /** What every scene background MUST show (positive phrase from the brief). */
  positive: string;
  /** What it MUST NEVER show (the "instead of …" negative, kept as a guard). */
  avoid?: string;
}

export interface RequestedVisuals {
  /** Verbatim dictated opening sentence (e.g. "Introducing EmpireLaunch Ai, your new content creation platform."). */
  dictatedOpening?: string;
  /** Finished on-screen bullet phrases (≤ MAX_BULLETS, screen-fitted at draw). */
  bullets?: string[];
  /** Domain / CTA to flash at the end of the video. */
  endFlash?: { text: string };
  /** Brief-given mood / scene subject. */
  mood?: RequestedMood;
}

export const MAX_BULLETS = 4;
export const MAX_BULLET_CHARS = 90;
export const MAX_OPENING_CHARS = 130;

const OPENING_PHRASES =
  /^(Introducing|Meet|Presenting|This is|Say hello to|Welcome to|Introducing the|Meet the)\b/i;
const BULLET_MARKER = /\bbullet\s*points?\b|\bbullets?\b|\bon[- ]screen\s+bullet/i;
const PAREN_BEFORE_MARKER = /\(([^()]{3,320})\)[^.!?\n]{0,60}bullet/i;
const PAREN_WITH_MARKER = /\(([^()]{3,320}bullet[^()]{0,320})\)/i;
const PAREN_AFTER_MARKER = /bullet[^.!?\n]{0,60}\(([^()]{3,320})\)/i;
const COLON_LIST_MARKER = /bullet[^.!?\n]{0,50}:\s*([^.!?\n]{3,260})/i;
const DASH_LIST_MARKER = /((?:[-•▪]\s+[^\n.!?]{3,110}(\s*[.!?]\s*|\s*;|\n)){1,4})[^.!?\n]{0,40}bullet/i;
const FLASH_MARKER =
  /\bflashing?\b|\bflash\b|\bmake\s+[^.!?\n]{1,70}\s+flash\b|\bpop\s*(?:up)?\s*(?:at the end)?\s*\b/i;
const DOMAIN_RE = /\b(?:[A-Za-z0-9][A-Za-z0-9-]{0,40}\.)+[A-Za-z]{2,}\b/gi;
const MOOD_POSITIVE_PERSON =
  /(?:people|someone|a person|they|them|viewers?|users?)\s+(?:relaxing|enjoying|having fun|doing what they love|spending time|laughing|smiling|happy|peaceful|calm|taking|unwinding)[^.!?\n]{0,100}/i;
const MOOD_DESCRIPTIVE =
  /(?:background|scene|visuals?|the video|imagery|overall)\s*(?:needs?\s+to|should|must|has\s+to)?\s*(?:be|show|depict|feel|look|have)\s*([^.!?\n(]{4,130})/i;
const MOOD_EMOTIONAL =
  /(?:emotional|emotion|feeling|freedom|benefit)s?\s+(?:of|that|:)?\s*([^.!?\n]{4,120})/i;
const INSTEAD_OF = /instead\s+of\s+([^.!?\n]{3,110})/i;
const CHAT_RESIDUE_PREFIX =
  /^(?:yes|ok|okay|sure|perfect|great|fine|that'?s\s+fine|that'?s\s+great|love\s+it)[,.\s]+/i;
const INSTRUCTION_WORDS =
  /\b(bullet|need to fit|fit screen|show on screen|flash|flashing|background needs|make (?:it|this|the)|\bcta\b|click|button|screen)\b/i;

function clean(s: string): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function sentences(s: string): string[] {
  return s
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function trimChatResidue(s: string): string {
  return clean(s).replace(CHAT_RESIDUE_PREFIX, '');
}

/** Verbatim dictated opening — the first sentence that starts with an opening
 *  phrase ("Introducing …", "Meet …"). Cut at an opening parenthesis (a typed
 *  aside like "( bullet points …)" must not become part of the spoken line). */
export function extractDictatedOpening(raw: string): string | undefined {
  for (const s of sentences(raw)) {
    if (OPENING_PHRASES.test(s)) {
      const cut = s.indexOf(' (');
      const line = clean(cut >= 0 ? s.slice(0, cut) : s).replace(/[.]+$/, '');
      if (line.length >= 6 && line.length <= MAX_OPENING_CHARS) return line;
    }
  }
  return undefined;
}

function splitBulletCandidates(text: string): string[] {
  return text
    .split(/[!?.;|\n]+/)
    .map((p) => trimChatResidue(p).replace(/^[-•▪\s]+/, '').trim().replace(/\s*-\s*$/, ''))
    .filter((p) => p.length >= 3 && p.length <= MAX_BULLET_CHARS)
    .filter((p) => !INSTRUCTION_WORDS.test(p));
}

/** On-screen bullet phrases: from the parenthetical / dash list that is
 *  explicitly labelled as bullets ("… - these are bullet points to show on
 *  screen- need to fit screen"). Never invents items. */
export function extractBullets(raw: string): string[] {
  const t = clean(raw);
  if (!BULLET_MARKER.test(t)) return [];
  const sources: string[] = [];
  const pushSrc = (s: string | undefined) => {
    if (s && !sources.some((x) => x === s)) sources.push(s);
  };
  pushSrc(t.match(PAREN_BEFORE_MARKER)?.[1]);
  pushSrc(t.match(PAREN_WITH_MARKER)?.[1]);
  pushSrc(t.match(PAREN_AFTER_MARKER)?.[1]);
  pushSrc(t.match(COLON_LIST_MARKER)?.[1]);
  pushSrc(t.match(DASH_LIST_MARKER)?.[1]);
  const found: string[] = [];
  for (const src of sources) {
    for (const item of splitBulletCandidates(src)) {
      if (found.length >= MAX_BULLETS) break;
      if (!found.some((f) => f.toLowerCase() === item.toLowerCase())) found.push(item);
    }
    if (found.length >= MAX_BULLETS) break;
  }
  return found;
}

/** End-flash domain: the domain inside the sentence that mentions "flash";
 *  falling back to the LAST domain mentioned anywhere in the brief. */
export function extractEndFlash(raw: string): { text: string } | undefined {
  const t = clean(raw);
  const flashAt = t.search(FLASH_MARKER);
  if (flashAt === -1) return undefined;
  const flashSentence = t.slice(Math.max(0, flashAt - 140), Math.min(t.length, flashAt + 140));
  const near = flashSentence.match(DOMAIN_RE);
  if (near && near.length) return { text: near[near.length - 1] };
  const all = t.match(DOMAIN_RE);
  if (all && all.length) return { text: all[all.length - 1] };
  return undefined;
}

/** Cut a mood phrase before a negated alternative / chat residue so the
 *  positive directive can never swallow the pain-point it must AVOID. */
function cutMoodPhrase(s: string): string {
  let out = s;
  const alt = out.search(/\s+instead\s+of\b/i);
  if (alt >= 0) out = out.slice(0, alt);
  const chat = out.search(/\s+(?:yes|ok|okay|sure)\b/i);
  if (chat >= 0) out = out.slice(0, chat);
  return out.replace(/[.]+$/, '').trim();
}

/** Mood / scene subject from the brief: a PERSON-scene phrase is preferred
 *  ("someone doing what they love"); otherwise the background description
 *  ("background needs to be encouraging, motivating"). The "instead of …"
 *  clause is carried as the NEVER-guard so the image model can never invert
 *  to the pain-point it was told to avoid. */
export function extractMood(raw: string): RequestedMood | undefined {
  const t = clean(raw);
  const positiveCandidates: string[] = [];
  const person = t.match(MOOD_POSITIVE_PERSON);
  if (person && person[0]) positiveCandidates.push(cutMoodPhrase(trimChatResidue(person[0])));
  const emo = t.match(MOOD_EMOTIONAL);
  if (emo && emo[1]) positiveCandidates.push(cutMoodPhrase(trimChatResidue(emo[1])));
  const desc = t.match(MOOD_DESCRIPTIVE);
  if (desc && desc[1]) positiveCandidates.push(cutMoodPhrase(trimChatResidue(desc[1])));
  const seen = new Set<string>();
  const positive = (positiveCandidates
    .map((p) => p.replace(/\s+/g, ' '))
    .filter((p) => p.length >= 3 && p.length <= MAX_BULLET_CHARS + 60)
    .filter((p) => !/^(yes|ok|okay|sure)\b/i.test(p))
    .filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join('; ')) || undefined;
  if (!positive && !INSTEAD_OF.test(t)) return undefined;
  const avoidMatch = t.match(INSTEAD_OF);
  const mood: RequestedMood = { positive: positive || 'the opposite feeling' };
  if (avoidMatch && avoidMatch[1]) {
    const avoid = trimChatResidue(avoidMatch[1]).replace(/\s*[;.!?]*$/, '');
    if (avoid.length >= 3 && avoid.length <= MAX_BULLET_CHARS + 60) mood.avoid = avoid;
  }
  return mood;
}

/** Full deterministic extraction from a normalized brief (+ conversation user
 *  text, already joined). Order matters: runs on the FULL raw text BEFORE any
 *  instruction-residue stripping so user asks can never be lost to hygiene. */
export function extractRequestedVisuals(raw: string): RequestedVisuals {
  const t = clean(raw);
  const v: RequestedVisuals = {};
  const opening = extractDictatedOpening(t);
  if (opening) v.dictatedOpening = opening;
  const bullets = extractBullets(t);
  if (bullets.length) v.bullets = bullets;
  const endFlash = extractEndFlash(t);
  if (endFlash) v.endFlash = endFlash;
  const mood = extractMood(t);
  if (mood) v.mood = mood;
  return v;
}

/** Conversation user turns joined into one scan string (mirrors
 *  buildComponentInventory's own user-text union). */
export function userConversationText(
  conversation: { role?: string; content?: unknown }[] | undefined,
): string {
  return (conversation ?? [])
    .filter((m) => m?.role === 'user' && typeof m?.content === 'string')
    .map((m) => m.content as string)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** REQUIRED-ELEMENTS block appended to the planner prompt — the dictation-
 *  fidelity contract. Only present sections are emitted (never invents). */
export function buildDictationSection(v: RequestedVisuals, sceneCount: number): string {
  const parts: string[] = [];
  if (v.dictatedOpening) {
    parts.push(
      `USER-DICTATED OPENING (HARD RULE — speak EXACTLY this, never rephrase it): "${v.dictatedOpening}"`,
    );
  }
  if (v.bullets && v.bullets.length) {
    parts.push(
      `USER-REQUESTED ON-SCREEN BULLETS (rendered on the video after assembly — the narration MUST read them aloud, verbatim wording, in the scenes where they appear): ` +
        v.bullets.map((b) => `"${b}"`).join(', '),
    );
  }
  if (v.endFlash) {
    parts.push(
      `USER-REQUESTED END FLASH (rendered as a flashing overlay at the very end of the video — do NOT paint this text inside any image): "${v.endFlash.text}"`,
    );
  }
  if (v.mood) {
    parts.push(
      `SCENE MOOD / BACKGROUND (user-required for EVERY scene): show ${v.mood.positive}.` +
        (v.mood.avoid ? ` NEVER show ${v.mood.avoid}.` : ''),
    );
  }
  if (!parts.length) return '';
  return `\n\nUSER-REQUESTED ELEMENTS — MANDATORY, not optional (from the client's own brief): ${parts.join(' ')}`;
}

/** Overlay spec derived from the brief's asks (exact shape accepted by
 *  normalizeAssemblyOverlays/applyAssemblyOverlays). Bullets draw in scene 1
 *  with marker + bring-in times; the end-flash draws over the final seconds
 *  of the whole video. Returns null when the brief asked for none. */
export function buildBriefOverlaySpec(
  v: RequestedVisuals,
  sceneCount: number,
): { perScene?: { bullets: { text: string; marker: string; at: number }[] }[]; flash?: { text: string; durationSec: number; position?: 'center' | 'bottom' } } | null {
  const spec: { perScene?: { bullets: { text: string; marker: string; at: number }[] }[]; flash?: { text: string; durationSec: number; position?: 'center' | 'bottom' } } = {};
  if (v.bullets && v.bullets.length && sceneCount >= 1) {
    const step = v.bullets.length >= 4 ? 1.05 : 1.35;
    spec.perScene = [
      {
        bullets: v.bullets.slice(0, MAX_BULLETS).map((text, i) => ({
          text,
          marker: '\u2713',
          at: Number((0.9 + i * step).toFixed(2)),
        })),
      },
    ];
  }
  if (v.endFlash) {
    // OWNER (Oct 26, af053a01): the domain must FLASH AT THE BOTTOM of the
    // screen. The DERIVED spec (the faceless/Scene default when the request
    // carries no explicit overlays) lands bottom-positioned with a gentle
    // pulse; explicit render-time specs (no `position`) keep the legacy
    // centered end card.
    spec.flash = { text: v.endFlash.text, durationSec: 1.5, position: 'bottom' };
  }
  return spec.perScene || spec.flash ? spec : null;
}

// ─── TWIN PATH DICTATION ENFORCEMENT (task 08041dff, owner expansion rev 163) ─
//
// The Twin engine (cinemaEngineService.createNeuralTwin) has its OWN creative
// transformation step (transformTwinScriptToPitch) and does NOT run the shared
// planner/buildDictationSection — its deliverable is the twin SCRIPT text (the
// talking-head frame pipeline presents the script words on-screen; there is no
// timed overlay/assembly path). enforceTwinDictation is the deterministic
// post-enforcement that guarantees the owner's dictation bar on that path:
//   • dictated opening is the VERBATIM first line (never rephrased/dropped);
//   • user bullet points are presented as spoken script lines (≤ MAX_BULLETS);
//   • the exact end-flash domain is the closing CTA (never substituted);
//   • the brief's positive mood clause closes the pitch and the "instead of …"
//     pain point is SCRUBBED (never presented as a positive statement).
// Pure + idempotent: already-honoring script text is left untouched; no asks →
// no change. It never invents — every appended phrase is the user's own words.

export interface TwinDictationApplied {
  /** True when the dictated opening was prefixed (already-verbatim scripts stay untouched). */
  openingPrefixed: boolean;
  /** Bullet phrases appended as spoken lines (missing ones only). */
  bulletsAppended: string[];
  /** True when the end-flash domain CTA was appended. */
  flashAppended: boolean;
  /** True when the positive mood clause was appended as the closing line. */
  moodPositiveAppended: boolean;
  /** True when the pain-point/avoid phrase was scrubbed from the script. */
  avoidGuardApplied: boolean;
}

export interface TwinDictationEnforcement {
  /** Final twin script text after deterministic enforcement. */
  script: string;
  /** Exactly which guarantees were applied by THIS call (for metadata/diagnostics). */
  applied: TwinDictationApplied;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Deterministic twin-script enforcement — see block comment above. */
export function enforceTwinDictation(
  rawScript: string,
  requested: RequestedVisuals,
): TwinDictationEnforcement {
  let s = String(rawScript ?? '').replace(/\s+/g, ' ').trim();
  const applied: TwinDictationApplied = {
    openingPrefixed: false,
    bulletsAppended: [],
    flashAppended: false,
    moodPositiveAppended: false,
    avoidGuardApplied: false,
  };
  if (!s) return { script: s, applied };

  // 1. Dictated opening — VERBATIM prefix (never rephrased, never dropped).
  if (requested.dictatedOpening) {
    const opening = requested.dictatedOpening.replace(/[.]+$/, '').trim();
    if (opening && !s.toLowerCase().startsWith(opening.toLowerCase())) {
      s = `${opening}. ${s}`;
      applied.openingPrefixed = true;
    }
  }

  // 2. Bullets — user-requested on-screen points presented as script lines.
  for (const b of requested.bullets ?? []) {
    const item = b.replace(/[.]+$/, '').trim();
    if (!item || s.toLowerCase().includes(item.toLowerCase())) continue;
    s = `${s} ${item}.`;
    applied.bulletsAppended.push(item);
  }

  // 3. End-flash — EXACT user domain as the closing CTA when missing.
  if (requested.endFlash?.text) {
    const domain = requested.endFlash.text.trim();
    if (domain && !s.toLowerCase().includes(domain.toLowerCase())) {
      s = `${s} Go to ${domain} to get started!`;
      applied.flashAppended = true;
    }
  }

  // 4a. NEVER-guard — the "instead of …" pain point must never appear as a
  //     STATEMENT of what the video shows; scrub it (replace with the user's
  //     own positive clause when one was given).
  if (requested.mood?.avoid) {
    const avoid = requested.mood.avoid.replace(/[.;!?]+$/, '').trim();
    if (avoid) {
      const re = new RegExp(escapeRegExp(avoid), 'i');
      if (re.test(s)) {
        const replacement = requested.mood.positive
          ? requested.mood.positive.replace(/[.;!?]+$/, '').trim()
          : '';
        s = replacement
          ? s.replace(re, replacement)
          : s.replace(re, '');
        applied.avoidGuardApplied = true;
      }
    }
  }

  // 4b. Mood positive — the brief's own aspirational clause closes the pitch.
  if (requested.mood?.positive) {
    const pos = requested.mood.positive.replace(/[.;!?]+$/, '').trim();
    if (pos && !s.toLowerCase().includes(pos.toLowerCase())) {
      const first = pos.charAt(0).toUpperCase() + pos.slice(1);
      s = `${s} ${first}.`;
      applied.moodPositiveAppended = true;
    }
  }

  return { script: s.replace(/\s{2,}/g, ' ').trim(), applied };
}