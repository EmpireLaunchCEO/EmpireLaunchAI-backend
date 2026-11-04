/**
 * BLINKING BOTTOM BAR — REAL-GRAPH FIXTURE (OWNER, Nov 2 — her launch video).
 *
 * Executes the REAL overlay pass (applyAssemblyOverlays, one FFmpeg re-encode at
 * CRF 18) over a synthetic 4s 1080x1920 mid-gray source and MEASURES the
 * delivered frames — it never asserts on the filter string. For each sample it
 * decodes one frame and reads the bottom-bar region (y=1752..1920):
 *
 *   • ON  → the translucent black band + white domain text are burned in, so the
 *           region is DARK (mean luma collapses, dark-pixel fraction > 50%);
 *   • OFF → the region is the untouched mid-gray background (mean ≈ 128, no dark
 *           pixels at all).
 *
 * Three renders, three claims:
 *   A. no `bottomBarBlink`  → the bar is on EVERY sampled frame, including the
 *      last one (the default is unchanged, i.e. still persistent);
 *   B. blink 0.5/0.4 (the owner's exact cadence) → ON at 0.25s, OFF at 0.70s,
 *      ON again at 1.00s, OFF at 1.50s, and ON on the FINAL frame — measured on
 *      pixels, so a cadence that is merely "in the string" cannot pass;
 *   C. blink 0.7/0.7 + per-scene bullets + end flash → the bullets and the flash
 *      are unaffected by the blinking bar, and a video whose length is not a
 *      whole multiple of the cycle still ends with the bar on screen.
 *
 * Zero paid APIs. Heavy-ish ffmpeg fixture — run STANDALONE (one at a time):
 *   node --import tsx --test src/services/__tests__/bottomBarBlinkFixture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAssemblyOverlays, normalizeAssemblyOverlays } from '../assemblyOverlays.js';

const HAS_FFMPEG = (() => {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
})();

/** Bottom-bar region of the 1080x1920 frame (same geometry the renderer draws). */
const BAR = { x: 0, y: 1752, w: 1080, h: 168 };
/** Bullet zone used by the legacy floating-lines path (y=340, fontsize 54). */
const BULLETS = { x: 60, y: 330, w: 960, h: 300 };

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}
function probeDuration(file: string): number {
  const d = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { maxBuffer: 4 * 1024 * 1024 },
  ).toString().trim();
  return parseFloat(d);
}
interface RegionStats {
  mean: number;
  max: number;
  /** fraction of pixels darker than 60/255 — the burned-in band is the only
   *  thing in this frame that can be that dark */
  darkFraction: number;
}
/** Decode ONE frame at `ss` seconds and measure a region of it (gray luma). */
function regionAt(file: string, ss: number, r: { x: number; y: number; w: number; h: number }): RegionStats {
  const raw = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-ss', ss.toFixed(3), '-i', file, '-frames:v', '1',
      '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  let sum = 0;
  let max = 0;
  let dark = 0;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    sum += v;
    if (v > max) max = v;
    if (v < 60) dark++;
  }
  return { mean: sum / Math.max(1, raw.length), max, darkFraction: dark / Math.max(1, raw.length) };
}

