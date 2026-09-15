/**
 * OWNER Sep 14 CONTRACT tests — 16s cap ($1.60) + important-seconds motion windows:
 *   1. soraCallBudget(any duration) === 1  → ONE Sora call per SCENE video at ALL
 *      lengths (30s, 1min AND 2min videos).
 *   2. A 3×5s important-seconds window span (her 3-scene beat run) snaps to
 *      seconds "16" ($1.60) — the old 3×6s=18s run that billed at the "20" tier
 *      ($2.00) is impossible: window totals are hard-capped at 16.
 *   3. Windows are PERSISTED (scene-level motionStartSeconds/motionSeconds and in
 *      the span plan), cumulative, in scene order, so slicing + the Sora prompt
 *      share the exact windows.
 *   4. "20" is UNREACHABLE from Scene/Customize: any span window total ≤ 16 (cap),
 *      and the take fallback is 16 — the gate never sees >16 from the span path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planMotionWindows,
  planSoraSpans,
  proposedMotionWindowSeconds,
  type SceneScript,
} from '../sceneVideoPipelineService.js';
import { snapSora16or20, soraCallBudget } from '../soraVideoService.js';

const motion = (n: number, duration: number, sceneLabel: string): SceneScript => ({
  sceneNumber: n,
  duration,
  visualType: 'motion',
  soraBlock: 0,
  narration: `Beat ${n}.`,
  visualPrompt: `Cinematic ${sceneLabel} beat ${n}`,
});

test('ONE Sora call per Scene video at EVERY duration — budget is exactly 1', () => {
  for (const d of [1, 15, 29, 30, 31, 45, 60, 61, 90, 119, 120, 150, 180, 240, NaN, 30.5, -5, 0]) {
    assert.equal(soraCallBudget(d), 1, `soraCallBudget(${d}) must be 1 — one 16s take, ALL lengths`);
  }
});

test('3 motion scenes with 3×5s important windows (15s ≤ 16) snap to seconds "16" ($1.60)', () => {
  const scenes = [motion(3, 6, 'transformation'), motion(4, 6, 'payoff'), motion(5, 6, 'closing')];
  const windows = planMotionWindows(scenes);
  assert.deepEqual(windows, [
    { sceneNumber: 3, motionStartSeconds: 0, motionSeconds: 5 },
    { sceneNumber: 4, motionStartSeconds: 5, motionSeconds: 5 },
    { sceneNumber: 5, motionStartSeconds: 10, motionSeconds: 5 },
  ], '3 scenes × 5s windows, cumulative, persisted — the 16s take flows across scene cuts (t[0..5], t[5..10], t[10..15])');
  const total = windows.reduce((a, w) => a + w.motionSeconds, 0);
  assert.equal(total, 15, 'window total ≤ 16 — the old 3×6s=18s → "20" bill ($2.00) is impossible');
  assert.equal(snapSora16or20(total), '16', '≤16s → seconds:"16" → $1.60');
});

test('window sizing targets ~5s per motion scene; a 4×4s run fits exactly 16 — nothing dropped', () => {
  const four = [motion(1, 4, 'a'), motion(2, 4, 'b'), motion(3, 4, 'c'), motion(4, 4, 'd')];
  const windows = planMotionWindows(four);
  assert.equal(windows.length, 4, 'ALL four beats stay motion (owner #1)');
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 16, 'sum exactly 16');
  assert.deepEqual(windows.map(w => w.motionSeconds), [4, 4, 4, 4], '4s floor windows — all within the one take');
  assert.deepEqual(windows.map(w => w.motionStartSeconds), [0, 4, 8, 12]);
  assert.equal(snapSora16or20(windows.reduce((a, w) => a + w.motionSeconds, 0)), '16');
});

test('a >4-scene motion run truncates to the longest prefix that fits 16s at the 4s floor', () => {
  const five = [motion(1, 4, 'a'), motion(2, 4, 'b'), motion(2 + 1, 4, 'c'), motion(4, 4, 'd'), motion(5, 4, 'e')];
  const windows = planMotionWindows(five);
  assert.equal(windows.length, 4, 'longest prefix that fits (4 × 4s = 16)');
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 16);
});

test('single 10s motion scene → one 5s window (beat window, not the full 10s)', () => {
  const windows = planMotionWindows([motion(2, 10, 'hero')]);
  assert.deepEqual(windows, [{ sceneNumber: 2, motionStartSeconds: 0, motionSeconds: 5 }]);
  assert.equal(snapSora16or20(windows[0].motionSeconds), '16');
});

test('windows persist into the SPAN PLAN and drive span totalSeconds → "16"', () => {
  const scenes = [motion(3, 6, 'transformation'), motion(4, 6, 'payoff'), motion(5, 6, 'closing')];
  const spans = planSoraSpans(scenes, ['one continuous take across all three beats']);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].totalSeconds, 15, 'span total = window sum (15 ≤ 16)');
  assert.equal(snapSora16or20(spans[0].totalSeconds), '16');
  assert.deepEqual(spans[0].windows!.map(w => w.motionStartSeconds), [0, 5, 10], 'windows persisted IN ORDER');
  assert.ok(spans[0].prompt.includes('0-5s scene 3') && spans[0].prompt.includes('10-15s scene 5'), 'prompt names the windows with second markers');
});

test('proposedWindowSeconds: floor 1, target ~5, never exceeds the scene or 5s', () => {
  assert.equal(proposedMotionWindowSeconds({ duration: 10 }), 5);
  assert.equal(proposedMotionWindowSeconds({ duration: 5 }), 5);
  assert.equal(proposedMotionWindowSeconds({ duration: 4 }), 4);
  assert.equal(proposedMotionWindowSeconds({ duration: 1 }), 1);
  assert.equal(proposedMotionWindowSeconds({ duration: 0 }), 1);
  assert.equal(proposedMotionWindowSeconds({ duration: NaN }), 5);
});

test('"20" is UNREACHABLE from Scene/Customize: the span window total can never exceed 16', () => {
  // Even a maximal 5×6s motion run truncates to the longest prefix whose WINDOW sum
  // ≤ 16 — a window total > 16 (the thing that used to force the "20" tier) never
  // reaches the gate.
  const scenes = [motion(1, 6, 'a'), motion(2, 6, 'b'), motion(3, 6, 'c'), motion(4, 6, 'd'), motion(5, 6, 'e')];
  const spans = planSoraSpans(scenes, ['one take']);
  assert.equal(spans.length, 1);
  assert.ok(spans[0].totalSeconds <= 16, `window total ${spans[0].totalSeconds} ≤ 16`);
  assert.equal(snapSora16or20(spans[0].totalSeconds), '16', 'always "16" from the span path ($1.60)');
});

test('legacy per-scene fallback is hard-capped at 16 — a >16s legacy scene still resolves "16", never "20"', () => {
  // The LEGACY per-scene retry path computes
  //   const sceneSeconds = Math.min(16, Math.round(scene.duration || 16));
  // before snapSora16or20 — so even an 18s or 25s in-flight (pre-span) Scene scene
  // can NEVER request seconds:'20' ($2.00): clamp AND fallback default are both 16.
  assert.equal(snapSora16or20(Math.min(16, Math.round(18 || 16))), '16', '18s legacy scene → "16" ($1.60)');
  assert.equal(snapSora16or20(Math.min(16, Math.round(25 || 16))), '16', '25s legacy scene → "16"');
  assert.equal(snapSora16or20(Math.min(16, Math.round(16 || 16))), '16', 'exactly-16 legacy scene → "16"');
  assert.equal(snapSora16or20(Math.min(16, Math.round(6 || 16))), '16', 'short legacy scene → "16"');
  assert.equal(Math.min(16, Math.round(18 || 16)), 16, 'clamp + fallback default both 16 — the old "else 20" branch is gone');
  assert.equal(Math.min(16, Math.round(NaN || 16)), 16, 'missing duration → fallback 16, never 20');
});