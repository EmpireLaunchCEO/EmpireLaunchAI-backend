/**
 * REAL ffmpeg fixture test for concatClips (F2 post-acceptance-render fix).
 *
 * Why this exists: the Oct 9 acceptance render (project 7e89b3d4) failed at
 * assembly with `Invalid stream specifier: ad0` — concatClips referenced
 * [ad0][ad1][ad2] in the final concat but NEVER appended the per-track chains
 * (`aParts`) to -filter_complex. Every multi-audio assembly (faceless AND
 * scene) was broken; the earlier suites only asserted on strings, never
 * executed the real graph.
 *
 * A SECOND F2 defect surfaced while proving the graph: concat re-anchors every
 * stream at sample 0 of its concat slot, which silently cancels the adelay
 * shifts and stacks the narrations at 0s/2s/4s of the audio timeline instead of
 * each scene's real global start (0s/4.2s/8.4s). Fix: amix on the shared
 * timeline (each track apad to the video total + adelay to its own scene
 * start). This test EXECUTES concatClips end-to-end with real input clips and
 * asserts on the produced MP4:
 *   - the graph runs (no ffmpeg error) and the output decodes,
 *   - output duration == planned total (3x5s clips - 2x800ms xfades = 13.4s),
 *   - every narration is audible in ITS OWN scene's video window (proves the
 *     per-track apad+adelay+amix placement — the broken concat graph placed
 *     narrations 2-5s EARLY, i.e. silent inside their own windows),
 *   - silence between scenes (no tails overlapping the next narration).
 *
 * Measurement gotcha (learned the hard way): ffmpeg's volumedetect stats are
 * INFO level — `-loglevel error` suppresses them entirely, and execFileSync
 * only captures stdout while the stats go to stderr. This helper runs ffmpeg
 * through bash with a file redirect (default loglevel) and greps the log.
 *
 * Run STANDALONE (heavy ffmpeg fixture — QA note: one at a time):
 *   npx tsx --test src/services/__tests__/concatClips.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concatClips } from '../sceneVideoPipelineService.js';

const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
const probe = (args: string[]) =>
  execFileSync('ffprobe', ['-v', 'error', ...args], {
    maxBuffer: 4 * 1024 * 1024,
  }).toString().trim();

/** Build one 5s scene clip: visible video + 2s sine "narration" at freq Hz. */
function makeClip(dir: string, name: string, freq: number): string {
  const out = join(dir, `${name}.mp4`);
  ff([
    '-f', 'lavfi', '-i', `testsrc2=size=360x640:rate=30:duration=5`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`,
    '-t', '5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    out,
  ]);
  return out;
}

/**
 * Mean loudness (dB) of the audio segment [ss, ss+dur) AFTER a band-pass
 * around freq. Runs through bash with a file redirect so the info-level
 * volumedetect stats actually reach the log (see file header).
 */
function bandLoudness(dir: string, file: string, ss: number, dur: number, freq: number): number {
  const lo = Math.max(20, Math.round(freq * 0.8));
  const hi = Math.round(freq * 1.2);
  const log = join(dir, `band_${ss}s_${freq}hz.log`);
  const script =
    `ffmpeg -hide_banner -y -ss ${ss} -t ${dur} -i '${file}' ` +
    `-vn -af 'highpass=f=${lo},lowpass=f=${hi},volumedetect' ` +
    `-f null - > '${log}' 2>&1`;
  try {
    execFileSync('bash', ['-c', script], { maxBuffer: 8 * 1024 * 1024 });
  } catch {
    // ffmpeg may exit non-zero on very short/gap segments; the log still holds
    // the volumedetect stats we need.
  }
  const out = readFileSync(log, 'utf8');
  const m = out.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return m ? parseFloat(m[1]) : -100;
}

test('concatClips executes the REAL graph: 3 audio clips -> intact per-scene narration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'concatfix-'));
  try {
    const c1 = makeClip(dir, 'c1', 330); // scene 1 narration (window 0.0-5.0s)
    const c2 = makeClip(dir, 'c2', 660); // scene 2 narration (window 4.2-9.2s)
    const c3 = makeClip(dir, 'c3', 990); // scene 3 narration (window 8.4-13.4s)
    const out = join(dir, 'final.mp4');
    await concatClips([c1, c2, c3], out);

    // (1) The graph RAN — output exists and decodes.
    assert.ok(existsSync(out) && statSync(out).size > 50_000, 'output MP4 produced');
    const streams = probe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]);
    assert.ok(streams.includes('video'), 'output has a video stream');
    assert.ok(streams.includes('audio'), 'output has an audio stream (narration carried)');

    // (2) Duration == planned total: 3x5s - 2x0.8s xfade overlaps = 13.4s.
    const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Number.isFinite(dur), 'duration readable');
    assert.ok(Math.abs(dur - 13.4) < 0.4, `duration ${dur}s ≈ 13.4s planned`);

    // (3) Placement: each narration is fully audible at ITS OWN scene's start.
    //     Scene starts on the xfade timeline: w2 begins at 5-0.8=4.2s, w3 at
    //     9.2-0.8=8.4s; each 2s tone should therefore be loud inside
    //     [4.2-6.2s] (660) and [8.4-10.4s] (990). The pre-fix concat graph
    //     stacked tones at audio 0-2 / 2-4 / 4-6, so 660/990 were SILENT at
    //     4.5s/8.7s — these three assertions fail on the broken graph.
    const own1 = bandLoudness(dir, out, 0.3, 1.5, 330);
    const own2 = bandLoudness(dir, out, 4.5, 1.5, 660);
    const own3 = bandLoudness(dir, out, 8.7, 1.5, 990);
    assert.ok(own1 > -35, `scene1 narration audible in window1 (${own1} dB)`);
    assert.ok(own2 > -35, `scene2 narration audible in window2 (${own2} dB)`);
    assert.ok(own3 > -35, `scene3 narration audible in window3 (${own3} dB)`);

    // (4) No tails bleeding into the next scene: the tone windows are 0-2,
    //     4.2-6.2 and 8.4-10.4, with ~2.2-2.4s of dead air between them.
    //     The pre-fix graph had tone2 playing at 2-4s and tone3 at 4-6s, so
    //     these silence probes also fail on the broken graph.
    const gap1 = bandLoudness(dir, out, 2.5, 1.0, 660); // after tone1, before tone2
    const gap2 = bandLoudness(dir, out, 7.0, 1.0, 990); // after tone2, before tone3
    const gap3 = bandLoudness(dir, out, 10.5, 1.0, 330); // after tone3 ends (10.4s)
    assert.ok(gap1 < -50, `660 silent between w1 and w2 (${gap1} dB)`);
    assert.ok(gap2 < -50, `990 silent between w2 and w3 (${gap2} dB)`);
    assert.ok(gap3 < -50, `330 silent after w3 narrations (${gap3} dB)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});