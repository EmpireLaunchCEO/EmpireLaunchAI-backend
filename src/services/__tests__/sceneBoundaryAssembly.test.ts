/**
 * RENDER #5 ADJUST — SCENE-BOUNDARY ASSEMBLY FIXTURE (REAL ffmpeg, zero paid APIs).
 *
 * Owner ADJUST on render #5 (Oct 12): "6s voice-overlap" + "transition flash".
 * The 6s overlap root cause: scene 1's narration (14 words ➜ ~6.1s of gpt-audio)
 * filled its ENTIRE 6s window, so the old concatClips schedule anchored scene 2's
 * narration at `videoStart - tr` (0.5-0.8s BEFORE scene 1's speech ended) — two
 * voices talking over each other at the 6s mark. The fix (sequential single-voice
 * scheduling with a final-budget clamp) places each track at the LATER of its own
 * video start and the previous track's SPEECH END, still inside the video total.
 *
 * This fixture EXECUTES the real graph (renderClip -> concatClips) on synthetic
 * stills + pure-tone "narration", with track 1 deliberately FILLING its window
 * (the overlap trigger), and asserts on the delivered MP4:
 *   - track 2 is SILENT in the window where the OLD schedule had it already
 *     speaking (exact Goertzel bins; ratios immune to AAC harmonic distortion),
 *   - every track is audible inside its OWN speech window (placement intact),
 *   - the last track survives to the very end (no tail clip — PR #116 promise),
 *   - per-boundary video luma ramps monotonically (no flash-through-black),
 *   - delivered duration stays on the dissolve-compensated budget (no drift).
 *
 * Heavy ffmpeg fixture — run STANDALONE (QA note: one at a time):
 *   npx tsx --test src/services/__tests__/sceneBoundaryAssembly.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderClip, concatClips, DISSOLVE_OVERLAP_SECONDS } from '../sceneVideoPipelineService.js';

const HAS_FFMPEG = (() => {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
})();

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}
function probe(args: string[]): string {
  return execFileSync('ffprobe', ['-v', 'error', ...args], { maxBuffer: 4 * 1024 * 1024 }).toString().trim();
}
/** Exact tone power (dB RMS) of [ss, ss+dur) at freq via a single-bin Goertzel
 *  on the decoded mono PCM. Unlike a band-pass filter this has ZERO leakage from
 *  other tones (the 330Hz track cannot alias into a 660Hz measurement), so the
 *  overlap assertions are exact: a track present in a window reads ~-12..-30 dB,
 *  an absent track reads below the numerical floor (~-90 dB). */
