/**
 * THE FACELESS MOTION WINDOW FIT (owner outcome, Nov 11): **every paid second of
 * Veo motion actually appears in the video, at normal speed.**
 *
 * The approved cost model is unchanged — 16 seconds of Veo in two 8-second calls
 * inside a 30-second video. What was wrong was WHERE those paid seconds landed:
 * `planFacelessVeoSpans` buys two 8s takes on the hook and the payoff, but a
 * 30s/5-scene plan's dissolve-compensated slots are ~7s and ~6s, so each paid take
 * was TRIMMED to its slot (16s bought, ~13s on screen) — and a long slot stretched
 * its take instead (a 15s slot over an 8s take = 1.875x slow motion).
 *
 * WHAT THIS FILE PINS
 *   1. A REAL 30-second Faceless plan: every motion slot equals the take it hosts,
 *      so nothing is trimmed away — the whole paid 16s lands.
 *   2. The delivered length stays on the client's 30s target (the difference is
 *      taken out of the still scenes' slack, never below the still floor).
 *   3. NO TAKE IS VISIBLY SLOWED: a take is never fitted past 1.25x, and the 1.875x
 *      that a 15s slot used to demand is gone — measured on a REAL ffmpeg clip.
 *   4. A long scene is never SHRUNK to fit its take (that would cut narration and
 *      shorten the video); the cap + a held last frame is the honest answer there.
 *   5. The fit is wired into the real createProject path, not just exported.
 *
 * ZERO PAID CALLS: no provider is contacted; every clip is local ffmpeg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  parseScenePlan,
  normalizePlanTimeBudget,
  planFacelessVeoSpans,
  applyVeoSceneMotion,
  fitMotionWindowsToSlots,
  cappedTakeFitSeconds,
  fitClipToDuration,
  MAX_TAKE_STRETCH_RATIO,
  MIN_STILL_SCENE_SECONDS,
  type SceneScript,
  type SoraSpan,
} from '../sceneVideoPipelineService.js';
import { VEO_WINDOW_MAX_STRETCH_RATIO } from '../veoVideoService.js';

const TMP = path.join(process.cwd(), 'temp', 'faceless-veo-window-fit-tests');
fs.mkdirSync(TMP, { recursive: true });

const DURATION = 30;
const IDEA = 'A 30 second promo for my bakery.';
const SERVICE_SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'), 'utf8');

/** The planner's real shape for a 30s/5-scene Faceless video. */
const PLANNER_RAW = {
  scenes: [
    { sceneNumber: 1, duration: 6, visualType: 'still', visualPrompt: 'Warm bakery counter at sunrise, fresh loaves', narration: 'Fresh bread, baked before the sun comes up.' },
    { sceneNumber: 2, duration: 6, visualType: 'still', visualPrompt: 'Close-up of hands pulling a golden loaf from the oven', narration: 'Every loaf is made by hand, the same way every morning.' },
    { sceneNumber: 3, duration: 6, visualType: 'still', visualPrompt: 'A tidy pastry display case in morning light', narration: 'Take home something warm for the people you love.' },
    { sceneNumber: 4, duration: 6, visualType: 'still', visualPrompt: 'Coffee being poured beside a paper bakery bag', narration: 'The bread is the reason people come back.' },
    { sceneNumber: 5, duration: 6, visualType: 'still', visualPrompt: 'The bakery storefront at golden hour', narration: 'Come by this weekend and try it yourself.' },
  ],
};

/** MIRROR of createProject's Faceless sequence, in ITS order, including the new
 *  slot fit that runs immediately after the motion election. */
function runFacelessPlan(raw: any = PLANNER_RAW) {
  const parsed = parseScenePlan(raw, IDEA, DURATION, 'faceless');
  const normalized = normalizePlanTimeBudget(parsed, DURATION, { dissolveCompensate: true });
  const spans = planFacelessVeoSpans(normalized);
  const motionApplied = applyVeoSceneMotion(normalized, spans);
  const fitted = fitMotionWindowsToSlots(motionApplied, spans);
  return { normalized, spans, motionApplied, planned: fitted.script, report: fitted.report };
}

const takeOf = (spans: SoraSpan[], sceneNumber: number): number | undefined =>
  spans.reduce<number | undefined>((acc, sp) => {
    const w = (sp.windows ?? []).find((x) => x.sceneNumber === sceneNumber);
    return w ? w.motionSeconds : acc;
  }, undefined);

function probeSeconds(file: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { maxBuffer: 1024 * 1024 }).toString().trim();
  const n = parseFloat(out);
  return Number.isFinite(n) ? n : 0;
}

