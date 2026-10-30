/**
 * PLANNER FIDELITY (owner Oct 26 — Faceless live run af053a01, prod defect):
 * the relay worked (metadata.requestedVisuals non-null: dictatedOpening,
 * endFlash, mood; 7 conversation turns; 14 components) but the ONE LLM hop
 * between relay and scene generation — the planner — paraphrased the dictated
 * opening ("Say hello to…" instead of "Introducing…"), never turned the
 * relayed benefit components into on-screen bullet overlays (OCR of the
 * delivered video: ZERO on-screen text), ignored the mood imagery
 * (stressed→family sequence absent from every visualPrompt), and left the
 * scene-1 visualPrompt full of raw component-inventory garbage ("red").
 *
 * Stronger prompting is NOT the fix (buildDictationSection already reaches
 * the planner prompt — sceneVideoPipelineService.ts:2420 — and was ignored).
 * These are DETERMINISTIC post-plan enforcement passes: pure, zero LLM, zero
 * DB, zero paid calls. Every constant below is the owner's EXACT dictation
 * from production metadata — her words are the fixture.
 */

/** Minimal structural scene shape — deliberately does NOT import the pipeline
 *  service (avoids an import cycle: the service imports this module). */
export interface SceneLike {
  sceneNumber?: number;
  narration?: string | null;
  visualPrompt?: string | null;
  duration?: number;
}

/** ── (b) OPENING — verbatim dictated scene-1 line ─────────────────────────
 *  enforceTwinDictation-style guarantee for the shared planner path: when the
 *  owner dictated an opening and scene 1's narration does not already START
 *  with it, replace scene-1 narration with her line verbatim (terminal
 *  punctuation forced, never rephrased, never paraphrased). Idempotent: an
 *  honoring scene is left untouched. Pure.
 */
export function enforceDictatedOpening(
  script: SceneLike[],
  dictatedOpening: unknown,
): { script: SceneLike[]; patched: boolean } {
  const want = String(dictatedOpening ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!want || !Array.isArray(script) || script.length === 0) return { script, patched: false };
  const first = script[0];
  if (first === undefined) return { script, patched: false };
  const cur = String(first.narration ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cur.toLowerCase().startsWith(want.toLowerCase())) return { script, patched: false };
  const next = script.map((s) => ({ ...s }));
  const target = next[0];
  if (target === undefined) return { script, patched: false };
  target.narration = /[.!?]$/.test(want) ? want : `${want}.`;
  return { script: next, patched: true };
}

/** ── (f) F4 GRAMMAR — no "the transformation you 76 video creations…" splices ─
 *  The F4 injection backstop (injectSellingPointsIntoNarration →
 *  composeNarrationWithPhrase) appends a benefit phrase to a narration that
 *  was trimmed to make room WITHOUT guaranteeing a sentence boundary at the
 *  junction: production scene 3 = "And this is where it clicks — the
 *  transformation you 76 video creations a month." Fix: any bare
 *  "you <number> <benefit>" splice that is NOT already the grammatical
 *  "…gives you <number> <benefit>" is rewritten to "that gives you …" — a
 *  proper relative clause: "…the transformation that gives you 76 video
 *  creations a month." Idempotent (the rewrite's own "gives you" is exempt),
 *  engine-safe (fixed-length lookbehinds), pure.
 */
const YOU_NUMBER_SPLICE_RE =
  /(?<![.!?;:—–-])(?<!\bgives\s)you\s+[0-9][\d,.]*(\s+[^\s.!?][^.!?\n]*)?[.!?]?(?=\s|$)/gi;

export function grammarizeYouBenefitSplice(text: unknown): string {
  const t = String(text ?? '');
  if (!t || !YOU_NUMBER_SPLICE_RE.test(t)) return t;
  YOU_NUMBER_SPLICE_RE.lastIndex = 0;
  return t.replace(YOU_NUMBER_SPLICE_RE, (m: string) => `that gives you ${m.replace(/^you\s+/i, '')}`);
}

/** ── (T) TWIN ON-SCREEN SEAM — the owner's dictated bullet contents, rendered
 *  directly into the twin's SVG frame channel (the ONLY on-screen text path in
 *  cinemaEngineService on main — buildTalkingHeadSvg per-frame captions).
 *  Twin has no component-inventory/F4 machinery, so the canonical band lines are
 *  the owner's dictated bullet contents (shared with faceless; verbatim lock).
 *  Deterministic + pure — twin band is composed by twinBandMarkup + appended to
 *  the frame SVG via appendBandToSvg; fixtures run the REAL expressions.
 *  VERBATIM SCOPE (owner Oct 26): ONLY these dictated contents are forced on
 *  screen — all narration/connective text stays the model's own. ────────────── */
