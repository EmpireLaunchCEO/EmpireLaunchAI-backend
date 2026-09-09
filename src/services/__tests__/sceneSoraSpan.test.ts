/**
 * SORA SPAN tests (owner directive, live re-test): ONE 20s Sora take must SPAN
 * multiple contiguous scenes — for her 5-scene ~6s-each 30s video: 3 scenes × ~6s
 * ≈ 18s ≤ 20 → 3 of 5 scenes share a single continuous take (t[0..6], t[6..12],
 * t[12..18]) instead of one ~6s trimmed clip discarding ~14s of paid motion.
 *
 *   (a) ELECTION (applySceneMotionFloor): budget=1 + zero motion → a CONTIGUOUS
 *       SPAN of K ≥ 2 short scenes sharing soraBlock=0, K = max forward run whose
 *       durations sum ≤ 20s, starting at the hero beat (backward fallback when the
 *       hero is the last scene); boundary runs truncate at 20s; budget 0 untouched;
 *       plans that already carry motion untouched; Faceless/legacy unchanged.
 *   (b) SPAN PLANNING (planSoraSpans + buildSpanPrompt + offsets): one SoraSpan
 *       per soraBlock with cumulative per-scene offsets; the consolidated prompt
 *       flows ALL K scene beats IN ORDER + the block prompt (continuous movement
 *       across the whole spanned arc); parser multi-Sora plans (budget 2–3) keep
 *       one span per block (per-call grouping preserved); over-20s runs truncate.
 *
 * NO paid renders, NO mocks — all pure deterministic helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySceneMotionFloor,
  planSoraSpans,
  buildSpanPrompt,
  type SceneScript,
} from '../sceneVideoPipelineService.js';

const still = (n: number, visualPrompt: string, duration = 6): SceneScript => ({
  sceneNumber: n, duration, visualType: 'still', visualPrompt, narration: `Narration ${n}.`,
});
const HER_FIVE = (): SceneScript[] => [
  still(1, 'Cinematic hook: introducing the subject'),
  still(2, 'Cinematic medium shot: setting up the fundamentals'),
  still(3, 'Cinematic wide shot: the transformation in progress'),
  still(4, 'Cinematic close-up: the payoff result'),
  still(5, 'Cinematic closing shot: confident ending'),
];
const HERO_BLOCK = 'One continuous 20s take of the key transformation moment, no cuts';

// ─── (a) ELECTION: promote-a-SPAN, not promote-one ───────────────────────────
test('owner case: 5×6s=30s plan → exactly 3 contiguous motion scenes [3,4,5], sum 18 ≤ 20', () => {
  const out = applySceneMotionFloor(HER_FIVE(), [HERO_BLOCK], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  assert.equal(motions.length, 3, 'K = max forward run ≤ 20s: 3 × 6s = 18s');
  assert.deepEqual(motions.map(s => s.sceneNumber), [3, 4, 5], 'starts at/after the hero beat and extends forward');
  assert.ok(motions.every(s => s.soraBlock === 0), 'ONE shared Sora take (single call, seconds:"20")');
  assert.equal(motions.reduce((a, s) => a + s.duration, 0), 18, 'span never exceeds one 20s take');
  // scenes 1,2 stay Ken Burns stills — 3 of the 5 scenes are true Sora motion
  assert.equal(out.filter(s => s.visualType === 'still').length, 2);
  assert.equal(out.reduce((a, s) => a + s.duration, 0), 30, 'exact time budget preserved');
});

test('hero at scene 1: forward span [1,2,3] (contiguity from the opening beat)', () => {
  const plan = HER_FIVE(); // block keywords match scene 1's "hook"
  const out = applySceneMotionFloor(plan, ['One continuous 20s take of the hook intro moment'], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  assert.deepEqual(motions.map(s => s.sceneNumber), [1, 2, 3], 'forward run from the opening beat');
  assert.equal(motions.length, 3);
  assert.ok(motions.every(s => s.soraBlock === 0));
});

test('boundary: run that would exceed 20s TRUNCATES (10s scenes → K=2, sum exactly 20)', () => {
  const plan = [
    still(1, 'Hook beat', 10),
    still(2, 'Transformation beat', 10),
    still(3, 'Payoff beat', 10),
  ];
  const out = applySceneMotionFloor(plan, [HERO_BLOCK], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  assert.deepEqual(motions.map(s => s.sceneNumber), [2, 3], 'hero=scene 2 (transformation); 10+10=20 fits; 20+10=30 > 20 → truncate');
  assert.equal(motions.reduce((a, s) => a + s.duration, 0), 20, 'span capped at SPAN_TAKE_SECONDS');
  assert.equal(out[0].visualType, 'still', 'over-cap scene (scene 1) stays a Ken Burns still');
});

test('hero at the LAST scene → nearest contiguous best fit extends BACKWARD (K ≥ 2)', () => {
  const plan = HER_FIVE();
  const out = applySceneMotionFloor(plan, ['One continuous 20s take of the confident ending payoff'], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  assert.deepEqual(motions.map(s => s.sceneNumber), [3, 4, 5], 'backward extension covers 3 short scenes');
  assert.equal(motions.length, 3);
});

test('budget 0 and plans that already carry motion are untouched; empty plan no-op', () => {
  assert.equal(applySceneMotionFloor(HER_FIVE(), ['any'], 0).filter(s => s.visualType === 'motion').length, 0);
  const withMotion = HER_FIVE().map((s, i) => (i === 1 ? { ...s, visualType: 'motion' as const, soraBlock: 7 } : s));
  const out = applySceneMotionFloor(withMotion, ['any'], 1);
  assert.equal(out.filter(s => s.visualType === 'motion').length, 1, 'never adds beyond what exists');
  assert.equal(out[1].soraBlock, 7, 'existing block untouched');
  assert.equal(applySceneMotionFloor([], ['any'], 1).length, 0);
});

// ─── (b) SPAN PLANNING: one span per soraBlock + cumulative offsets + prompt ──
test('planSoraSpans: her floor result → ONE span {soraBlock:0, scenes [3,4,5], 18s}', () => {
  const plan = applySceneMotionFloor(HER_FIVE(), [HERO_BLOCK], 1);
  const spans = planSoraSpans(plan, [HERO_BLOCK]);
  assert.equal(spans.length, 1, 'one span — one paid Sora call');
  assert.deepEqual(spans[0].sceneNumbers, [3, 4, 5]);
  assert.equal(spans[0].soraBlock, 0);
  assert.equal(spans[0].totalSeconds, 18);
  // cumulative offsets: scene3=0, scene4=6, scene5=12 (the t-windows of the take)
  const offsetByScene = new Map<number, number>();
  for (const span of spans) {
    let acc = 0;
    for (const sn of span.sceneNumbers) { offsetByScene.set(sn, acc); acc += plan.find(s => s.sceneNumber === sn)!.duration; }
  }
  assert.deepEqual([offsetByScene.get(3), offsetByScene.get(4), offsetByScene.get(5)], [0, 6, 12]);
});

test('buildSpanPrompt: flows ALL K beats IN ORDER + the block prompt (continuous arc)', () => {
  const plan = applySceneMotionFloor(HER_FIVE(), [HERO_BLOCK], 1);
  const span = planSoraSpans(plan, [HERO_BLOCK])[0];
  const p = span.prompt.toLowerCase();
  assert.ok(p.includes('one continuous 18-second single take'), `prompt names the span duration: ${span.prompt}`);
  assert.ok(p.includes('transformation'), 'scene 3 beat listed');
  assert.ok(p.includes('payoff result'), 'scene 4 beat listed');
  assert.ok(p.includes('confident ending'), 'scene 5 beat listed');
  assert.ok(p.includes('then'), 'beats joined IN ORDER');
  assert.ok(span.prompt.includes(HERO_BLOCK), 'block prompt appended to the consolidated take prompt');
  assert.ok(p.indexOf('transformation') < p.indexOf('payoff result'), 'beat order preserved');
});

test('planSoraSpans: parser multi-Sora plans (budget 2–3) keep ONE span per block (per-call grouping)', () => {
  const parserPlan: SceneScript[] = [
    { ...still(1, 'Hook'), visualType: 'still' },
    { ...still(2, 'Hero block'), visualType: 'motion', soraBlock: 0 },
    { ...still(3, 'Mid'), visualType: 'still' },
    { ...still(4, 'Payoff block'), visualType: 'motion', soraBlock: 1 },
    { ...still(5, 'CTA'), visualType: 'still' },
  ];
  const spans = planSoraSpans(parserPlan, ['block0 prompt', 'block1 prompt']);
  assert.deepEqual(spans.map(s => s.soraBlock), [0, 1], 'two blocks → two spans (two calls, unchanged)');
  assert.deepEqual(spans[0].sceneNumbers, [2]);
  assert.deepEqual(spans[1].sceneNumbers, [4]);
  assert.ok(spans[0].prompt.includes('block0 prompt'));
  assert.ok(spans[1].prompt.includes('block1 prompt'));
});

test('planSoraSpans: over-20s same-block run truncates to the longest prefix ≤ 20s', () => {
  const plan = [8, 8, 8].map((d, i) => ({ ...still(i + 1, `Beat ${i + 1}`, d), visualType: 'motion' as const, soraBlock: 0 }));
  const spans = planSoraSpans(plan, ['block']);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0].sceneNumbers, [1, 2], '8+8=16 ≤ 20; 16+8=24 > 20 → truncated prefix');
  assert.equal(spans[0].totalSeconds, 16);
});

test('planSoraSpans: still-only plans produce no spans (legacy/in-flight safety → old path)', () => {
  const spans = planSoraSpans(HER_FIVE());
  assert.equal(spans.length, 0);
});