/** SCENE-MODE MEASURED-NARRATION WINDOW GROWTH (task 42ff404a, scope expansion
 *  — owner directive Oct 21: "make sure these fixes apply to scene and twin"):
 *  Scene projects flow through the SAME sceneVideoPipelineService.processProject
 *  as Faceless, but per lead review the coverage must be PROVEN, not inherited.
 *  This fixture runs a SCENE-shaped plan (own long dictation — a client bakery
 *  brief, NOT the owner's faceless dictation) with SCENE-style inputs
 *  (user-photo stills, planned windows [8,6,6,5,5], nominal 30s budget)
 *  through the REAL graph:
 *   1. PRE-FIX: the planned windows under-size the real measured narration ends
 *      (scene durations estimated from word count, exactly the live gap) — the
 *      fail-closed NARRATION_OVERLAP_INVARIANT MUST trip at assembly.
 *   2. POST-FIX: growSceneWindowsToMeasured sizes every window from the real
 *      audio (measured speech end + 400ms margin) — assembly PASSES with every
 *      narration inside its own window (Goertzel-verified per-track placement,
 *      previous track silent when the next opens), delivered duration == grown
 *      budget (total grows to fit the script), and every window carries
 *      >=400ms of headroom above the measured narration end.
 *
 *  Heavy ffmpeg fixture — run STANDALONE, ONE AT A TIME (sandbox 3.9GB RAM):
 *    npx tsx --test src/services/__tests__/sceneMeasuredNarrationSceneMode.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderClip, concatClips, growSceneWindowsToMeasured, measureTrueSpeechEndMs,
  DISSOLVE_OVERLAP_SECONDS, MEASURED_NARRATION_MARGIN_MS,
} from '../sceneVideoPipelineService.js';

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
 *  (ratios immune to AAC harmonics; a DIFFERENT track's frequency reads at the
 *  numerical floor). Mirrors the Faceless discriminator's helper. */
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
    q2 = q1; q1 = q0;
  }
  const power = (q1 * q1 + q2 * q2 - coeff * q1 * q2) / (N * N);
  return 10 * Math.log10(Math.max(power, 1e-12));
}

// SCENE-mode long dictation (own client brief — a cafe/bakery launch video;
// deliberately NOT the owner's faceless text, per lead: "its own long-dictation
// run"). Five narration lines that read naturally at the planned 30s budget.
const SCENE_NARRATIONS = [
  'Introducing Bella\'s Bakehouse, your neighborhood bakery for handcrafted bread.',
  'Every loaf is slow-fermented overnight for that deep, golden crust.',
  'You get fresh sourdough straight from the oven every single morning.',
  'Stop settling for grocery-store bread that goes stale the same day.',
  'Visit BellasBakehouse dot com today and taste the difference.',
];
// Planned windows (the word-count estimate the live planner produces):
const PLANNED = [8, 6, 6, 5, 5];
// MEASURED true speech ends — REAL narration runs longer than the estimate:
// scenes 1 (8.42s), 4 (5.42s), 5 (6.40s) overrun their planned windows, and the
// cumulative speech overfills the ~28s video budget exactly like the owner's
// Faceless run (scene 4 ends at ~25.9s of cumulative speech; the last track is
// clamped to a start inside it -> invariant MUST trip pre-fix).
const MEASURED_MS = [8420, 6140, 5960, 5420, 6400];
const TONES = [330, 415, 494, 587, 659];

test('growSceneWindowsToMeasured — Scene plan [8,6,6,5,5] + measured ends -> every window >= measured+400ms, grow-only', () => {
  const scenes = PLANNED.map((d, i) => ({ sceneNumber: i + 1, duration: d }));
  const r = growSceneWindowsToMeasured(scenes, MEASURED_MS);
  const out = r.scenes.map((s) => s.duration);
  out.forEach((d, i) => {
    assert.ok(d * 1000 >= MEASURED_MS[i] + MEASURED_NARRATION_MARGIN_MS,
      `scene ${i + 1} window ${d}s >= measured ${MEASURED_MS[i]}ms + margin`);
    assert.ok(d >= PLANNED[i], `scene ${i + 1} never shrinks below planned`);
  });
  assert.deepEqual(out, [9, 7, 7, 6, 7], 'all five scenes grow to fit their real narration');
  assert.deepEqual(r.grown, [1, 2, 3, 4, 5], 'grown audit lists every overfit scene');
  const noMeasure = growSceneWindowsToMeasured(scenes, [null, 0, undefined, null, null]);
  assert.deepEqual(noMeasure.scenes.map((s) => s.duration), PLANNED, 'no measurement keeps the planned Scene windows');
});