export const TWIN_CANONICAL_BULLETS: string[] = [
  'You get 76 video creations a month',
  'NO CREDIT BUYING',
  '50 designs a month',
  'Unlimited personal video editing',
];

/** Deterministic XML/SVG escape for dynamic text (band lines, domain). */
export function escapeXmlText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TwinBandOptions {
  bullets?: string[];
  domain?: string;
  frameIndex: number;
  totalFrames: number;
}

/** Pure: build the twin band <g> markup for ONE frame.
 *  - End frames (last 2 of totalFrames) with a domain: domain-only band at the
 *    bottom = the owner's \"domain flashing at the bottom of the screen\" end
 *    state (static band, no strobe).
 *  - Otherwise: the dictated bullets as a dark bottom band (<=4 lines, ✓ prefix)
 *    — a real on-screen bullet PANEL, not the 20px grey caption.
 *  - Nothing requested -> '' (frame untouched). */
export function twinBandMarkup(o: TwinBandOptions): string {
  const bullets = (o.bullets ?? []).slice(0, 4);
  const domain = String(o.domain ?? '').trim();
  const isEnd = o.totalFrames > 1 && o.frameIndex >= o.totalFrames - 2;
  if (isEnd && domain) {
    return [
      '<g id="ela-twin-band">',
      `<rect x="40" y="1560" width="1000" height="110" rx="14" fill="rgba(10,14,34,0.86)"/>`,
      `<text x="540" y="1636" text-anchor="middle" fill="#ffffff" font-size="44" font-weight="bold" font-family="Arial">${escapeXmlText(domain)}</text>`,
      '</g>',
    ].join('');
  }
  if (bullets.length) {
    const lines = bullets.map((b, i) => {
      const y = 1624 + i * 62;
      return `<text x="60" y="${y}" fill="#ffffff" font-size="34" font-family="Arial">\u2713 ${escapeXmlText(b)}</text>`;
    });
    return [
      '<g id="ela-twin-band">',
      `<rect x="40" y="1520" width="1000" height="${40 + bullets.length * 62 + 30}" rx="14" fill="rgba(10,14,34,0.86)"/>`,
      ...lines,
      '</g>',
    ].join('');
  }
  return '';
}

/** Pure: append band markup to a frame SVG (insert before closing tag). */
export function appendBandToSvg(svg: string, band: string): string {
  if (!band) return svg;
  return svg.includes('</svg>') ? svg.replace('</svg>', `${band}</svg>`) : `${svg}${band}`;
}

/** (b) TWIN MOOD VISUALS — owner Oct 26 mood sequence (stressed at work →
 *  relaxing with family) placed on the twin's SCENE VISUALS. Main's twin is the
 *  silent SVG pipeline; its only visual channel is the per-frame SVG, so a
 *  top-of-frame mood strip shifts cool (first half — the tense before-state,
 *  expressed ONLY as palette, never as a stated pain point) to warm with the
 *  positive clause captioned (second half — the aspirational payoff).
 *  NEVER-STATE guard: this helper only ever emits the POSITIVE clause or
 *  nothing — the avoid/negative state is structurally unrepresentable here
 *  (mirrors enforceTwinDictation's avoid-scrub; the owner's negative never
 *  appears on screen). Pure; deterministic per (frameIndex, totalFrames). */
export function twinMoodStripMarkup(
  moodPositive: string | null | undefined,
  frameIndex: number,
  totalFrames: number,
): string {
  const pos = String(moodPositive ?? '').trim();
  const late = totalFrames > 1 && frameIndex / totalFrames >= 0.55;
  const cool = 'rgba(23,32,52,0.45)';
  const warm = 'rgba(146,86,50,0.45)';
  const tint = late ? warm : cool;
  const caption = late && pos
    ? `<text x="40" y="60" fill="#ffffff" font-size="30" font-weight="bold" font-family="Arial">${escapeXmlText(pos.slice(0, 44).toUpperCase())}</text>`
    : '';
  return `<g id="ela-twin-mood"><rect x="0" y="0" width="1080" height="84" fill="${tint}"/>${caption}</g>`;
}

/** ── (d) MOOD IMAGERY — deterministic scene placement, never a raw dump ─────
 *  When requestedVisuals.mood.positive exists, map it onto the story arc the
 *  owner described ("show someone stressed working, show someone relaxing
 *  with family"): the STRESS keyword lands a before-state clause in scene-1's
 *  visualPrompt and the FAMILY/RELAX keyword lands the payoff clause in the
 *  LAST scene's visualPrompt. The raw mood text is NEVER injected (fixture:
 *  the sentence "someone relaxing with family; encouraging…" must never
 *  appear inside any visualPrompt). Idempotent: keyword pre-checks skip
 *  already-covered prompts. Pure.
 */
const STRESS_RE = /stressed|overwork|burnout|exhausted|overwhelmed/i;
const PAYOFF_ADDED_RE = /famil|relaxed|enjoying|peaceful|comfort/i;

