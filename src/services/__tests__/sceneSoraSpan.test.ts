/**
 * SORA SPAN tests (owner directive, live re-test; 16s cap + important-seconds Sep 14):
 * ONE 16s Sora take ($1.60) must SPAN multiple contiguous scenes' IMPORTANT-SECONDS
 * windows — for her 5-scene ~6s-each 30s video: 3 scenes' windows at ~5s each = 15s
 * ≤ 16 → 3 of 5 scenes share a single continuous take (t[0..5], t[5..10], t[10..15])
 * instead of one ~6s trimmed clip — and never tip 3×6s=18s into the '20' tier ($2.00).
 *
 *   (a) ELECTION (applySceneMotionFloor): budget=1 + zero motion → a CONTIGUOUS
 *       SPAN of K ≥ 2 short scenes sharing soraBlock=0, K = max forward run whose
 *       MOTION WINDOWS (≤5s each) sum ≤ 16s, starting at the hero beat (backward
 *       fallback when the hero is the last scene); boundary runs truncate at 16s
 *       window total; budget 0 untouched; plans that already carry motion untouched;
 *       Faceless/legacy unchanged.
 *   (b) SPAN PLANNING (planSoraSpans + planMotionWindows + buildSpanPrompt): one
 *       SoraSpan per soraBlock with per-scene IMPORTANT-SECONDS windows (persisted
 *       motionStartSeconds/motionSeconds, cumulative); the consolidated prompt names
 *       the windows with explicit second markers IN ORDER + the block prompt
 *       (continuous movement across the whole spanned arc); legacy multi-block plans
 *       keep one span per block (per-call grouping preserved); over-16s runs truncate.
 *
 * NO paid renders, NO mocks — all pure deterministic helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySceneMotionFloor,
  planSoraSpans,
  buildSpanPrompt,
  planMotionWindows,
  type SceneScript,
} from '../sceneVideoPipelineService.js';
import { snapSora16or20 } from '../soraVideoService.js';
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
const HERO_BLOCK = 'One continuous 16s take of the key transformation moment, no cuts';
// ─── (a) ELECTION: promote-a-SPAN, not promote-one ───────────────────────────
test('owner case: 5×6s=30s plan → exactly 3 contiguous motion scenes [3,4,5], 3×5s windows = 15s ≤ 16', () => {
  const out = applySceneMotionFloor(HER_FIVE(), [HERO_BLOCK], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  assert.equal(motions.length, 3, 'K = max forward run whose WINDOWS sum ≤ 16s: 3 × 5s = 15s — the 3 motion scenes are PRESERVED (owner #1)');
  assert.deepEqual(motions.map(s => s.sceneNumber), [3, 4, 5], 'starts at/after the hero beat and extends forward');
  assert.ok(motions.every(s => s.soraBlock === 0), 'ONE shared Sora take (single call, seconds:"16")');
  const windows = planMotionWindows(motions);
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 15, 'windows sum 15 ≤ 16 — the take snaps to "16" ($1.60), NOT the 18s→"20" ($2.00) bill');
  assert.equal(snapSora16or20(windows.reduce((a, w) => a + w.motionSeconds, 0)), '16');
  // scenes 1,2 stay Ken Burns stills — 3 of the 5 scenes are true Sora motion
  assert.equal(out.filter(s => s.visualType === 'still').length, 2);
  assert.equal(out.reduce((a, s) => a + s.duration, 0), 30, 'exact time budget preserved');
});
test('hero at scene 1: forward span [1,2,3] (contiguity from the opening beat)', () => {
  const plan = HER_FIVE(); // block keywords match scene 1's "hook"
  const out = applySceneMotionFloor(plan, ['One continuous 16s take of the hook intro moment'], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  assert.deepEqual(motions.map(s => s.sceneNumber), [1, 2, 3], 'forward run from the opening beat');
  assert.equal(motions.length, 3);
  assert.ok(motions.every(s => s.soraBlock === 0));
});
test('boundary: 10s scenes keep 3 scenes via 5s WINDOWS (3×5s=15s ≤ 16) — windows, not durations, cap the take', () => {
  const plan = [
    still(1, 'Hook beat', 10),
    still(2, 'Transformation beat', 10),
    still(3, 'Payoff beat', 10),
  ];
  const out = applySceneMotionFloor(plan, [HERO_BLOCK], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  assert.deepEqual(motions.map(s => s.sceneNumber), [2, 3], 'hero=scene 2 (transformation); windows 5+5=10 ≤ 16 fits; scene 1 stays a still');
  const windows = planMotionWindows(motions);
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 10, 'window sum ≤ SPAN_TAKE_SECONDS (16)');
  assert.equal(snapSora16or20(windows.reduce((a, w) => a + w.motionSeconds, 0)), '16');
  assert.equal(out[0].visualType, 'still', 'over-window scene (scene 1) stays a Ken Burns still');
});
test('hero at the LAST scene → nearest contiguous best fit extends BACKWARD (K ≥ 2)', () => {
  const plan = HER_FIVE();
  const out = applySceneMotionFloor(plan, ['One continuous 16s take of the confident ending payoff'], 1);
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
// ─── (b) SPAN PLANNING: one span per soraBlock + windows + prompt ──────────
test('planSoraSpans: her floor result → ONE span {soraBlock:0, scenes [3,4,5], 15s, windows 0/5/10}', () => {
  const plan = applySceneMotionFloor(HER_FIVE(), [HERO_BLOCK], 1);
  const spans = planSoraSpans(plan, [HERO_BLOCK]);
  assert.equal(spans.length, 1, 'one span — one paid Sora call');
  assert.deepEqual(spans[0].sceneNumbers, [3, 4, 5]);
  assert.equal(spans[0].soraBlock, 0);
  assert.equal(spans[0].totalSeconds, 15, 'total = Σ IMPORTANT-SECONDS WINDOWS (not scene durations) — 15s ≤ 16');
  assert.equal(snapSora16or20(spans[0].totalSeconds), '16', '3×5s span → the $1.60 tier');
  // IMPORTANT-SECONDS windows persisted in the span plan: scene3 t[0..5], scene4 t[5..10], scene5 t[10..15]
  assert.deepEqual(spans[0].windows, [
    { sceneNumber: 3, motionStartSeconds: 0, motionSeconds: 5 },
    { sceneNumber: 4, motionStartSeconds: 5, motionSeconds: 5 },
    { sceneNumber: 5, motionStartSeconds: 10, motionSeconds: 5 },
  ]);
});
test('buildSpanPrompt: names the IMPORTANT windows with second markers IN ORDER + the block prompt', () => {
  const plan = applySceneMotionFloor(HER_FIVE(), [HERO_BLOCK], 1);
  const span = planSoraSpans(plan, [HERO_BLOCK])[0];
  const p = span.prompt.toLowerCase();
  assert.ok(p.includes('one continuous 15-second single take'), `prompt names the span window total: ${span.prompt}`);
  assert.ok(p.includes('0-5s scene 3'), 'window 1 marker + scene number');
  assert.ok(p.includes('5-10s scene 4'), 'window 2 marker + scene number');
  assert.ok(p.includes('10-15s scene 5'), 'window 3 marker + scene number');
  assert.ok(p.includes('in order'), 'windows flow IN ORDER');
  assert.ok(p.includes('transformation'), 'scene 3 beat listed');
  assert.ok(p.includes('payoff result'), 'scene 4 beat listed');
  assert.ok(p.includes('confident ending'), 'scene 5 beat listed');
  assert.ok(span.prompt.includes(HERO_BLOCK), 'block prompt appended to the consolidated take prompt');
  assert.ok(p.indexOf('0-5s scene 3') < p.indexOf('5-10s scene 4'), 'window order preserved');
});
test('planSoraSpans: parser legacy multi-block plans keep ONE span per block (per-call grouping)', () => {
  const parserPlan: SceneScript[] = [
    { ...still(1, 'Hook'), visualType: 'still' },
    { ...still(2, 'Hero block'), visualType: 'motion', soraBlock: 0 },
    { ...still(3, 'Mid'), visualType: 'still' },
    { ...still(4, 'Payoff block'), visualType: 'motion', soraBlock: 1 },
    { ...still(5, 'CTA'), visualType: 'still' },
  ];
  const spans = planSoraSpans(parserPlan, ['block0 prompt', 'block1 prompt']);
  assert.deepEqual(spans.map(s => s.soraBlock), [0, 1], 'two blocks → two spans (two calls, legacy safety)');
  assert.deepEqual(spans[0].sceneNumbers, [2]);
  assert.deepEqual(spans[1].sceneNumbers, [4]);
  assert.ok(spans[0].prompt.includes('block0 prompt'));
  assert.ok(spans[1].prompt.includes('block1 prompt'));
  assert.ok(spans.every(s => s.windows.length === 1 && s.windows[0].motionStartSeconds === 0), 'single-scene spans get a window too');
});
test('planSoraSpans: 3×8s scenes FIT one 16s take via 5s windows (15 ≤ 16) — windows, not durations, cap the run', () => {
  const plan = [8, 8, 8].map((d, i) => ({ ...still(i + 1, `Beat ${i + 1}`, d), visualType: 'motion' as const, soraBlock: 0 }));
  const spans = planSoraSpans(plan, ['block']);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0].sceneNumbers, [1, 2, 3], '3 windows × 5s = 15 ≤ 16 — ALL three scenes covered by ONE take');
  assert.equal(spans[0].totalSeconds, 15);
  assert.equal(snapSora16or20(spans[0].totalSeconds), '16');
});
test('planSoraSpans: a 5×8s motion run truncates at 16s of WINDOWS (3×5s=15 — the least-important tail falls out)', () => {
  const plan = [8, 8, 8, 8, 8].map((d, i) => ({ ...still(i + 1, `Beat ${i + 1}`, d), visualType: 'motion' as const, soraBlock: 0 }));
  const spans = planSoraSpans(plan, ['block']);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0].sceneNumbers, [1, 2, 3], 'longest prefix whose windows fit 16s (5+5+5=15 ≤ 16); scenes 4-5 fall out');
  assert.equal(spans[0].totalSeconds, 15);
  assert.equal(snapSora16or20(spans[0].totalSeconds), '16');
});
test('planSoraSpans: still-only plans produce no spans (legacy/in-flight safety → old path)', () => {
  const spans = planSoraSpans(HER_FIVE());
  assert.equal(spans.length, 0);
});