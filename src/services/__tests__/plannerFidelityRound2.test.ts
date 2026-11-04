/**
 * PLANNER FIDELITY — ROUND 2 (owner Oct 30, live faceless run 399ef884).
 * PR #132's enforcement is KEPT; these fixtures cover the THREE things it got
 * wrong, all fixed deterministically (pure — no LLM, no DB, no paid calls).
 * Ground truth = the owner's own run (evidence: /home/team/shared/_arm5_evidence.txt):
 *
 *   DEFECT 1 — stored overlay spec was {"flash":{"text":"EmpireLaunchAi.com",
 *     "position":"bottom","durationSec":1.5}} although her LAST chat turn said
 *     "Make sure the flashing EmpireLaunchAi.com is noticeable for the last 5
 *     seconds". Nothing consumed that turn → the flash was hardcoded 1.5s.
 *   DEFECT 2 — component text spliced into narration mid-sentence:
 *     scene 3 "And this is where it clicks — the EmpireLaunch Ai Your go-to
 *     content creation platform."
 *     scene 4 "That's the payoff — real results, right in front of you. 50
 *     designs a month."                      ("that line just annoys me")
 *   DEFECT 3 — the bullet panel rendered black@0.85; the owner typed "Yes" to
 *     white text on DEEP NAVY panels in a bold rounded sans.
 *
 * Every fixture below runs the REAL production expressions:
 *   • plannerFidelity.ts  resolveEndFlashTiming / applyFlashTimingToOverlaySpec
 *                         / sanitizeComponentSpliceFromNarration
 *                         / sanitizePlanComponentSplices / mergePerSceneBullets
 *   • requestedVisuals.ts buildBriefOverlaySpec   (the derived spec)
 *   • assemblyOverlays.ts normalizeAssemblyOverlays / resolveBulletPanel
 *                         / resolveOverlayFont
 *   • cinemaEngineService.ts:95-105 twin seam (sanitize → enforceTwinDictation)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  DEEP_NAVY_PANEL_BG,
  FLASH_DEFAULT_SECONDS,
  FLASH_MAX_SECONDS,
  applyFlashTimingToOverlaySpec,
  extractFlashEmphasis,
  extractRequestedFlashSeconds,
  mergePerSceneBullets,
  resolveEndFlashTiming,
  sanitizeComponentSpliceFromNarration,
  sanitizePlanComponentSplices,
  type SceneLike,
} from '../plannerFidelity.js';
import { buildBriefOverlaySpec, enforceTwinDictation, type RequestedVisuals } from '../requestedVisuals.js';
import { normalizeAssemblyOverlays, resolveBulletPanel, resolveOverlayFont } from '../assemblyOverlays.js';

// ── OWNER'S EXACT RUN 399ef884 ─────────────────────────────────────────────
const DICTATED_OPENING = 'Introducing EmpireLaunch Ai, your new content creation platform';
const DICTATED_OPENING_EXACT = 'Introducing EmpireLaunch Ai, your new content creation platform.';
const END_FLASH_TEXT = 'EmpireLaunchAi.com';
const DOMAIN_LINE = 'Ready to make the move? You can get started today. Go to Empirelaunchai.com.';

/** The relayed conversation (7 turns; the owner-facing text of each user turn).
 *  Turn 6 is her duration ask — the sentence that was relayed and ignored. */
const HER_FLASH_SENTENCE = 'Make sure the flashing EmpireLaunchAi.com is noticeable for the last 5 seconds';
const CONVERSATION_NO_DURATION = [
  'Introducing EmpireLaunch Ai, your new content creation platform. I want bullet points on screen - You get 76 video creations a month!, NO CREDIT BUYING!!, 50 designs a month!, Unlimited personal video editing! - these are bullet points to show on screen- need to fit screen.',
  'Yes',
  'Launch',
].join(' ');
const CONVERSATION_WITH_DURATION = `${CONVERSATION_NO_DURATION} ${HER_FLASH_SENTENCE}`;

/** The relayed component inventory / selling points (same brief as af053a01 —
 *  the owner's 4 bullets + the finished-essence phrases the planner echoes). */