function appendClauseToPrompt(prompt: unknown, clause: string): string {
  const v = String(prompt ?? '').trim();
  const joiner = /[.!?]$/.test(v) ? ' ' : ', ';
  const out = `${v}${joiner}${clause}`.replace(/\s{2,}/g, ' ').trim();
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

export function injectMoodIntoVisualPrompts(
  script: SceneLike[],
  moodPositive: unknown,
): { script: SceneLike[]; injectedScenes: number[] } {
  const mood = String(moodPositive ?? '').trim();
  if (!mood || !Array.isArray(script) || script.length === 0) return { script, injectedScenes: [] };
  const hasStress = STRESS_RE.test(mood);
  const hasPayoff = /famil|relax|peace|calm|comfort/i.test(mood);
  if (!hasStress && !hasPayoff) return { script, injectedScenes: [] };
  const next = script.map((s) => ({ ...s }));
  const injectedScenes: number[] = [];
  if (hasStress) {
    const s = next[0] ?? undefined;
    if (s !== undefined && !STRESS_RE.test(String(s.visualPrompt ?? ''))) {
      s.visualPrompt = appendClauseToPrompt(
        s.visualPrompt,
        'the opening beat shows them stressed and overworked before the transformation',
      );
      injectedScenes.push(s.sceneNumber ?? 1);
    }
  }
  if (hasPayoff) {
    const s = next[next.length - 1] ?? undefined;
    if (s !== undefined && !PAYOFF_ADDED_RE.test(String(s.visualPrompt ?? ''))) {
      s.visualPrompt = appendClauseToPrompt(
        s.visualPrompt,
        'the payoff shows them relaxed and enjoying time with family',
      );
      injectedScenes.push(s.sceneNumber ?? next.length);
    }
  }
  return { script: next, injectedScenes };
}

/** ── (c) BULLETS — on-screen overlay lines from the component inventory ─────
 *  The owner asked for bullet points ON SCREEN ("- these are bullet points to
 *  show on screen- need to fit screen." is a COMPONENT); the planner never
 *  produced overlay lines. Build them deterministically: pull every line out
 *  of the explicit bullet-block components ("Bulletin points- You get 76
 *  video creations a month!, NO CREDIT BUYING!!"), then top up to the 4
 *  canonical selling bullets ("76 video creations", "NO CREDIT BUYING",
 *  "50 designs", "Unlimited personal video editing") — each only if its key
 *  actually appears in the relayed inventory/selling points (never invented).
 *  ≤4 lines, ≤48 chars each, deduped, instructional meta-lines ("bullet
 *  points to show on screen") filtered out. Pure.
 */
const CANONICAL_BULLETS: ReadonlyArray<readonly [key: string, line: string]> = [
  ['76 video creations', '76 video creations a month'],
  ['no credit buying', 'NO CREDIT BUYING'],
  ['50 designs', '50 designs a month'],
  ['unlimited personal video editing', 'Unlimited personal video editing'],
];

export function buildBulletOverlayLines(components: unknown, sellingPoints: unknown): string[] {
  const comps = Array.isArray(components) ? components.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
  const sells = Array.isArray(sellingPoints) ? sellingPoints.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
  const haystack = [...comps, ...sells].join(' \u0001 ');
  const out: string[] = [];
  const pushLine = (raw: string): void => {
    const t = String(raw ?? '')
      .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
      // Drop a "Bulletin points-"-style block header if the split left one on
      // (the header itself is not a claim; "Bulletin" also contains "bullet",
      // so a naive /bullet/ filter would delete the actual claim line).
      .replace(/^bulletin\s+points?[:\-–\s]*/i, '')
      .replace(/^[\s\-•*;,:.!?]+/, '')
      .replace(/[.!?\s]+$/, '')
      .trim();
    // Meta/instruction lines only — the claim itself is always kept ("Bulletin
    // points- You get 76 video creations a month!" -> "You get 76 video
    // creations a month").
    if (!t || /points?\s+to\s+show|fit.?screen|on.?screen|show\s+on/i.test(t)) return;
    if (t.length > 48) return;
    if (out.some((o) => o.toLowerCase() === t.toLowerCase())) return;
    out.push(t);
  };
  for (const c of comps) {
    if (!/bullet|points? to show|on-screen|on screen/i.test(String(c))) continue;
    const parts = String(c).split(/[.!?]+\s+|,\s+(?=[A-Z0-9])|!\s*/);
    for (const p of parts) pushLine(p);
  }
  if (out.length < 4) {
    for (const [key, line] of CANONICAL_BULLETS) {
      if (out.length >= 4) break;
      if (!haystack.toLowerCase().includes(key.toLowerCase())) continue;
      if (out.some((o) => o.toLowerCase().includes(key.toLowerCase()))) continue;
      pushLine(line);
    }
  }
  return out.slice(0, 4);
}

/** Place ≤4 bullet lines into ONE scene-1 panel — the PROVEN render-#8 shape.
 *  MULTI-SCENE panelling is NOT expressible through the persisted overlay spec:
 *  normalizeAssemblyOverlays COMPACTS empty perScene groups, so after the
 *  metadata round-trip (sceneVideoPipelineService.ts:2871 re-normalizes at
 *  assembly time) only index 0 survives its scene position — placing panels on
 *  scenes 2/3 would silently re-map them onto scenes 1/2. Render #8's accepted
 *  panel (4 finished bullet phrases overlaid on scene 1, fitBulletFontSize
 *  autofit) is exactly this shape. Pure. */
export interface BulletPanel {
  sceneIndex: number;
  lines: string[];
}

export function distributeBulletPanels(lines: string[], sceneCount: number): BulletPanel[] {
  const l = lines.slice(0, 4);
  if (!l.length || sceneCount < 1) return [];
  return [{ sceneIndex: 0, lines: l }];
}

/** Merge bullet panels into an existing overlay spec (the `perScene` array is
 *  indexed BY SCENE: entry i applies to clip i, matching the assembly loop's
 *  index mapping in assemblyOverlays.applyAssemblyOverlays). Existing
 *  perScene groups (e.g. timed end-flash / requested bullets) are preserved;
 *  every other scene gets an EMPTY group so the same spec survives a
 *  re-normalization (never sparse-holes — normalizeAssemblyOverlays and the
 *  draw loop both tolerate empty groups). Pure. */
export function mergePerSceneBullets(
  spec: unknown,
  panels: BulletPanel[],
  sceneCount: number,
): Record<string, unknown> | null {
  const base: Record<string, unknown> = spec && typeof spec === 'object' && !Array.isArray(spec) ? (spec as Record<string, unknown>) : {};
  const existing = Array.isArray(base.perScene) ? (base.perScene as unknown[]) : [];
  const merged: unknown[] = Array.from({ length: sceneCount }, (_, i) => {
    const g = existing[i];
    return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
  });
  for (const panel of panels) {
    const idx = panel.sceneIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= merged.length) continue;
    const group = (merged[idx] as Record<string, unknown>) ?? {};
    const bullets = Array.isArray(group.bullets) ? (group.bullets as unknown[]) : [];
    const add = panel.lines
      .slice(0, Math.max(0, 4 - bullets.length))
      .map((text, i) => ({ text, marker: '\u2713', at: Number((0.9 + i * 1.1).toFixed(2)) }));
    const totalBullets = bullets.length + add.length;
    const tallPanel = totalBullets >= 3
      ? { x: 60, y: 1290, w: 960, h: 360, bg: DEEP_NAVY_PANEL_BG }
      : undefined;
    merged[idx] = { ...group, bullets: [...bullets, ...add], ...(tallPanel ? { panel: tallPanel } : {}) };
  }
  return { ...base, perScene: merged };
}