// ═══ 1. A REAL 30s FACELESS PLAN: every paid second has a slot ══════════════
test('REAL 30s PLAN: each 8s take gets an 8s slot — nothing is trimmed away', () => {
  const { normalized, spans, planned, report } = runFacelessPlan();

  // The plan really is the shape the defect describes: ~7s and ~6s slots.
  assert.equal(planned.length, 5, 'fixture: a real 5-scene plan');
  assert.deepEqual(normalized.map((s) => s.duration), [7, 7, 7, 6, 6], 'the dissolve-compensated slots are NOT on the 8s grid');
  assert.equal(spans.length, 1, 'one span carries the two windows');
  assert.deepEqual(spans[0].windows.map((w) => w.motionSeconds), [8, 8], 'two 8-second calls, 16s of paid motion');

  const motion = planned.filter((s) => s.visualType === 'motion');
  assert.deepEqual(motion.map((s) => s.sceneNumber), [1, planned.length], 'the hook and the payoff move');

  let landed = 0;
  for (const scene of motion) {
    const take = takeOf(spans, scene.sceneNumber);
    assert.equal(take, 8, `scene ${scene.sceneNumber} hosts an 8s take`);
    assert.equal(
      scene.duration, take,
      `scene ${scene.sceneNumber}: the slot is the TAKE (${take}s), not the old ~6-7s slot that trimmed ${take - 6}s of paid motion`,
    );
    // What actually reaches the screen is min(slot, take) at normal speed.
    landed += Math.min(scene.duration, take as number);
  }
  assert.equal(landed, 16, 'ALL 16 paid seconds land in the video (was ~13)');

  // Nothing is slowed, because nothing has to be stretched.
  for (const scene of motion) {
    const take = takeOf(spans, scene.sceneNumber) as number;
    assert.equal(cappedTakeFitSeconds(scene.duration, take), take, `scene ${scene.sceneNumber}: fitted to the take exactly`);
  }

  // The difference came out of the stills' slack, and it is reported.
  assert.deepEqual(
    report.grown.map((g) => [g.sceneNumber, g.from, g.to]),
    [[1, 7, 8], [5, 6, 8]],
    'the two motion slots grew 7→8 and 6→8',
  );
  // The stills are 7, 7, 6 — two seconds of slack above the floor, one short of the
  // three the motion slots needed. The missing second is REPORTED, not hidden: the
  // delivered video is that much longer than the client's target (still inside 1.5s).
  assert.equal(report.borrowedSeconds, 2, '2 seconds came out of the still scenes');
  assert.equal(report.unabsorbedSeconds, 1, 'the last second is stated on the record');
  for (const s of planned.filter((x) => x.visualType !== 'motion')) {
    assert.ok(s.duration >= MIN_STILL_SCENE_SECONDS, `still scene ${s.sceneNumber} was not squeezed below the floor`);
  }
});

// ═══ 2. THE DELIVERED LENGTH STAYS ON THE CLIENT'S TARGET ═══════════════════
test('REAL 30s PLAN: delivered length stays on the 30s target', () => {
  const { report } = runFacelessPlan();
  assert.equal(report.deliveredSeconds, 30.8, 'delivered = 34s of slots − 3.2s of dissolves');
  assert.ok(
    Math.abs(report.deliveredSeconds - DURATION) <= 1.5,
    `delivered ${report.deliveredSeconds}s must stay within 1.5s of the 30s the client asked for`,
  );
});

// ═══ 3. NO TAKE IS VISIBLY SLOWED (the 1.875x defect) ═══════════════════════
test('STRETCH CAP: a take is never fitted past 1.25x — the 1.875x slow is gone', () => {
  assert.equal(VEO_WINDOW_MAX_STRETCH_RATIO, 1.25, 'one policy: the pipeline-wide cap');
  assert.equal(MAX_TAKE_STRETCH_RATIO, VEO_WINDOW_MAX_STRETCH_RATIO, 'the assembly re-fit uses the SAME number');

  // The exact case from the defect: a 15s slot fed by an 8s take.
  assert.equal(cappedTakeFitSeconds(15, 8), 10, '15s slot → the take plays to 10s, not 15s');
  assert.equal(15 / 8, 1.875, 'the old behaviour slowed the shot 1.875x');
  assert.ok(10 / 8 <= VEO_WINDOW_MAX_STRETCH_RATIO, 'the capped ratio is inside the cap');

  // Never more than the slot (no padding), never more than the cap (no slow motion).
  assert.equal(cappedTakeFitSeconds(6, 8), 6, 'a short slot trims — the take is never padded');
  assert.equal(cappedTakeFitSeconds(8, 8), 8, 'an exact slot is an exact fit');
  assert.equal(cappedTakeFitSeconds(10, 8), 10, 'a 1.25x stretch is allowed');
  assert.equal(cappedTakeFitSeconds(12, 8), 10, 'past 1.25x it stops at 10s');
});

