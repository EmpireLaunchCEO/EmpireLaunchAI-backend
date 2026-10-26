/**
 * PLANNER FIDELITY — discriminating PURE fixtures (no LLM, no DB, no paid
 * calls). Ground truth = the OWNER'S LIVE FACELESS RUN af053a01 (Oct 26,
 * 19:44Z): relay worked (metadata.requestedVisuals non-null) but the planner
 * IGNORED the dictation. Every constant below is HER EXACT production text
 * (af_proj.json: metadata.requestedVisuals / conversation / components +
 * the 5 stored plan scenes). The fixtures assert PRE-FIX behavior MISSES each
 * ask and POST-FIX enforcement lands it, through the exact live expressions:
 *   • sceneVideoPipelineService.ts:1635  grammarize hook at the F4 injection
 *     point (composeNarrationWithPhrase) — "the transformation you 76 video
 *     creations a month." must become a grammatical relative clause.
 *   • sceneVideoPipelineService.ts:2629  visual-prompt sanitizer banned set =
 *     F4 selling points ∪ FULL component inventory ∪ bullet-prefix-stripped
 *     variants (the PRE-FIX set was selling points only → "red" + raw
 *     inventory echoes survived into scene-1's prompt).
 *   • sceneVideoPipelineService.ts:2654  enforcePlannerFidelity — deterministic
 *     dictated opening + mood + grammar enforcement wired into createProject.
 *   • sceneVideoPipelineService.ts:2661  re-injection with { skipSceneZero }
 *     (the verbatim scene-1 line must NEVER be re-joined/trimmed).
 *   • sceneVideoPipelineService.ts:2676/2679  bullet overlay lines built from
 *     the component inventory + merged into the overlay spec.
 *   • requestedVisuals.ts:278            derived end-flash spec defaults to
 *     position:'bottom' (the owner's literal ask — flashing at the BOTTOM).
 *   • assemblyOverlays.ts:249/382        flash position normalize + draw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBulletOverlayLines,
  distributeBulletPanels,
  enforceDictatedOpening,
  enforcePlannerFidelity,
  grammarizeYouBenefitSplice,
  injectMoodIntoVisualPrompts,
  mergePerSceneBullets,
  type SceneLike,
} from '../plannerFidelity.js';
import { buildBriefOverlaySpec } from '../requestedVisuals.js';
import {
  injectSellingPointsIntoNarration,
  stripBenefitTextFromVisualPrompts,
} from '../sceneVideoPipelineService.js';
import { normalizeAssemblyOverlays } from '../assemblyOverlays.js';

// ── OWNER'S EXACT PRODUCTION TEXT (af053a01, af_proj.json) ────────────────
const DICTATED_OPENING = 'Introducing EmpireLaunch Ai, your new content creation platform';
const DICTATED_OPENING_EXACT = 'Introducing EmpireLaunch Ai, your new content creation platform.';
const MOOD_POSITIVE =
  'someone relaxing with family; encouraging, show someone stressed working, show someone relaxing with family';
const END_FLASH_TEXT = 'EmpireLaunchAi.com';
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
// The 5 stored plan scenes (narration + visualPrompt VERBATIM from af_proj.json):
const PRE_PLAN: SceneLike[] = [
  {
    sceneNumber: 1,
    duration: 8,
    narration:
      'Say hello to EmpireLaunch Ai — the new content creation platform. Your go-to content creation platform.',
    visualPrompt:
      'Cinematic establishing shot: hook intro of EmpireLaunch Ai — the new content creation platform, the subject shown clearly for the first time — your new content creation platform. — edit personal videos or create designs for products! — red — Introducing EmpireLaunch Ai, your new content creation platform. — Bulletin points- You get 76 video creations a month!, NO CREDIT BUYING!! — 50 designs a month! — Unlimited personal video editing! — these are bullet points to show on screen- need to fit\n screen. — This saves hundreds per month and hours of your time.',
  },
  {
    sceneNumber: 2,
    duration: 7,
    narration: 'The essentials come together fast, and the process is simpler than it looks.',
    visualPrompt:
      'Cinematic medium shot: setting up the fundamentals of EmpireLaunch Ai — the new content creation platform, subject continues from the opening, early stage.',
  },
  {
    sceneNumber: 3,
    duration: 7,
    narration: 'And this is where it clicks — the transformation you 76 video creations a month.',
    visualPrompt:
      'Cinematic wide shot: EmpireLaunch Ai — the new content creation platform delivering its key benefit, the transformation in progress, same continuous subject.',
  },
  {
    sceneNumber: 4,
    duration: 6,
    narration: "That's the payoff — real results, right in front of you. 50 designs a month.",
    visualPrompt:
      'Cinematic close-up: the payoff result of EmpireLaunch Ai — the new content creation platform, same continuous subject, breakthrough moment.',
  },
  {
    sceneNumber: 5,
    duration: 7,
    narration: 'Ready to make the move? You can get started today. Go to Empirelaunchai.com.',
    visualPrompt:
      'Cinematic closing shot: EmpireLaunch Ai — the new content creation platform final call-to-action, same continuous subject, confident ending.',
  },
];
const SPLICE_RE = /(?<!gives )you\s+\d/;

// ── (b) OPENING ────────────────────────────────────────────────────────────
test('fidelity.opening: pre-fix planner paraphrase FAILS the dictated opening', () => {
  // Owner heard "Say hello to…" — "Introducing" never reached audio.
  const s1 = PRE_PLAN[0];
  assert.ok(s1 && s1.narration);
  assert.equal(s1.narration.toLowerCase().startsWith(DICTATED_OPENING.toLowerCase()), false);
});

test('fidelity.opening: enforceDictatedOpening replaces scene-1 VERBATIM', () => {
  const out = enforceDictatedOpening(PRE_PLAN.map((s) => ({ ...s })), DICTATED_OPENING);
  assert.equal(out.patched, true);
  const s1 = out.script[0];
  assert.ok(s1);
  assert.equal(s1.narration, DICTATED_OPENING_EXACT); // her words, terminal punct only
});

test('fidelity.opening: idempotent — honoring scene-1 is left untouched', () => {
  const once = enforceDictatedOpening(PRE_PLAN.map((s) => ({ ...s })), DICTATED_OPENING).script;
  const twice = enforceDictatedOpening(once, DICTATED_OPENING);
  assert.equal(twice.patched, false);
  assert.equal(twice.script[0]?.narration, DICTATED_OPENING_EXACT);
});

test('fidelity.opening: re-injection (skipSceneZero) NEVER touches the verbatim line', () => {
  // Full live-flow simulation: fidelity step → F4 re-injection pass.
  const fid = enforcePlannerFidelity(PRE_PLAN.map((s) => ({ ...s })), {
    dictatedOpening: DICTATED_OPENING,
    moodPositive: MOOD_POSITIVE,
  });
  const rejoin = injectSellingPointsIntoNarration(fid.script as unknown as Parameters<typeof injectSellingPointsIntoNarration>[0], SELLING_POINTS, { skipSceneZero: true });
  assert.ok(rejoin.injected.length >= 1, 'hook phrases erased by the dictation must be re-spoken elsewhere');
  assert.equal(rejoin.script[0]?.narration, DICTATED_OPENING_EXACT); // intact
  assert.ok(rejoin.script[0]?.narration?.toLowerCase().startsWith(DICTATED_OPENING.toLowerCase()));
});

// ── (f) F4 GRAMMAR ─────────────────────────────────────────────────────────
test("fidelity.grammar: pre-fix splice artifact PRESENT in the owner's scene 3", () => {
  const s3 = PRE_PLAN[2];
  assert.ok(s3 && s3.narration);
  assert.equal(SPLICE_RE.test(s3.narration), true, 'scene 3 had "…the transformation you 76 video creations…"');
});

test('fidelity.grammar: grammarizeYouBenefitSplice fixes the live expression text', () => {
  const fixed = grammarizeYouBenefitSplice(PRE_PLAN[2]?.narration ?? '');
  assert.equal(fixed, 'And this is where it clicks — the transformation that gives you 76 video creations a month.');
  assert.equal(SPLICE_RE.test(fixed), false);
  assert.ok(fixed.includes('that gives you 76 video creations a month'));
});

test('fidelity.grammar: no narration in the whole plan carries the splice after enforcement', () => {
  const out = enforcePlannerFidelity(PRE_PLAN.map((s) => ({ ...s })), {
    dictatedOpening: DICTATED_OPENING,
    moodPositive: MOOD_POSITIVE,
  });
  for (const s of out.script) {
    assert.equal(SPLICE_RE.test(String(s.narration ?? '')), false, `scene ${s.sceneNumber} still splices`);
  }
});

test('fidelity.grammar: idempotent — re-running never rewrites "gives you"', () => {
  const once = grammarizeYouBenefitSplice(PRE_PLAN[2]?.narration ?? '');
  assert.equal(grammarizeYouBenefitSplice(once), once);
});

// ── (d) MOOD ───────────────────────────────────────────────────────────────
test('fidelity.mood: pre-fix plan has ZERO mood imagery (generic boilerplate only)', () => {
  const all = PRE_PLAN.map((s) => String(s.visualPrompt ?? '')).join(' ');
  assert.equal(/stressed|overwork|family|relax/i.test(all), false);
});

test('fidelity.mood: stress lands on scene-1 hook, family payoff on the last scene', () => {
  const out = injectMoodIntoVisualPrompts(PRE_PLAN.map((s) => ({ ...s })), MOOD_POSITIVE);
  assert.deepEqual(out.injectedScenes, [1, 5]);
  assert.ok(String(out.script[0]?.visualPrompt).includes('stressed and overworked'));
  assert.ok(String(out.script[4]?.visualPrompt).includes('relaxed and enjoying time with family'));
});

test('fidelity.mood: NEVER a raw chat-text dump into any visualPrompt', () => {
  const out = injectMoodIntoVisualPrompts(PRE_PLAN.map((s) => ({ ...s })), MOOD_POSITIVE);
  for (const s of out.script) {
    assert.equal(/someone relaxing with family; encouraging/i.test(String(s.visualPrompt ?? '')), false);
    assert.equal(/show someone stressed working/i.test(String(s.visualPrompt ?? '')), false);
  }
});

test('fidelity.mood: idempotent — second pass injects nothing', () => {
  const once = injectMoodIntoVisualPrompts(PRE_PLAN.map((s) => ({ ...s })), MOOD_POSITIVE).script;
  const twice = injectMoodIntoVisualPrompts(once, MOOD_POSITIVE);
  assert.deepEqual(twice.injectedScenes, []);
});

// ── (c) BULLETS ────────────────────────────────────────────────────────────
test('fidelity.bullets: pre-fix overlay spec carries NO per-scene text (the OCR=∅ production fact)', () => {
  const spec = normalizeAssemblyOverlays(
    { flash: { text: END_FLASH_TEXT, durationSec: 1.5 } } as Record<string, unknown>,
    PRE_PLAN.length,
  );
  assert.ok(spec);
  assert.equal(spec.perScene, undefined, 'pre-fix the planner produced no bullet overlay lines');
});

test('fidelity.bullets: the 4 canonical bullet lines are built from the inventory', () => {
  const lines = buildBulletOverlayLines(COMPONENTS, SELLING_POINTS);
  assert.deepEqual(lines, [
    'You get 76 video creations a month',
    'NO CREDIT BUYING',
    '50 designs a month',
    'Unlimited personal video editing',
  ]);
  assert.ok(lines.length <= 4);
  assert.ok(lines.every((l) => l.length <= 48));
});

test('fidelity.bullets: ONE scene-1 panel (the proven render-#8 path), ≤4 lines', () => {
  const panels = distributeBulletPanels(buildBulletOverlayLines(COMPONENTS, SELLING_POINTS), PRE_PLAN.length);
  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.sceneIndex, 0); // only index 0 survives the normalize round-trip
  assert.equal(panels[0]?.lines.length, 4);
  assert.ok((panels[0]?.lines.length ?? 0) <= 4);
});

test('fidelity.bullets: merged spec round-trips normalizeAssemblyOverlays (the 2871 read path)', () => {
  const base = normalizeAssemblyOverlays(
    { flash: { text: END_FLASH_TEXT, durationSec: 1.5 } } as Record<string, unknown>,
    PRE_PLAN.length,
  );
  const panels = distributeBulletPanels(buildBulletOverlayLines(COMPONENTS, SELLING_POINTS), PRE_PLAN.length);
  const merged = mergePerSceneBullets(base, panels, PRE_PLAN.length);
  assert.ok(merged);
  const reread = normalizeAssemblyOverlays(merged as Record<string, unknown>, PRE_PLAN.length);
  assert.ok(reread && Array.isArray(reread.perScene));
  assert.ok(reread.perScene && reread.perScene[0] && 'bullets' in reread.perScene[0]);
  const bullets0 = (reread.perScene[0] as { bullets?: Array<{ text: string }> }).bullets;
  assert.ok(bullets0 && bullets0.length === 4);
  assert.deepEqual(
    bullets0.map((b) => b.text),
    ['You get 76 video creations a month', 'NO CREDIT BUYING', '50 designs a month', 'Unlimited personal video editing'],
  );
  assert.equal(reread.flash?.text, END_FLASH_TEXT); // flash preserved alongside
});

// ── (e) SCRUB ──────────────────────────────────────────────────────────────
test('fidelity.scrub: pre-fix selling-points-only ban lets raw inventory JUNK survive', () => {
  // The PRE-FIX live expression used f4SellingPoints only (task 40c58f6a).
  const out = stripBenefitTextFromVisualPrompts(
    PRE_PLAN.map((s) => ({ ...s })) as unknown as Parameters<typeof stripBenefitTextFromVisualPrompts>[0],
    [...SELLING_POINTS],
  );
  const vp = String(out.script[0]?.visualPrompt ?? '');
  assert.equal(/red/.test(vp), true, '"red" (stray UX component) survived pre-fix');
  assert.equal(/edit personal videos or create designs for products!/.test(vp), true);
  assert.equal(/Bulletin points-/.test(vp), true);
  assert.equal(/Unlimited personal video editing!/.test(vp), true);
});

test('fidelity.scrub: full-inventory ban (live 2629 expression) cleans scene-1 to a coherent brief', () => {
  const banned = [...SELLING_POINTS, ...COMPONENTS, ...COMPONENTS.map((c) => String(c ?? '').replace(/^[-–—•*\s]+/, ''))].filter(
    (c) => !/^EmpireLaunch AI\.$/i.test(c),
  );
  const out = stripBenefitTextFromVisualPrompts(
    PRE_PLAN.map((s) => ({ ...s })) as unknown as Parameters<typeof stripBenefitTextFromVisualPrompts>[0],
    banned,
  );
  const vp = String(out.script[0]?.visualPrompt ?? '');
  assert.ok(out.strippedScenes.includes(1));
  assert.equal(/red/.test(vp), false);
  assert.equal(/edit personal videos or create designs for products!/.test(vp), false);
  assert.equal(/Bulletin points-/.test(vp), false);
  assert.equal(/Unlimited personal video editing!/.test(vp), false);
  assert.equal(/bullet points to show on screen/.test(vp), false);
  assert.equal(/saves hundreds per month/.test(vp), false);
  assert.ok(vp.startsWith('Cinematic establishing shot'));
  assert.equal(/\.$/.test(vp), true);
  assert.equal(/ — — /.test(vp), false, 'no separator seams');
  assert.ok(vp.length > 40, 'coherent brief survives, never emptied');
});

// ── (g) FLASH — bottom position ────────────────────────────────────────────
test('fidelity.flash: derived end-flash spec defaults to BOTTOM (owner literal ask)', () => {
  const spec = buildBriefOverlaySpec(
    { mood: { positive: MOOD_POSITIVE }, endFlash: { text: END_FLASH_TEXT }, dictatedOpening: DICTATED_OPENING } as never,
    PRE_PLAN.length,
  );
  assert.ok(spec && spec.flash);
  assert.equal(spec.flash.position, 'bottom');
  assert.equal(spec.flash.text, END_FLASH_TEXT);
});

test('fidelity.flash: explicit render specs WITHOUT position keep the legacy centered card', () => {
  const spec = normalizeAssemblyOverlays(
    { flash: { text: END_FLASH_TEXT, durationSec: 1.5 } } as Record<string, unknown>,
    1,
  );
  assert.ok(spec && spec.flash);
  assert.equal(spec.flash.position, undefined);
});

test('fidelity.flash: normalize passes position through and clamps repeat 1-5', () => {
  const spec = normalizeAssemblyOverlays(
    { flash: { text: END_FLASH_TEXT, durationSec: 1.5, position: 'bottom', repeat: 99 } } as Record<string, unknown>,
    1,
  );
  assert.ok(spec && spec.flash);
  assert.equal(spec.flash.position, 'bottom');
  assert.equal(spec.flash.repeat, 5);
  const zero = normalizeAssemblyOverlays(
    { flash: { text: END_FLASH_TEXT, durationSec: 1.5, position: 'bottom', repeat: 0 } } as Record<string, unknown>,
    1,
  );
  assert.equal(zero?.flash?.repeat, undefined);
});