/** ── THE ENFORCEMENT ENTRY — run once per plan, AFTER the existing F4
 *  injection + benefit-text sanitizer, BEFORE the overlay spec is built.
 *  Deterministic order:
 *    1. mood imagery  → visualPrompts (scene-1 before-state, last-scene payoff)
 *    2. dictated opening → scene-1 narration verbatim
 *    3. grammarize every F4 benefit splice across all narrations
 *  (The service re-runs injectSellingPointsIntoNarration after this — the
 *  opening replacement may have erased a hook phrase; the idempotent injector
 *  re-appends it as a grammatical sentence AFTER the dictated line.)
 */
export interface PlannerFidelityInput {
  dictatedOpening?: unknown;
  moodPositive?: unknown;
}

export function enforcePlannerFidelity<S extends SceneLike>(
  script: S[],
  input: PlannerFidelityInput,
): { script: S[]; trace: string[] } {
  let next: S[] = script.map((s) => ({ ...s }));
  const trace: string[] = [];
  const mood = injectMoodIntoVisualPrompts(next, input.moodPositive);
  if (mood.script !== next) {
    next = mood.script as S[];
    if (mood.injectedScenes.length) trace.push(`moodInjected=[${mood.injectedScenes.join(',')}]`);
  }
  const opening = enforceDictatedOpening(next, input.dictatedOpening);
  if (opening.patched) {
    next = opening.script as S[];
    trace.push('openingPatched');
  }
  let grammarized = 0;
  next = next.map((s) => {
    const fixed = grammarizeYouBenefitSplice(String(s.narration ?? ''));
    if (fixed !== s.narration) {
      grammarized += 1;
      return { ...s, narration: fixed };
    }
    return s;
  });
  if (grammarized) trace.push(`grammarized=${grammarized}`);
  return { script: next, trace };
}
/* ═══════════════════════════════════════════════════════════════════════════
 * ROUND 2 (owner Oct 30 — live faceless run 399ef884, evidence
 * /home/team/shared/_arm5_evidence.txt). PR #132's enforcement is KEPT; these
 * are the three things it got wrong, all fixed deterministically (pure, zero
 * LLM, zero DB, zero paid calls):
 *
 *   DEFECT 1 — the end flash was HARDCODED to 1.5s. Her last chat turn
 *     ("Make sure the flashing EmpireLaunchAi.com is noticeable for the last 5
 *     seconds") was relayed in metadata.conversation and NOTHING consumed it.
 *     → resolveEndFlashTiming: parse an explicitly stated duration out of the
 *       user turns, clamp 1–10s and never longer than the final scene; 1.5s
 *       default when nothing is stated; "noticeable/prominent" = emphasis
 *       (bigger + brighter), duration is the must-have.
 *
 *   DEFECT 2 — component text spliced into narration mid-sentence ("…it clicks
 *     — the EmpireLaunch Ai Your go-to content creation platform." / "…in front
 *     of you. 50 designs a month."). Standing rule: ONLY her dictated lines are
 *     verbatim; every other narration line must read as a sentence.
 *     → sanitizeComponentSpliceFromNarration: drop a component/bullet fragment
 *       that is not grammatically integrated (bare-fragment sentence, or glued
 *       into a verb-less dangling clause). Dictated opening + domain line are
 *       protected; clean narration is a byte-exact no-op.
 *
 *   DEFECT 3 — the bullet panel rendered black@0.85; the owner approved (typed
 *     "Yes") white text on DEEP NAVY panels in a bold rounded sans.
 *     → DEEP_NAVY_PANEL_BG (0x0a1f44@0.85, the same navy the accepted bottom
 *       flash band uses) + a bundled Poppins ExtraBold candidate in
 *       assemblyOverlays.resolveOverlayFont (DejaVu Sans Bold fallback).
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ── DEFECT 1: END-FLASH DURATION FROM THE RELAYED CONVERSATION ──────────── */