const COMPONENTS = [
  'your new content creation platform.',
  'edit personal videos or create designs for products!',
  'red',
  'EmpireLaunch Ai — the new content creation platform.',
  '76 video creations a month.',
  '50 designs a month.',
  'Go to Empirelaunchai.com.',
  'Your go-to content creation platform.',
  'Introducing EmpireLaunch Ai, your new content creation platform.',
  'Bulletin points- You get 76 video creations a month!, NO CREDIT BUYING!!',
  '50 designs a month!',
  'Unlimited personal video editing!',
  '- these are bullet points to show on screen- need to fit screen.',
  'This saves hundreds per month and hours of your time.',
];
const SELLING_POINTS = [
  'EmpireLaunch Ai — the new content creation platform.',
  '76 video creations a month.',
  '50 designs a month.',
  'Go to Empirelaunchai.com.',
  'Your go-to content creation platform.',
];
const PHRASES = [...COMPONENTS, ...SELLING_POINTS];
const PROTECT = [DICTATED_OPENING, END_FLASH_TEXT];

/** The 5 delivered scenes — narration VERBATIM from the owner's run. */
const PLAN: SceneLike[] = [
  { sceneNumber: 1, duration: 7, narration: DICTATED_OPENING_EXACT },
  { sceneNumber: 2, duration: 7, narration: 'The essentials come together fast, and the process is simpler than it looks.' },
  { sceneNumber: 3, duration: 8, narration: 'And this is where it clicks — the EmpireLaunch Ai Your go-to content creation platform.' },
  { sceneNumber: 4, duration: 6, narration: "That's the payoff — real results, right in front of you. 50 designs a month." },
  { sceneNumber: 5, duration: 7, narration: DOMAIN_LINE },
];

/* ══ DEFECT 1 — the end flash honors an explicitly stated duration ═════════ */

test('flash.duration: her EXACT sentence states 5 seconds', () => {
  assert.equal(extractRequestedFlashSeconds(HER_FLASH_SENTENCE), 5);
  // The full relayed conversation (her other turns never state a duration).
  assert.equal(extractRequestedFlashSeconds(CONVERSATION_WITH_DURATION), 5);
});

test('flash.duration: nothing stated -> no number (default path)', () => {
  assert.equal(extractRequestedFlashSeconds(CONVERSATION_NO_DURATION), undefined);
  assert.equal(extractRequestedFlashSeconds(''), undefined);
  // A duration that is NOT about the flash must never be mistaken for one.
  assert.equal(extractRequestedFlashSeconds('I want the video to be 30 seconds long.'), undefined);
});

test('flash.duration: resolveEndFlashTiming — 1.5s default vs 5s stated, through the REAL derived spec', () => {
  const requested: RequestedVisuals = { endFlash: { text: END_FLASH_TEXT }, dictatedOpening: DICTATED_OPENING };

  // ── PRE-FIX BEHAVIOUR (what the owner got): derived spec is hardcoded 1.5s
  //    and the relayed duration ask never reaches it.
  const derived = buildBriefOverlaySpec(requested, PLAN.length);
  assert.ok(derived);
  assert.equal((derived!.flash as { durationSec: number }).durationSec, FLASH_DEFAULT_SECONDS);

  // ── DEFAULT (nothing stated): unchanged 1.5s, spec returned BY REFERENCE.
  const defaultTiming = resolveEndFlashTiming({ conversationText: CONVERSATION_NO_DURATION, finalSceneSeconds: 7 });
  assert.deepEqual({ ...defaultTiming }, { durationSec: 1.5, emphasis: false, stated: false });
  assert.equal(applyFlashTimingToOverlaySpec(derived, defaultTiming), derived, 'no statement -> byte-exact legacy spec');

  // ── HER ASK: 5s + emphasis, end to end through normalize (the persisted shape).
  const statedTiming = resolveEndFlashTiming({ conversationText: CONVERSATION_WITH_DURATION, finalSceneSeconds: 7 });
  assert.deepEqual({ ...statedTiming }, { durationSec: 5, emphasis: true, stated: true });
  const withTiming = applyFlashTimingToOverlaySpec(derived, statedTiming) as Record<string, unknown>;
  const normalized = normalizeAssemblyOverlays(withTiming, PLAN.length);
  assert.ok(normalized?.flash);
  // PRE-FIX the normalizer's `dur <= 3` clamp DROPPED 5 → the 1.2s default.
  assert.equal(normalized!.flash!.durationSec, 5, 'explicitly stated 5s survives normalization');
  assert.equal(normalized!.flash!.position, 'bottom');
  assert.equal(normalized!.flash!.emphasis, true);
});

