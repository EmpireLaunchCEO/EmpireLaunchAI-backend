/**
 * LOCAL FFMPEG FIXTURE for the Sora SPAN slice extraction (owner directive, live
 * re-test): ONE 20s take sliced CONTIGUOUSLY across 3 × 6s scene windows. ZERO
 * paid renders — we synthesize a 20s test pattern with ffmpeg, slice it at
 * cumulative offsets [0, 6, 12] with the REAL `sliceSoraTake` export, re-assemble
 * with the REAL `concatClips`, and assert with ffprobe:
 *
 *   (a) each slice is ≈ its scene window (6.0s ± 0.15) — the full paid take is used;
 *   (b) CONTINUITY: each slice's FIRST frame ≈ the source take at its offset
 *       (frame-accurate start — slice 2 starts at t=6, never a replay of slice 1);
 *   (c) different slices show different content (slice 2 ≠ slice 1);
 *   (d) the assembly is the full 3-scene span (≈17s for 3×6s with 2× 500ms xfades),
 *       NOT one ~6s trimmed clip.
 *
 * Skips gracefully when ffmpeg/ffprobe are NOT on PATH. To run locally:
 *   PATH=/tmp/ffmpeg-master-latest-linux64-gpl/bin:$PATH \
 *     npx tsx --test src/services/__tests__/sceneSoraSpanFixture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sliceSoraTake, concatClips } from '../sceneVideoPipelineService.js';

const hasBin = (name: string): boolean => {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch { return false; }
};
const probeSeconds = (file: string): number => {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]).toString().trim();
    return Number.parseFloat(out) || 0;
  } catch { return -1; }
};
/** PSNR (dB) between the FIRST frames of two media files (ffmpeg psnr lavfi).
 *  Uses spawnSync and merges stdout+stderr — the psnr filter writes its stats
 *  line to stderr, which execFileSync's return value never includes. */
const firstFramePsnr = (a: string, b: string): number => {
  try {
    const r = spawnSync('ffmpeg', ['-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    // psnr prints per-component stats then `average:` (rgb for PNG inputs, yuv for
    // video inputs) — match the shared `average:` field to stay format-agnostic.
    const m = out.match(/average:\s*([\d.]+|inf)/);
    return m?.[1] === 'inf' ? 99 : Number.parseFloat(m?.[1] || '0');
  } catch { return -1; }
};
const extractFirstFrame = (video: string, out: string) => {
  execFileSync('ffmpeg', ['-y', '-i', video, '-frames:v', '1', out], { stdio: 'ignore' });
};

const skip = !hasBin('ffmpeg') || !hasBin('ffprobe');

test('Sora SPAN fixture: 20s take → 3×6s contiguous slices → full-span assembly', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sora-span-'));
  try {
    // 1) synthesize a 20s time-varying take (testsrc2 — every frame differs)
    //    Small size keeps the fixture fast; slice semantics are size-independent.
    const take = path.join(dir, 'take.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=20',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', take,
    ], { stdio: 'ignore' });
    const takeDur = probeSeconds(take);
    assert.ok(Math.abs(takeDur - 20) < 0.3, `take is ~20s (got ${takeDur})`);

    // 2) slice the SAME take at cumulative offsets 0 / 6 / 12 (her 3×6s span)
    const slices: string[] = [];
    const offsets = [0, 6, 12];
    for (const off of offsets) {
      const slice = path.join(dir, `slice-${off}.mp4`);
      await sliceSoraTake(take, slice, off, 6);
      slices.push(slice);
    }
    for (let i = 0; i < slices.length; i++) {
      const d = probeSeconds(slices[i]);
      assert.ok(Math.abs(d - 6) < 0.15, `slice ${i + 1} (offset ${offsets[i]}s) is ~6.0s (got ${d})`);
    }

    // 3) CONTINUITY: each slice's first frame ≈ the take at ITS offset (output-seek
    //    reference, frame-accurate) — slice 2 starts where slice 1 ended, never from 0.
    const sliceFrames: string[] = [];
    for (let i = 0; i < slices.length; i++) {
      const ref = path.join(dir, `ref-${offsets[i]}.png`);
      const f = path.join(dir, `f-${offsets[i]}.png`);
      execFileSync('ffmpeg', ['-y', '-i', take, '-ss', String(offsets[i]), '-frames:v', '1', ref], { stdio: 'ignore' });
      extractFirstFrame(slices[i], f);
      sliceFrames.push(f);
      const db = firstFramePsnr(f, ref);
      assert.ok(db >= 35, `slice ${i + 1} starts at t=${offsets[i]}s (frame PSNR ${db.toFixed(1)}dB ≥ 35)`);
    }
    // 4) different slices show different content — slice 2 is NOT a replay of slice 1
    const replayDb = firstFramePsnr(sliceFrames[0], sliceFrames[1]);
    assert.ok(replayDb < 30, `slice 2 ≠ slice 1 (PSNR ${replayDb.toFixed(1)}dB < 30 — no replay-from-0)`);

    // 5) real assembly path (concatClips): full 3-scene span ≈ 17s (3×6 − 2×0.5s xfade)
    const assembled = path.join(dir, 'final.mp4');
    await concatClips(slices, assembled);
    const total = probeSeconds(assembled);
    assert.ok(Math.abs(total - 17.0) < 0.4, `assembly ≈ 17s (3×6s − 2×0.5s dissolves); got ${total.toFixed(2)}s`);

    process.stderr.write(`[SPAN_FIXTURE] take=${takeDur.toFixed(2)}s slices=[${slices.map(s => probeSeconds(s).toFixed(2)).join(',')}] assembled=${total.toFixed(2)}s replayPsnr=${replayDb.toFixed(1)}dB\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});