/** Today's behaviour when the conversation states no duration (render #8). */
export const FLASH_DEFAULT_SECONDS = 1.5;
export const FLASH_MIN_SECONDS = 1;
export const FLASH_MAX_SECONDS = 10;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "five seconds" → "5 seconds" so the numeric patterns see one shape. */
function normalizeSpokenSeconds(text: string): string {
  return text.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(seconds?|secs?)\b/gi,
    (_m, w: string, u: string) => `${NUMBER_WORDS[w.toLowerCase()] ?? ''} ${u}`,
  );
}

/** Duration phrasings, in priority order. Her EXACT sentence —
 *  "…noticeable for the last 5 seconds" — is matched by pattern 1. */
const FLASH_DURATION_PATTERNS: RegExp[] = [
  /\b(?:last|final)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i,
  /\bfor\s+(?:the\s+)?(?:last\s+|final\s+)?(\d+(?:\.\d+)?)\s*(?:seconds?|secs?)\b/i,
  /\b(\d+(?:\.\d+)?)\s*-?\s*(?:seconds?|secs?)\s+(?:at\s+the\s+(?:very\s+)?end|of\s+the\s+end|long)\b/i,
  /\b(\d+(?:\.\d+)?)\s*-?\s*(?:seconds?|secs?)\s+(?:flash|flashing|domain)\b/i,
  /\b(?:flash|flashing|domain)\b[^.!?\n]{0,40}?\b(\d+(?:\.\d+)?)\s*-?\s*(?:seconds?|secs?)\b/i,
];

/** Is this sentence about the end flash (so its number is a FLASH duration and
 *  not, say, the video length)? */
const FLASH_SENTENCE_RE = /\bflash|flashing|domain|empirelaunchai|empirelaunch\s+ai\.com|\bwebsite\b|\burl\b|\bsite\b/i;

/** Explicitly stated end-flash duration in the relayed user turns, or
 *  undefined when the owner never stated one. Latest statement wins. Pure. */
export function extractRequestedFlashSeconds(raw: unknown): number | undefined {
  const text = normalizeSpokenSeconds(String(raw ?? '').replace(/\s+/g, ' ').trim());
  if (!text) return undefined;
  let found: number | undefined;
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const flashSentence = FLASH_SENTENCE_RE.test(sentence) || /\b(?:last|final)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?)/i.test(sentence);
    if (!flashSentence) continue;
    for (const re of FLASH_DURATION_PATTERNS) {
      const m = re.exec(sentence);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) {
        found = n;
        break;
      }
    }
  }
  return found;
}