test('flash.duration: clamp 1-10s and never longer than the final scene', () => {
  assert.equal(resolveEndFlashTiming({ conversationText: 'flash the domain for the last 30 seconds', finalSceneSeconds: 20 }).durationSec, FLASH_MAX_SECONDS);
  assert.equal(resolveEndFlashTiming({ conversationText: 'flash the domain for 1 seconds', finalSceneSeconds: 7 }).durationSec, 1);
  assert.equal(resolveEndFlashTiming({ conversationText: HER_FLASH_SENTENCE, finalSceneSeconds: 4 }).durationSec, 4, 'never longer than the final scene');
  // Word numbers + "for N seconds" phrasings parse too.
  assert.equal(extractRequestedFlashSeconds('make the domain flash for five seconds'), 5);
  assert.equal(extractRequestedFlashSeconds('the domain should be on screen for 2 seconds at the end'), 2);
  assert.equal(extractFlashEmphasis(HER_FLASH_SENTENCE), true);
  assert.equal(extractFlashEmphasis('Make the domain flash for the last 3 seconds'), false);
});

/* ══ DEFECT 2 — no component fragments spliced into narration ═════════════ */

test('splice: scene 3 — the glued component leaves a clean sentence', () => {
  const s3 = PLAN[2]!;
  const out = sanitizeComponentSpliceFromNarration(s3.narration, { phrases: PHRASES, protect: PROTECT });
  assert.equal(out.text, 'And this is where it clicks.');
  assert.ok(!/go-to|Your go-to/i.test(out.text), 'component fragment removed');
  assert.ok(!/\u2014/.test(out.text), 'no mid-clause break left behind');
  assert.deepEqual(out.removed, ['Your go-to content creation platform']);
});

test('splice: scene 4 — the bare fragment sentence is dropped', () => {
  const s4 = PLAN[3]!;
  const out = sanitizeComponentSpliceFromNarration(s4.narration, { phrases: PHRASES, protect: PROTECT });
  assert.equal(out.text, "That's the payoff — real results, right in front of you.");
  assert.ok(!/50 designs/i.test(out.text));
});

test('splice: clean narration is a BYTE-EXACT no-op', () => {
  const clean = [
    PLAN[1]!.narration,
    DICTATED_OPENING_EXACT,
    DOMAIN_LINE,
    // The GRAMMATICAL F4 splice PR #132 fixed must never be touched.
    'And this is where it clicks — the transformation that gives you 76 video creations a month.',
    'You get 76 video creations a month, and 50 designs a month.',
    '',
  ];
  for (const line of clean) {
    const out = sanitizeComponentSpliceFromNarration(line, { phrases: PHRASES, protect: PROTECT });
    assert.equal(out.text, line, `no-op expected for: ${line}`);
    assert.deepEqual(out.removed, []);
  }
});

test('splice: her dictated opening + the domain line are PROTECTED', () => {
  // 'your new content creation platform' IS a relayed component — the dictated
  // opening must still survive verbatim (only her lines are locked; they are
  // never "sanitized").
  const opening = sanitizeComponentSpliceFromNarration(DICTATED_OPENING_EXACT, { phrases: PHRASES, protect: PROTECT });
  assert.equal(opening.text, DICTATED_OPENING_EXACT);
  const domain = sanitizeComponentSpliceFromNarration(DOMAIN_LINE, { phrases: PHRASES, protect: PROTECT });
  assert.equal(domain.text, DOMAIN_LINE);
});