test('SCENE MODE discriminator: pre-fix planned Scene windows TRIP the invariant on the real graph; measured-truth growth PASSES', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnscene-' + Date.now()));
  try {
    const stills = PLANNED.map((d, i) => {
      const p = join(dir, `s${i + 1}.png`);
      const hex = (0x6a5acd - i * 0x0a0a0a).toString(16).padStart(6, '0');
      ff(['-f', 'lavfi', '-i', `color=c=0x${hex}:s=360x640`, '-frames:v', '1', p]);
      return p;
    });
    const tones = MEASURED_MS.map((ms, i) => {
      const p = join(dir, `t${i + 1}.wav`);
      ff(['-f', 'lavfi', '-i', `sine=frequency=${TONES[i]}:duration=${ms / 1000}:sample_rate=44100`,
        '-af', 'apad=pad_dur=0.4', '-c:a', 'pcm_s16le', p]);
      return p;
    });
    // 0) Measured truth sanity: the synth tones really read at the intended ends.
    tones.forEach((t, i) => {
      const got = measureTrueSpeechEndMs(t);
      assert.ok(Math.abs(got - MEASURED_MS[i]) < 250, `tone ${i + 1} measured end ${got}ms ~= ${MEASURED_MS[i]}ms`);
    });
    // 1) DISCRIMINATOR — PRE-FIX: render at the PLANNED Scene windows with the
    //    LIVE controls (last scene padVideoToAudio — the same flag the assembly
    //    loop sets, exactly the owner's Faceless dynamics). kenburns:false on
    //    every leg — the invariant + scheduler only probe AUDIO; zoompan would
    //    only burn the 3.9GB sandbox RAM (Faceless discriminator proves it).
    const preClips: string[] = [];
    for (let i = 0; i < PLANNED.length; i++) {
      const c = join(dir, `pre${i + 1}.mp4`);
      await renderClip(stills[i], c, PLANNED[i], tones[i], {
        kenburns: false,
        padVideoToAudio: i === PLANNED.length - 1,
      });
      preClips.push(c);
    }
    const preOut = join(dir, 'prefinal.mp4');
    await assert.rejects(concatClips(preClips, preOut), /NARRATION_OVERLAP_INVARIANT/,
      'pre-fix planned SCENE windows MUST trip the fail-closed invariant');
    for (const f of [...preClips, preOut]) { try { rmSync(f, { force: true }); } catch { /* best-effort */ } }
    // 2) POST-FIX: grow Scene windows from MEASURED truth, re-render, assemble.
    const scenes = PLANNED.map((d, i) => ({ sceneNumber: i + 1, duration: d }));
    const { scenes: grownScenes } = growSceneWindowsToMeasured(scenes, MEASURED_MS);
    const grownDurs = grownScenes.map((s) => s.duration);
    const postClips: string[] = [];
    for (let i = 0; i < grownDurs.length; i++) {
      const c = join(dir, `post${i + 1}.mp4`);
      await renderClip(stills[i], c, grownDurs[i], tones[i], {
        kenburns: false,
        padVideoToAudio: i === grownDurs.length - 1,
      });
      postClips.push(c);
    }
    const out = join(dir, 'final.mp4');
    await concatClips(postClips, out); // must resolve (no invariant trip)
    assert.ok(existsSync(out), 'post-fix Scene assembly produced the MP4');
    const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Number.isFinite(dur), 'duration readable');
    const grownSum = grownDurs.reduce((a, b) => a + b, 0);
    const expected = grownSum - DISSOLVE_OVERLAP_SECONDS * (grownDurs.length - 1);
    assert.ok(Math.abs(dur - expected) < 0.5, `delivered ${dur.toFixed(2)}s ~= grown budget ${expected.toFixed(2)}s (total grows to fit the script)`);
    // 3) SINGLE VOICE — the same scheduler math as concatClips: track i starts
    //    at max(videoStart, prevSpeechEnd); speech ends at start + fit. Assert
    //    each tone is audible inside its own window and the PREVIOUS tone is
    //    already silent when the NEXT tone's window opens (>=400ms margin).
    const fit = MEASURED_MS.map((ms) => Math.min(ms / 1000 + 0.05, 60));
    const videoStarts: number[] = [];
    { let acc = 0; for (let i = 0; i < grownDurs.length; i++) { videoStarts.push(i === 0 ? 0 : Math.max(0, acc - DISSOLVE_OVERLAP_SECONDS * i)); acc += grownDurs[i]; } }
    const starts: number[] = [];
    let prevEnd = 0;
    for (let i = 0; i < grownDurs.length; i++) {
      const s = Math.max(videoStarts[i], prevEnd);
      starts.push(s);
      prevEnd = s + fit[i];
    }
    for (let i = 0; i < grownDurs.length; i++) {
      // narration fits inside its OWN window with >=350ms of measured headroom
      // (windows grew to ceil(measured + 400ms) margin)
      assert.ok(grownDurs[i] - (fit[i] - 0.05) >= 0.35,
        `scene ${i + 1} speech end leaves >=350ms headroom in its ${grownDurs[i]}s window`);
      assert.ok(tonePowerAt(out, starts[i] + 0.25, Math.max(0.5, Math.min(1.5, fit[i] - 0.35)), TONES[i]) > -42,
        `scene ${i + 1} narration (${TONES[i]}Hz) audible in its own window @ ${starts[i].toFixed(2)}s`);
      if (i > 0) {
        // NO OVERLAP: the previous narration must already be silent just after
        // THIS scene's speech begins (single-voice anchors the next start at the
        // previous speech end — same pattern as the Faceless discriminator)
        assert.ok(tonePowerAt(out, starts[i] + 0.05, 0.35, TONES[i - 1]) < -42,
          `scene ${i + 1} opens with the previous narration (${TONES[i - 1]}Hz) already silent (no overlap @ ${starts[i].toFixed(2)}s)`);
      }
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});