// ═══ 4. A LONG SCENE IS NEVER SHRUNK TO ITS TAKE ════════════════════════════
test('LONG SCENES: the slot is never shrunk (that would cut narration), the take is capped instead', () => {
  // A two-scene plan is the shape that produced the 1.875x slow: 15s slots, 8s takes.
  const long: SceneScript[] = [
    { sceneNumber: 1, duration: 15, visualType: 'still', visualPrompt: 'The bakery floor at dawn', narration: 'Fresh bread, baked before the sun comes up, every single morning.' },
    { sceneNumber: 2, duration: 15, visualType: 'still', visualPrompt: 'The bakery storefront at golden hour', narration: 'Come by this weekend and try it yourself.' },
  ];
  const spans = planFacelessVeoSpans(long);
  const planned = fitMotionWindowsToSlots(applyVeoSceneMotion(long, spans), spans);
  assert.equal(planned.script.length, 2, 'fixture: a two-scene plan');
  assert.deepEqual(spans[0].windows.map((w) => w.motionSeconds), [8, 8], 'still two 8s takes');
  for (const scene of planned.script) {
    assert.ok(scene.duration >= 15, `scene ${scene.sceneNumber} keeps its long slot (never shrunk below ${scene.duration}s)`);
    const fitted = cappedTakeFitSeconds(scene.duration, 8);
    assert.ok(
      fitted / 8 <= VEO_WINDOW_MAX_STRETCH_RATIO + 1e-9,
      `scene ${scene.sceneNumber}: ${fitted}s from an 8s take is ${(fitted / 8).toFixed(3)}x — inside the cap`,
    );
  }
  assert.deepEqual(planned.report.grown, [], 'no slot needed growing: they were already longer than their take');
  assert.ok(Math.abs(planned.report.deliveredSeconds - DURATION) <= 2, `delivered ${planned.report.deliveredSeconds}s stays near 30s`);
  assert.equal(planned.script.length, 2, 'same plan shape');
});

// ═══ 5. THE CAP AND THE FULL-TAKE FIT, MEASURED ON A REAL CLIP ══════════════
test('REAL FFMPEG: an 8s take fitted to a 15s slot comes out 10s (1.25x), and to an 8s slot comes out 8s', async () => {
  const take = path.join(TMP, 'take-8s.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '8', take,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const have = probeSeconds(take);
  assert.ok(Math.abs(have - 8) < 0.2, `fixture take is ~8s (${have}s)`);

  // A 15s slot: the old pipeline stretched this to 15s (1.875x). The cap stops at 10s.
  const longSlot = path.join(TMP, 'long-slot.mp4');
  fs.copyFileSync(take, longSlot);
  const fittedLong = cappedTakeFitSeconds(15, 8);
  await fitClipToDuration(longSlot, fittedLong);
  const longOut = probeSeconds(longSlot);
  assert.ok(Math.abs(longOut - 10) < 0.2, `fitted clip is ${longOut}s — 10s, not the old 15s (1.875x slow)`);
  assert.ok(longOut / have <= VEO_WINDOW_MAX_STRETCH_RATIO + 0.03, `measured stretch ${(longOut / have).toFixed(3)}x is inside the 1.25x cap`);

  // An 8s slot: every paid second plays, untouched.
  const exactSlot = path.join(TMP, 'exact-slot.mp4');
  fs.copyFileSync(take, exactSlot);
  await fitClipToDuration(exactSlot, cappedTakeFitSeconds(8, 8));
  const exactOut = probeSeconds(exactSlot);
  assert.ok(Math.abs(exactOut - 8) < 0.2, `fitted clip is ${exactOut}s — the whole paid take, nothing trimmed`);
});

// ═══ 6. IDEMPOTENT + WIRED INTO THE REAL PATH ═══════════════════════════════
test('the fit is idempotent and is wired into createProject, the window fit and the assembly', () => {
  const { spans, planned } = runFacelessPlan();
  const again = fitMotionWindowsToSlots(planned, spans);
  assert.deepEqual(again.script.map((s) => s.duration), planned.map((s) => s.duration), 'running the fit twice changes nothing');
  assert.deepEqual(again.report.grown, [], 'nothing left to grow on the second pass');

  assert.ok(
    /const slotFit = mode === 'faceless'\s*\n\s*\? fitMotionWindowsToSlots\(planned, spanPlans\)/.test(SERVICE_SRC),
    'createProject grows the Faceless motion slots right after the election',
  );
  assert.ok(
    /const fittedSeconds = cappedTakeFitSeconds\(sceneSeconds, billedSeconds\);\s*\n\s*await fitClipToDuration\(slicedPath, fittedSeconds\);/.test(SERVICE_SRC),
    'a window take is fitted through the cap, never straight to the slot',
  );
  assert.ok(
    /const fittedSeconds = cappedTakeFitSeconds\(\s*\n?\s*sceneSeconds,\s*\n?\s*Number\.isFinite\(motionWindow\)/.test(SERVICE_SRC),
    'the already-fitted take is not stretched a second time past the cap',
  );
  assert.ok(
    /const reachable = cappedTakeFitSeconds\(targetSeconds, takeSeconds\);/.test(SERVICE_SRC),
    'the assembly re-fit measures the cap from the TAKE, not from the already-fitted clip',
  );
});