/** "noticeable / prominent / hard to miss" = the owner wants it LOUDER, not
 *  longer. Cheap emphasis flag (bigger + brighter), never a duration. Pure. */
const FLASH_EMPHASIS_RE = /\bnoticeable|noticeably|prominent|prominently|hard\s+to\s+miss|obvious|bold|bigger|large|clear(?:ly)?\s+visible|make\s+it\s+pop\b/i;

export function extractFlashEmphasis(raw: unknown): boolean {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return text
    .split(/(?<=[.!?])\s+/)
    .some((s) => FLASH_SENTENCE_RE.test(s) && FLASH_EMPHASIS_RE.test(s));
}

export interface EndFlashTiming {
  /** Final flash window length (seconds) — 1.5 default, 1–10 clamp, never
   *  longer than the final scene. */
  durationSec: number;
  /** Owner asked for it to be noticeable/prominent → bigger + brighter. */
  emphasis: boolean;
  /** True when the conversation explicitly stated a duration. */
  stated: boolean;
}

/** Resolve the end-flash window from the relayed conversation (deterministic,
 *  zero LLM). `finalSceneSeconds` bounds it: the flash lives inside the final
 *  scene, so it can never be longer than that scene. Pure. */
export function resolveEndFlashTiming(input: {
  conversationText?: unknown;
  finalSceneSeconds?: unknown;
}): EndFlashTiming {
  const raw = String(input.conversationText ?? '');
  const statedSeconds = extractRequestedFlashSeconds(raw);
  const emphasis = extractFlashEmphasis(raw);
  const finalScene = Number(input.finalSceneSeconds);
  const sceneCap = Number.isFinite(finalScene) && finalScene > 0 ? Math.max(0.5, finalScene) : FLASH_MAX_SECONDS;
  const requested = statedSeconds === undefined
    ? FLASH_DEFAULT_SECONDS
    : Math.min(FLASH_MAX_SECONDS, Math.max(FLASH_MIN_SECONDS, statedSeconds));
  return {
    durationSec: Number(Math.min(requested, sceneCap).toFixed(2)),
    emphasis,
    stated: statedSeconds !== undefined,
  };
}

/** Apply the resolved timing to an overlay spec (the flash object only — the
 *  bullets / bottomBar / per-scene groups are untouched). NOTHING stated and no
 *  emphasis → the spec is returned BY REFERENCE (byte-exact legacy behaviour,
 *  including explicit render-time specs that carry their own duration). Pure. */
export function applyFlashTimingToOverlaySpec<T>(spec: T, timing: EndFlashTiming): T {
  if (!timing.stated && !timing.emphasis) return spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const base = spec as Record<string, unknown>;
  const flash = base.flash;
  if (!flash || typeof flash !== 'object' || Array.isArray(flash)) return spec;
  const nextFlash: Record<string, unknown> = { ...(flash as Record<string, unknown>) };
  if (timing.stated) nextFlash.durationSec = timing.durationSec;
  if (timing.emphasis) nextFlash.emphasis = true;
  return { ...base, flash: nextFlash } as unknown as T;
}

/* ── DEFECT 2: COMPONENT FRAGMENTS SPLICED INTO NARRATION ────────────────── */

/** Words that make a clause a real sentence (subject + finite verb). Used ONLY
 *  to decide whether a clause that carries a glued component phrase is a
 *  dangling fragment; the list is generous on purpose. */
const FINITE_VERBS = new Set<string>([
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being',
  'has', 'have', 'had', 'do', 'does', 'did', 'done',
  'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must',
  'get', 'gets', 'got', 'gotten', 'give', 'gives', 'gave', 'given',
  'include', 'includes', 'included', 'offer', 'offers', 'offered',
  'deliver', 'delivers', 'delivered', 'come', 'comes', 'came',
  'make', 'makes', 'made', 'save', 'saves', 'saved', 'click', 'clicks', 'clicked',
  'work', 'works', 'worked', 'feel', 'feels', 'felt', 'look', 'looks', 'looked',
  'want', 'wants', 'wanted', 'need', 'needs', 'needed', 'take', 'takes', 'took',
  'show', 'shows', 'showed', 'shown', 'create', 'creates', 'created',
  'unlock', 'unlocks', 'unlocked', 'bring', 'brings', 'brought',
  'turn', 'turns', 'turned', 'keep', 'keeps', 'kept', 'start', 'starts', 'started',
  'build', 'builds', 'built', 'find', 'finds', 'found', 'see', 'sees', 'saw', 'seen',
  'know', 'knows', 'knew', 'love', 'loves', 'loved', 'enjoy', 'enjoys', 'enjoyed',
  'pay', 'pays', 'paid', 'cost', 'costs', 'use', 'uses', 'used', 'let', 'lets',
  'help', 'helps', 'helped', 'run', 'runs', 'ran', 'grow', 'grows', 'grew',
  'add', 'adds', 'added', 'mean', 'means', 'meant', 'lets', 'ready', 'stay', 'stays',
  'stop', 'stops', 'stopped', 'become', 'becomes', 'became', 'look', 'sound', 'sounds',
  'matter', 'matters', 'counts', 'count', 'bring', 'moves', 'move', 'moved',
]);