test('blinking bottom bar: measured on real frames (ON inside the window, OFF inside the gap)', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bottombar-blink-'));
  try {
    // Mid-gray source: the burned band (black@0.72) is unmistakably darker, and
    // the end flash (full-frame white) is unmistakably brighter.
    const src = join(dir, 'src.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=0x808080:s=1080x1920:r=30:d=4', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', src]);
    const dur = probeDuration(src);
    assert.ok(Math.abs(dur - 4) < 0.2, `synthetic source is ~4s (got ${dur}s)`);
    const lastFrameAt = Math.max(0, dur - 0.05);

    // CONTROL — the source itself has an untouched bottom region.
    const ctrl = regionAt(src, 1.0, BAR);
    assert.ok(ctrl.mean > 115 && ctrl.darkFraction < 0.02, `control: bare source bottom region is mid-gray (mean ${ctrl.mean.toFixed(1)}, dark ${(ctrl.darkFraction * 100).toFixed(1)}%)`);

    /* ── A. DEFAULT (no bottomBarBlink) = persistent bar, unchanged ─────────── */
    const specA = normalizeAssemblyOverlays({ bottomBar: 'EmpireLaunchAI.com' }, 1);
    assert.ok(specA, 'persistent spec normalized');
    assert.equal(specA!.bottomBarBlink, undefined, 'no cadence ⇒ the default path');
    const outA = join(dir, 'persistent.mp4');
    await applyAssemblyOverlays(src, outA, specA!, [0], [dur]);
    const aSamples = [0.2, 1.0, 2.0, 3.0, lastFrameAt];
    for (const t of aSamples) {
      const s = regionAt(outA, t, BAR);
      assert.ok(s.mean < 90 && s.darkFraction > 0.5,
        `default: bar burned in at t=${t}s (mean ${s.mean.toFixed(1)}, dark ${(s.darkFraction * 100).toFixed(1)}%)`);
    }

    /* ── B. OWNER CADENCE 0.5s ON / 0.4s OFF ────────────────────────────────── */
    const specB = normalizeAssemblyOverlays(
      { bottomBar: 'EmpireLaunchAI.com', bottomBarBlink: { onSeconds: 0.5, offSeconds: 0.4 } },
      1,
    );
    assert.deepEqual(specB?.bottomBarBlink, { onSeconds: 0.5, offSeconds: 0.4 }, 'cadence survived normalization');
    const outB = join(dir, 'blink.mp4');
    await applyAssemblyOverlays(src, outB, specB!, [0], [dur]);
    assert.ok(Math.abs(probeDuration(outB) - dur) < 0.2, 'blinking render keeps the duration');

    // ON windows are [0,0.5), [0.9,1.4), [1.8,2.3), [2.7,3.2) then the full-length
    // tail [3.5,4.0); OFF gaps are (0.5,0.9), (1.4,1.8), (2.3,2.7), (3.2,3.5).
    const onB = [0.25, 1.0, 2.0, 3.0, lastFrameAt];
    for (const t of onB) {
      const s = regionAt(outB, t, BAR);
      assert.ok(s.mean < 90 && s.darkFraction > 0.5,
        `blink: bar PRESENT inside an ON window at t=${t}s (mean ${s.mean.toFixed(1)}, dark ${(s.darkFraction * 100).toFixed(1)}%)`);
    }
    const offB = [0.7, 1.6, 2.5, 3.35];
    for (const t of offB) {
      const s = regionAt(outB, t, BAR);
      assert.ok(s.mean > 115 && s.darkFraction < 0.02,
        `blink: bar ABSENT inside an OFF window at t=${t}s (mean ${s.mean.toFixed(1)}, dark ${(s.darkFraction * 100).toFixed(1)}%)`);
    }
    // …and the very first frame carries it too (first ON window starts at t=0).
    const firstB = regionAt(outB, 0.0, BAR);
    assert.ok(firstB.mean < 90, `blink: bar present on the FIRST frame (mean ${firstB.mean.toFixed(1)})`);
    // DISCRIMINATOR — the SAME frame timestamp on the persistent render (A) still
    // carries the bar. So the "absent at t=0.7s" result above is caused by the
    // cadence, not by a broken crop/seek that measures nothing.
    const aAtOff = regionAt(outA, 0.7, BAR);
    assert.ok(aAtOff.mean < 90 && aAtOff.darkFraction > 0.5,
      `discriminator: the persistent render still has the bar at t=0.7s (mean ${aAtOff.mean.toFixed(1)}) while the blinking one does not`);

    /* ── C. blink + per-scene bullets + end flash: nothing else changed ─────── */
    // 0.7/0.7 over 4s: ON [0,0.7), [1.4,2.1), tail [3.3,4.0); OFF (2.1,3.3).
    const specC = normalizeAssemblyOverlays(
      {
        perScene: [{ lines: ['Introducing EmpireLaunch AI.'] }],
        bottomBar: 'EmpireLaunchAI.com',
        bottomBarBlink: { onSeconds: 0.7, offSeconds: 0.7 },
        flash: { text: 'EmpireLaunchAI.com', durationSec: 1.2 },
      },
      2,
    );
    assert.ok(specC?.perScene && specC?.flash, 'bullets + flash normalized alongside the blink');
    const outC = join(dir, 'blink-bullets-flash.mp4');
    await applyAssemblyOverlays(src, outC, specC!, [0, 2.0], [2, 2]);

    const bulletsIn = regionAt(outC, 0.3, BULLETS);
    assert.ok(bulletsIn.max > 190, `per-scene bullets still drawn (scene 1) with a blinking bar (max luma ${bulletsIn.max})`);
    const bulletsOut = regionAt(outC, 2.4, BULLETS);
    assert.ok(bulletsOut.max < 190, `bullets still windowed to scene 1 (max luma ${bulletsOut.max} in scene 2)`);

    const barOnC = regionAt(outC, 1.7, BAR);
    assert.ok(barOnC.mean < 90, `blink 0.7/0.7: bar PRESENT at t=1.7s (mean ${barOnC.mean.toFixed(1)})`);
    const barOffC = regionAt(outC, 2.4, BAR);
    assert.ok(barOffC.mean > 115, `blink 0.7/0.7: bar ABSENT at t=2.4s (mean ${barOffC.mean.toFixed(1)})`);

    // The end flash still fires over the final window (full-frame white card).
    const flash = regionAt(outC, Math.max(0, dur - 0.15), { x: 340, y: 760, w: 400, h: 400 });
    assert.ok(flash.mean > 230, `end flash still drawn over the final seconds (center mean ${flash.mean.toFixed(1)})`);
    // …and the bar region on the final frame of render B (no flash) was already
    // proven ON above — the last ON window always ends on the final frame.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