function tonePowerAt(file: string, ss: number, dur: number, freq: number): number {
  const raw = execFileSync(
    'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-t', String(dur), '-i', file,
      '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  const arr = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const N = arr.length;
  if (N < 200) return -200;
  const k = Math.round((freq * N) / 44100);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);
  let q1 = 0, q2 = 0, q0 = 0;
  for (let i = 0; i < N; i++) {
    q0 = coeff * q1 - q2 + arr[i];
    q2 = q1;
    q1 = q0;
  }
  const mag = Math.sqrt(q1 * q1 + q2 * q2 - coeff * q1 * q2);
  const amp = (mag / N) * 2; // amplitude of the sinusoid at freq
  return 20 * Math.log10(amp + 1e-9);
}
/** Per-0.1s mean luma (0-255) over [ss, ss+dur]. */
function lumaBuckets(file: string, ss: number, dur: number, w = 135, h = 240): number[] {
  const p = execFileSync(
    'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-t', String(dur), '-i', file,
      '-vf', `scale=${w}:${h}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  const frame = w * h;
  const nFrames = Math.floor(p.length / frame);
  if (nFrames === 0) return [];
  const per = Math.max(1, Math.round(nFrames / (dur * 10))); // frames per 0.1s bucket
  const out: number[] = [];
  for (let i = 0; i + per <= nFrames && out.length < dur * 10; i += per) {
    let sum = 0;
    for (let k = i; k < i + per; k++) {
      const f = p.subarray(k * frame, (k + 1) * frame);
      let s = 0;
      for (let b = 0; b < frame; b++) s += f[b];
      sum += s / frame;
    }
    out.push(sum / per);
  }
  return out;
}

test('scene-boundary assembly: single voice (no 6s overlap), placements, tail, no flash', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boundaryfix-'));
  try {
    // Solid 1024x1792 stills (distinct luma so the dissolve is measurable).
    const makeStill = (name: string, hex: string) => {
      const p = join(dir, `${name}.png`);
      ff(['-f', 'lavfi', '-i', `color=c=${hex}:s=1024x1792`, '-frames:v', '1', p]);
      return p;
    };
    const makeTone = (name: string, freq: number, dur: number) => {
      const p = join(dir, `${name}.wav`);
      ff(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`, '-c:a', 'pcm_s16le', p]);
      return p;
    };
    const s1 = makeStill('s1', '0x9e9e9e'); // luma ~158
    const s2 = makeStill('s2', '0x404040'); // luma ~64
    const s3 = makeStill('s3', '0xebebeb'); // luma ~235
    const t1 = makeTone('t1', 330, 6.0); // FILLS scene 1's 6s window (the owner's
    const t2 = makeTone('t2', 660, 2.5); // 6s voice-overlap trigger)
    const t3 = makeTone('t3', 990, 4.0); // fills its OWN 4s window -> last narration is still speaking at the very end (PR #116 tail promise)
    // Render the three scene clips EXACTLY like the faceless path (Ken Burns,
    // threaded zoom, narration fitted to the window).
    const c1 = join(dir, 'c1.mp4');
    const c2 = join(dir, 'c2.mp4');
    const c3 = join(dir, 'c3.mp4');
    const zooms = [
      { z0: 1.0, z1: 1.1 },
      { z0: 1.1, z1: 1.2 },
      { z0: 1.2, z1: 1.3 },
    ];
    await renderClip(s1, c1, 6, t1, { kenburns: true, kenburnsStartZoom: zooms[0].z0, kenburnsEndZoom: zooms[0].z1, kenburnsDir: 'zoom-in' });
    await renderClip(s2, c2, 5, t2, { kenburns: true, kenburnsStartZoom: zooms[1].z0, kenburnsEndZoom: zooms[1].z1, kenburnsDir: 'zoom-in' });
    await renderClip(s3, c3, 4, t3, { kenburns: true, kenburnsStartZoom: zooms[2].z0, kenburnsEndZoom: zooms[2].z1, kenburnsDir: 'zoom-in' });
    const out = join(dir, 'final.mp4');
    await concatClips([c1, c2, c3], out);

    assert.ok(existsSync(out), 'output MP4 produced');
    // (1) Delivered duration stays on the dissolve-compensated budget:
    const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Number.isFinite(dur), 'duration readable');
    const planned = 6 + 5 + 4 - 2 * DISSOLVE_OVERLAP_SECONDS;
    assert.ok(Math.abs(dur - planned) < 0.35, `duration ${dur}s ≈ ${planned.toFixed(1)}s planned (no drift)`);

    // (2) SINGLE VOICE — tone2 must be ABSENT where the OLD schedule had it already
    //     speaking (scene 2's voice used to start at ~5.2s = videoStart - tr while
    //     scene 1's 6.0s speech was still going). NEW schedule: start2 = 6.0s.
    //     Discriminator: the WAV sources are pure tones, but the clips went through
    //     AAC (lossy) so tone1's 330Hz fundamental carries a ~-45..-35dB 2nd HARMONIC
    //     at 660Hz — an absolute floor would false-alarm. Ratio it: in the overlap
    //     window the OLD schedule had the 660 track at ~-9dB (330-660 gap ~0dB); the
    //     NEW schedule has only the harmonic (gap >= 18dB). Any real second voice
    //     also trips the absolute sanity floor.
    const pre2_330 = tonePowerAt(out, 5.70, 0.25, 330);
    const pre2_660 = tonePowerAt(out, 5.70, 0.25, 660);
    assert.ok(pre2_330 > -32, `scene 1 speech still playing in its own tail (330 @5.7-5.95s = ${pre2_330.toFixed(1)} dB)`);
    assert.ok(pre2_330 - pre2_660 >= 18, `no second voice before scene 1's speech ends (330 gap ${(pre2_330 - pre2_660).toFixed(1)} dB @5.7-5.95s — was ~0 dB on the old schedule)`);
    assert.ok(pre2_660 < -22, `no real 660Hz track in scene 1's tail (${pre2_660.toFixed(1)} dB, harmonic-only expected)`);

    // (3) Placements intact — each tone loud inside its own speech window.
    assert.ok(tonePowerAt(out, 0.3, 1.5, 330) > -35, 'tone1 (330) audible in scene 1');
    assert.ok(tonePowerAt(out, 6.30, 0.9, 660) > -35, 'tone2 (660) audible in scene 2');
    assert.ok(tonePowerAt(out, 10.50, 0.9, 990) > -35, 'tone3 (990) audible in scene 3');
    assert.ok(tonePowerAt(out, 6.40, 1.0, 330) < -48, 'tone1 does not bleed into scene 2 (330 @6.4s)');

    // (4) TAIL INTACT — the last tone must survive to the end (PR #116 promise).
    const tail = tonePowerAt(out, dur - 0.70, 0.50, 990);
    assert.ok(tail > -45, `last narration present at the very end (990 @${(dur - 0.70).toFixed(2)}s = ${tail.toFixed(1)} dB)`);

    // (5) NO TRANSITION FLASH — per-boundary luma ramps monotonically toward the
    //     next scene's value; a flash-through-black would dip below both neighbors.
    // (5) NO TRANSITION FLASH - the fix is a fade-THROUGH-BLACK (xfade transition
    //     fade): the prior photo can never linger on the incoming scene. Assert on
    //     the real delivered video that each boundary: (a) STARTS at the outgoing
    //     photo, (b) dips toward black at the midpoint (a REAL fade, not a
    //     dissolve hold), (c) ARRIVES at the incoming photo, (d) never exceeds the
    //     brighter neighbor (no white flash), (e) after the midpoint never returns
    //     near the OUTGOING photo's luma (the owner's "previous photo flashes
    //     during scene 2" defect), and (f) has at most TWO direction changes
    //     (down then up - no flicker).
    const b1 = lumaBuckets(out, 4.8, 1.6); // fade ~5.4->6.2 (scene1 ~158 -> scene2 ~64)
    const b2 = lumaBuckets(out, 9.3, 1.6); // fade ~9.9->10.7 (scene2 ~64 -> scene3 ~235)
    for (const [label, buckets, outLuma, inLuma] of [
      ['boundary 1', b1, 158, 64],
      ['boundary 2', b2, 64, 235],
    ] as const) {
      assert.ok(buckets.length >= 8, `${label}: luma buckets measured (${buckets.length})`);
      const first = buckets[0];
      const last = buckets[buckets.length - 1];
      const minV = Math.min(...buckets);
      const maxV = Math.max(...buckets);
      assert.ok(Math.abs(first - (outLuma as number)) <= 30, `${label}: starts at outgoing photo (first ${first.toFixed(0)} vs ${outLuma})`);
      assert.ok(Math.abs(last - (inLuma as number)) <= 30, `${label}: arrives at incoming photo (last ${last.toFixed(0)} vs ${inLuma})`);
      assert.ok(minV <= Math.max(8, (outLuma as number) * 0.40), `${label}: real fade dip through black (min ${minV.toFixed(0)} <= ${Math.max(8, Math.round((outLuma as number) * 0.40))})`);
      assert.ok(maxV <= Math.max(outLuma as number, inLuma as number) + 20, `${label}: no flash-through-white (max ${maxV.toFixed(0)})`);
      if ((inLuma as number) < (outLuma as number)) {
        // fading to a DARKER photo: any second-half bucket near the outgoing
        // photo's brightness = the prior-frame ghost. Legit rise stays within
        // ~1.8x of the incoming photo (AAC/x264 rounding tolerance).
        const ghostMax = (inLuma as number) * 1.8 + 14;
        for (let i = Math.floor(buckets.length / 2); i < buckets.length; i++) {
          assert.ok(buckets[i] <= ghostMax, `${label}: no prior-photo ghost after midpoint (bucket ${i} ${buckets[i].toFixed(0)} > ${ghostMax.toFixed(0)})`);
        }
      }
      let dirs = 0;
      for (let i = 2; i < buckets.length; i++) {
        const d1 = Math.sign(buckets[i - 1] - buckets[i - 2]);
        const d2 = Math.sign(buckets[i] - buckets[i - 1]);
        if (d1 !== 0 && d2 !== 0 && d1 !== d2) dirs++;
      }
      assert.ok(dirs <= 2, `${label}: luma ramp down-then-up only (direction changes = ${dirs})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});