test('splice: plan pass touches ONLY the two offending scenes (1,2,5 by reference)', () => {
  const plan = PLAN.map((s) => ({ ...s }));
  const out = sanitizePlanComponentSplices(plan, { phrases: PHRASES, protect: PROTECT });
  assert.deepEqual(out.changedScenes, [3, 4]);
  assert.equal(out.script[0]!.narration, DICTATED_OPENING_EXACT);
  assert.equal(out.script[1]!.narration, PLAN[1]!.narration);
  assert.equal(out.script[4]!.narration, DOMAIN_LINE);
  assert.equal(out.script[0], plan[0], 'untouched scene keeps its identity (no churn)');
  assert.equal(out.script[2]!.narration, 'And this is where it clicks.');
  assert.equal(out.script[3]!.narration, "That's the payoff — real results, right in front of you.");
  // No-op plan (already clean) → same array, nothing changed.
  const clean = sanitizePlanComponentSplices(out.script, { phrases: PHRASES, protect: PROTECT });
  assert.equal(clean.script, out.script);
  assert.deepEqual(clean.changedScenes, []);
});

test('splice: TWIN seam — same sanitizer, applied to the pitch BEFORE the dictated lines', () => {
  // The twin's own pitch copy is glued the same way the planner's is.
  const twinPitch = 'And this is where it clicks — the EmpireLaunch Ai Your go-to content creation platform.';
  const requested: RequestedVisuals = {
    dictatedOpening: DICTATED_OPENING,
    bullets: ['You get 76 video creations a month', 'NO CREDIT BUYING'],
    endFlash: { text: END_FLASH_TEXT },
  };
  const cleaned = sanitizeComponentSpliceFromNarration(twinPitch, {
    phrases: requested.bullets ?? [],
    protect: [requested.dictatedOpening, requested.endFlash?.text],
  });
  // (Bullets are not in the pitch here, so the pitch is a no-op — the twin's
  //  splice risk is its OWN copy, which carries no bullet text.)
  assert.equal(cleaned.text, twinPitch);
  // The seam's real guarantee: the enforced script keeps her dictated lines
  // verbatim — which is exactly why the sanitizer runs BEFORE enforcement.
  const enforced = enforceTwinDictation(twinPitch, requested);
  assert.ok(enforced.script.toLowerCase().startsWith(DICTATED_OPENING.toLowerCase()));
  assert.ok(enforced.script.includes('You get 76 video creations a month'));
  assert.ok(enforced.script.includes(END_FLASH_TEXT));
  // A glued bullet fragment in the pitch IS removed before enforcement runs.
  const glued = 'Ready to grow? Your go-to content creation platform.';
  const pre = sanitizeComponentSpliceFromNarration(glued, { phrases: PHRASES, protect: PROTECT });
  assert.equal(pre.text, 'Ready to grow?');
  // And a clean pitch is a byte-exact no-op through the same expression.
  assert.equal(sanitizeComponentSpliceFromNarration(PLAN[1]!.narration, { phrases: PHRASES, protect: PROTECT }).text, PLAN[1]!.narration);
});

/* ══ DEFECT 3 — deep navy bullet panel + bold rounded sans ════════════════ */

test('panel: bullets draw on a DEEP NAVY panel, not black@0.85', () => {
  assert.equal(DEEP_NAVY_PANEL_BG, '0x0a1f44@0.85');
  const spec = mergePerSceneBullets(
    { flash: { text: END_FLASH_TEXT, durationSec: 1.5, position: 'bottom' } },
    [{ sceneIndex: 0, lines: ['You get 76 video creations a month', 'NO CREDIT BUYING', '50 designs a month'] }],
    5,
  );
  assert.ok(spec);
  const perScene = spec!.perScene as Array<{ panel?: { bg?: string } }>;
  assert.equal(perScene[0]?.panel?.bg, DEEP_NAVY_PANEL_BG);
  assert.equal((spec as Record<string, unknown>).flash && (spec as { flash: { position: string } }).flash.position, 'bottom', 'flash untouched');
  // The panel default (legacy specs with no bg) is navy too.
  assert.equal(resolveBulletPanel(undefined).bg, DEEP_NAVY_PANEL_BG);
});

test('panel: a bold ROUNDED sans resolves for drawtext (bundled Poppins ExtraBold)', () => {
  const font = resolveOverlayFont();
  assert.ok(existsSync(font), `font must exist: ${font}`);
  assert.match(basename(font), /Poppins-ExtraBold\.ttf$/);
});