function hasFiniteVerb(clause: string): boolean {
  const words = String(clause ?? '').toLowerCase().match(/[a-z']+/g) ?? [];
  return words.some((w) => FINITE_VERBS.has(w.replace(/'s$/, '')) || FINITE_VERBS.has(w));
}

const CLAUSE_BOUNDARY = /[\u2014\u2013;:,-]/;
/** Index just AFTER the last clause boundary in `s`, or 0. */
function clauseStartIndex(s: string): number {
  let idx = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (CLAUSE_BOUNDARY.test(s[i] ?? '')) {
      idx = i + 1;
      break;
    }
  }
  return idx;
}

/** Connectors that make a component phrase GRAMMATICALLY integrated (it is the
 *  object of a real verb / a relative clause / a list item), e.g.
 *  "…that gives you 76 video creations a month." Pure. */
const INTEGRATOR_TAIL_RE =
  /(?:\b(?:get|gets|got|give|gives|giving|include|includes|included|offer|offers|deliver|delivers|come|comes|with|means|add|adds|unlock|unlocks|bring|brings|yield|yields|plus|and|or|also|to|of|for|in|on)\s*|\bgives?\s+you\s*|\byou\s+(?:get|receive|enjoy)\s*)$/i;

function normalizePhraseList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of list) {
    const p = String(item ?? '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/^[\s\-–—•*.;:]+/, '')
      .replace(/[\s.!?;:,]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (p.length < 8) continue; // 'red' and other one-word noise never qualify
    if (out.some((o) => o.toLowerCase() === p.toLowerCase())) continue;
    out.push(p);
  }
  return out;
}

/** Whitespace-flexible, dash-flexible, case-insensitive matcher for a phrase. */
function phraseRegExp(phrase: string): RegExp {
  const body = phrase
    .split(/\s+/)
    .map((tok) =>
      tok
        .split('')
        .map((ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch))
        .join('')
        .replace(/[-\u2013\u2014]/g, '[\\-\\u2013\\u2014]'),
    )
    .join('\\s+');
  return new RegExp(body, 'gi');
}

interface PhraseHit {
  index: number;
  length: number;
  phrase: string;
}

/** First component phrase in `body` that is NOT grammatically integrated. */
function findSplice(body: string, phrases: { phrase: string; re: RegExp }[]): PhraseHit | undefined {
  let best: PhraseHit | undefined;
  for (const { phrase, re } of phrases) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const index = m.index;
      const length = m[0].length;
      const before = body.slice(0, index).trimEnd();
      const after = body.slice(index + length);
      const hostStart = clauseStartIndex(before);
      const hostClause = before.slice(hostStart).trim();
      const integrated =
        (before.length > 0 && INTEGRATOR_TAIL_RE.test(before)) ||
        (before.length === 0 && hasFiniteVerb(phrase)) ||
        (before.length > 0 &&
          /,$/.test(before) &&
          /^[\s.!?;:,\u2013\u2014-]*$/.test(after) &&
          hasFiniteVerb(hostClause));
      if (!integrated) {
        const hit = { index, length, phrase };
        // Longest phrase first — a longer match subsumes a shorter one.
        if (!best || hit.length > best.length) best = hit;
      }
    }
  }
  return best;
}

/** Drop ONE non-integrated phrase occurrence from a sentence body and repair the
 *  junction (never leave a mid-clause break or two fragments glued). */
function removeSplice(body: string, hit: PhraseHit): string {
  const before = body.slice(0, hit.index).replace(/\s+$/, '');
  const after = body.slice(hit.index + hit.length).replace(/^\s+/, '');
  const hostStart = clauseStartIndex(before);
  const hostClause = before.slice(hostStart).trim();
  const hostIsDangling = !hasFiniteVerb(hostClause) && hostClause.split(/\s+/).filter(Boolean).length <= 10;
  if (hostIsDangling) {
    // The clause the fragment was glued onto has no verb of its own ("…it
    // clicks — the EmpireLaunch Ai") → the WHOLE dangling clause goes with the
    // fragment, boundary punctuation included.
    const head = before
      .slice(0, hostStart)
      .replace(/[\s\u2014\u2013;:,-]+$/, '')
      .trim();
    if (!head) return after.trim();
    return `${head}${after.trim() ? ` ${after.trim()}` : ''}`.replace(/\s+/g, ' ').trim();
  }
  return `${before}${after ? ` ${after}` : ''}`
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

export interface NarrationSanitizeOptions {
  /** Component / bullet / selling-point phrases that must never appear as a
   *  bare fragment inside narration. */
  phrases?: unknown;
  /** Lines that must NEVER be touched — the owner's dictated opening and the
   *  end-flash domain line. */
  protect?: unknown;
}

export interface NarrationSanitizeResult {
  /** Sanitized narration. BYTE-EXACT copy of the input when nothing was spliced. */
  text: string;
  /** Fragments removed (for the audit trace). */
  removed: string[];
}

function protectedText(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((v) =>
      String(v ?? '')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\s.!?;:,]+$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase(),
    )
    .filter((v) => v.length >= 4);
}

/** THE SANITIZER (defect 2). Removes component/bullet fragments from a
 *  narration line UNLESS they are grammatically integrated:
 *   • a whole sentence that is only a fragment ("…in front of you. 50 designs
 *     a month." → "…in front of you.") is dropped;
 *   • a fragment glued onto a verb-less dangling clause ("…it clicks — the
 *     EmpireLaunch Ai Your go-to content creation platform." → "…it clicks.")
 *     takes that clause with it.
 *  Protected lines (dictated opening, domain line) and integrated phrases
 *  ("…that gives you 76 video creations a month.") are untouched; clean
 *  narration comes back byte-identical. Pure + deterministic. */
export function sanitizeComponentSpliceFromNarration(
  narration: unknown,
  opts: NarrationSanitizeOptions = {},
): NarrationSanitizeResult {
  const text = String(narration ?? '');
  if (!text.trim()) return { text, removed: [] };
  const protect = protectedText(opts.protect);
  const candidates = normalizePhraseList(opts.phrases).filter(
    (p) => !protect.some((pr) => pr.includes(p.toLowerCase()) || p.toLowerCase().includes(pr)),
  );
  if (!candidates.length) return { text, removed: [] };
  // Longest phrase first so "EmpireLaunch Ai — the new content creation
  // platform" wins over the shorter "your new content creation platform".
  const phrases = candidates
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((phrase) => ({ phrase, re: phraseRegExp(phrase) }));

  const removed: string[] = [];
  const chunks = text.split(/(?<=[.!?])\s+/);
  const outChunks: string[] = [];
  for (const chunk of chunks) {
    const trimmedEnd = chunk.replace(/[.!?]+[)\]"'\u201d\u2019]*$/, '');
    const term = chunk.slice(trimmedEnd.length);
    let body = trimmedEnd;
    const lowerBody = body.replace(/\s+/g, ' ').trim().toLowerCase();
    const isProtected =
      protect.some((pr) => lowerBody.includes(pr)) ||
      protect.some((pr) => pr.length > 12 && lowerBody.length > 0 && pr.includes(lowerBody));
    if (isProtected) {
      outChunks.push(chunk);
      continue;
    }
    for (let pass = 0; pass < 4; pass++) {
      const hit = findSplice(body, phrases);
      if (!hit) break;
      const next = removeSplice(body, hit);
      if (next === body) break;
      removed.push(hit.phrase);
      body = next;
    }
    if (!body.trim()) continue; // the whole sentence was the fragment
    const needsTerm = !/[.!?]$/.test(body.trim());
    outChunks.push(`${body.trim()}${needsTerm ? term || '.' : ''}`);
  }
  if (!removed.length) return { text, removed };
  const joined = outChunks.join(' ').replace(/\s+/g, ' ').trim();
  return { text: joined, removed };
}

export interface PlanSpliceSanitizeResult<S extends SceneLike> {
  script: S[];
  /** 1-based scene numbers whose narration changed. */
  changedScenes: number[];
  removed: string[];
}

/** Plan-level defect-2 pass — one sanitized narration per scene. Scenes with
 *  clean narration are returned by reference (no-op). Pure. */
export function sanitizePlanComponentSplices<S extends SceneLike>(
  script: S[],
  opts: NarrationSanitizeOptions = {},
): PlanSpliceSanitizeResult<S> {
  if (!Array.isArray(script) || script.length === 0) return { script, changedScenes: [], removed: [] };
  const changedScenes: number[] = [];
  const removed: string[] = [];
  const next = script.map((scene, i) => {
    const res = sanitizeComponentSpliceFromNarration(scene.narration, opts);
    if (res.text === scene.narration) return scene;
    changedScenes.push(scene.sceneNumber ?? i + 1);
    removed.push(...res.removed);
    return { ...scene, narration: res.text };
  });
  if (!changedScenes.length) return { script, changedScenes, removed };
  return { script: next, changedScenes, removed };
}

/** DEEP NAVY panel for on-screen bullets (owner typed "Yes" to "white text on
 *  deep navy panels" — same navy as the accepted bottom-flash band). */
export const DEEP_NAVY_PANEL_BG = '0x0a1f44@0.85';
