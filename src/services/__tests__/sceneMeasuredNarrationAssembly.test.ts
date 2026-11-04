/** SCENE-WINDOW RESIZING FROM MEASURED NARRATION (task 42ff404a):
 *  the LIVE planner sizes scene windows from a word-count estimate ([7,7,7,6,6])
 *  but real GPT-audio narration is longer, so the fail-closed single-voice
 *  NARRATION_OVERLAP_INVARIANT tripped at assembly on the owner's Faceless run
 *  2bd309e3 (track=4 start=24095ms < prevSpeechEnd=24354ms — a 259ms overlap).
 *  The render-tooling #124/#125 fixed the same class for launch videos; this
 *  fixture pins the LIVE-path fix: after generation, MEASURE each scene's true
 *  speech end (the same -44dBFS back-scan the invariant uses) and GROW every
 *  window to max(planned, ceil(measured + 400ms margin)) so the narration fits
 *  inside its OWN window — the scheduler can then never overlap tracks, and the
 *  total grows as needed.
 *
 *  DISCRIMINATOR: the EXACT owner dictation (creativeTransformation.raw from
 *  video_projects 2bd309e3, with the verbatim 5-scene narrations and the
 *  [7,7,7,6,6] plan) + synthesized narration tones that mirror the owner's real
 *  measured speech ends. PRE-FIX planned windows MUST trip the invariant on the
 *  real graph; POST-FIX grown windows MUST assemble with every narration inside
 *  its window with >=400ms headroom.
 *
 *  Heavy ffmpeg fixture — run STANDALONE (QA note: one at a time):
 *    npx tsx --test src/services/__tests__/sceneMeasuredNarrationAssembly.test.ts
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
import { applyAssemblyOverlays, normalizeAssemblyOverlays, resolveSceneVideoStarts } from '../assemblyOverlays.js';
import { extractRequestedVisuals } from '../requestedVisuals.js';
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
 *  (same helper style as sceneBoundaryAssembly — ratios immune to AAC
 *  harmonics; a DIFFERENT track's frequency reads at the numerical floor). */
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
  const amp = (mag / N) * 2;
  return 20 * Math.log10(amp + 1e-9);
}
function cropLumaMinMax(file: string, ss: number, x: number, y: number, w: number, h: number): { min: number; max: number } {
  const raw = execFileSync(
    'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file, '-frames:v', '1',
      '-vf', `crop=${w}:${h}:${x}:${y}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  let mn = 255, mx = 0;
  for (let i = 0; i < raw.length; i++) { if (raw[i] < mn) mn = raw[i]; if (raw[i] > mx) mx = raw[i]; }
  return { min: mn, max: mx };
}
/** THE OWNER'S EXACT RUN (prod video_projects 2bd309e3 — dumped Oct 21): the
 *  dictated brief, the 5 verbatim scene narrations, the planned windows, and the
 *  real speech ends implied by the failure (scene4 ends 24.354s cumulative,
 *  scene5 fit ~7.26s: 31500 - 100 - 24095). */
const OWNER_RAW = 'Introducing EmpireLaunch Ai, your new content creation platform. Bulletin points- You get 76 video creations a month! The best part is there is NO CREDIT BUYING!! - these are bullet points to show on screen- need to fit screen. This saves hundreds per month and hours of your time. Create content, edit personal videos or create designs for products! Go to EmpireLaunchAi.com Today to get started! (I want EmpireLaunchAi.com flashing at the bottom of the screen) The background needs to be encouraging, show someone stressed working, show someone relaxing with family. They get more time to do what they want. Yes';
const OWNER_NARRATIONS = [
  'Say hello to EmpireLaunch Ai — the new content creation platform. Your go-to content creation platform.',
  'The essentials come together fast, and the process is simpler than it looks.',
  'And this is where it clicks — the transformation you 76 video creations a month.',
  "That's the payoff — real results, right in front of you.",
  'Ready to make the move? You can get started today. Go to Empirelaunchai.com.',
];
const PLANNED = [7, 7, 7, 6, 6];
/** Owner-run measured true speech ends (ms) — mirror the real gpt-audio lengths
 *  so the PRE-FIX plan trips the invariant exactly like production. */
const MEASURED_MS: Array<number> = [6900, 5800, 5600, 6150, 7260];
const TONES = [330, 470, 660, 880, 1180]; // distinct per-scene probe freqs

test('measured-truth window growth: pure function (task 42ff404a)', () => {
  const scenes = PLANNED.map((d, i) => ({ sceneNumber: i + 1, duration: d }));
  const resized = growSceneWindowsToMeasured(scenes, MEASURED_MS);
  const out = resized.scenes.map((s) => s.duration);
  // Every narration must fit inside its OWN window with >=400ms headroom.
  out.forEach((d, i) => {
    const m = MEASURED_MS[i];
    assert.ok(d * 1000 >= m + MEASURED_NARRATION_MARGIN_MS, `scene ${i + 1} window ${d}s >= measured ${m}ms + margin`);
  });
  // Grow-only: never shrink below the planned window.
  out.forEach((d, i) => assert.ok(d >= PLANNED[i], `scene ${i + 1} never shrinks (${d} >= ${PLANNED[i]})`));
  // Honest growth: scene 4 and 5 MUST grow (the owner's overfit scenes).
  assert.ok(out[3] > PLANNED[3], `scene 4 grew (${out[3]} > ${PLANNED[3]})`);
  assert.ok(out[4] > PLANNED[4], `scene 5 grew (${out[4]} > ${PLANNED[4]})`);
  assert.deepEqual(resized.grown, [1, 4, 5], 'grown audit lists every overfit scene (1, 4, 5)');
  // No-measurement scenes keep their planned window.
  const noMeasure = growSceneWindowsToMeasured(scenes, [null, 0, undefined, null, null]);
  assert.deepEqual(noMeasure.scenes.map((s) => s.duration), PLANNED);
});

test('owner faceless 2bd309e3: pre-fix planned windows TRIP the invariant on the real graph; measured-truth growth PASSES', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnmeas-' + Date.now()));
  try {
    const stills = PLANNED.map((d, i) => {
      const p = join(dir, `s${i + 1}.png`);
      const hex = (0x808080 - i * 0x0a0a0a).toString(16).padStart(6, '0');
      ff(['-f', 'lavfi', '-i', `color=c=0x${hex}:s=360x640`, '-frames:v', '1', p]);
      return p;
    });
    // Narration tones END exactly at the measured speech ends (sine + 0.4s pad
    // so the -44dBFS back-scan reads the intended true end, like TTS tail).
    const tones = MEASURED_MS.map((ms, i) => {
      const p = join(dir, `t${i + 1}.wav`);
      const dur = ms / 1000;
      ff(['-f', 'lavfi', '-i', `sine=frequency=${TONES[i]}:duration=${dur}:sample_rate=44100`, '-af', 'apad=pad_dur=0.4', '-c:a', 'pcm_s16le', p]);
      return p;
    });
    // 0) Measured truth: our synth tones really read at the intended ends.
    tones.forEach((t, i) => {
      const got = measureTrueSpeechEndMs(t);
      assert.ok(Math.abs(got - MEASURED_MS[i]) < 250, `tone ${i + 1} measured end ${got}ms ~= ${MEASURED_MS[i]}ms`);
    });
    // 1) DISCRIMINATOR — PRE-FIX: render at the PLANNED windows [7,7,7,6,6] and
    //    assemble with the LIVE controls (last scene padVideoToAudio — the same
    //    flag the assembly loop sets), so the last clip extends to the full
    //    audio like production (pushing the budget to ~31.5s) while its speech
    //    must start before the previous scene's speech ended — invariant trips.
    //    The pre-fix leg uses kenburns:false (the `-loop 1` still path, Scene-
    //    mode faithful): the invariant only probes AUDIO (duration + back-scan
    //    speech end), so zoompan would only burn the sandbox's 3.9GB RAM.
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
    await assert.rejects(concatClips(preClips, preOut), /NARRATION_OVERLAP_INVARIANT/, 'pre-fix planned windows MUST trip the fail-closed invariant');
    // Free the pre-fix artifacts BEFORE the heavy post-fix graph (sandbox ~3.9GB).
    for (const f of [...preClips, preOut]) { try { rmSync(f, { force: true }); } catch { /* best-effort */ } }
    // 2) POST-FIX: grow windows from MEASURED truth, re-render, assemble -> pass.
    const scenes = PLANNED.map((d, i) => ({ sceneNumber: i + 1, duration: d }));
    const { scenes: grownScenes } = growSceneWindowsToMeasured(scenes, MEASURED_MS);
    const grownDurs = grownScenes.map((s) => s.duration);
    const postClips: string[] = [];
    for (let i = 0; i < grownDurs.length; i++) {
      const c = join(dir, `post${i + 1}.mp4`);
      await renderClip(stills[i], c, grownDurs[i], tones[i], {
        kenburns: true, kenburnsStartZoom: 1.0 + i * 0.05, kenburnsEndZoom: 1.05 + i * 0.05, kenburnsDir: 'zoom-in',
        padVideoToAudio: i === grownDurs.length - 1,
      });
      postClips.push(c);
    }
    const out = join(dir, 'final.mp4');
    await concatClips(postClips, out); // must resolve (no invariant trip)
    assert.ok(existsSync(out), 'post-fix assembly produced the MP4');
    const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Number.isFinite(dur), 'duration readable');
    const grownSum = grownDurs.reduce((a, b) => a + b, 0);
    const expected = grownSum - DISSOLVE_OVERLAP_SECONDS * (grownDurs.length - 1);
    assert.ok(Math.abs(dur - expected) < 0.35, `delivered ${dur.toFixed(2)}s ~= grown budget ${expected.toFixed(2)}s (total grows to fit the script)`);
    // 3) SINGLE VOICE — deterministic scheduler placement (the SAME math as
    //    concatClips): track i starts at max(videoStart, prevSpeechEnd), its
    //    speech ends at start + fit (measured true end + 50ms guard). Assert
    //    each tone is audible inside its own window, and the PREVIOUS tone is
    //    already silent when the NEXT tone's window opens (no overlap).
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
      // audible inside its own window (after onset guard)
      assert.ok(tonePowerAt(out, starts[i] + 0.25, Math.max(0.5, Math.min(1.5, fit[i] - 0.35)), TONES[i]) > -42, `tone${i + 1} (${TONES[i]}Hz) audible in its own window @ ${starts[i].toFixed(2)}s`);
      if (i > 0) {
        // previous tone must already be silent at THIS window's start (no overlap)
        assert.ok(tonePowerAt(out, starts[i] + 0.05, 0.35, TONES[i - 1]) < -42, `tone${i} silent at window${i + 1} start (no overlap @ ${starts[i].toFixed(2)}s)`);
      }
    }
    // 4) DICTATED OPENING + END-FLASH stay wired (requestedVisuals provenance):
    //    the raw brief yields the SAME dictatedOpening + end-flash as prod.
    const rv = extractRequestedVisuals(OWNER_RAW);
    assert.equal(rv.dictatedOpening, 'Introducing EmpireLaunch Ai, your new content creation platform');
    assert.equal(rv.endFlash?.text, 'EmpireLaunchAi.com');
    //    The verbatim scene narrations (DB dump) contain the opening components.
    assert.ok(OWNER_NARRATIONS[0].includes('EmpireLaunch Ai'), 'scene 1 keeps the brand name');
    assert.ok(OWNER_NARRATIONS[0].includes('content creation platform'), 'scene 1 keeps the dictated product phrase');
    // 5) END-FLASH ON THE DELIVERED FILE — apply the owner's flash overlay to
    //    the post-fix assembly and confirm the flash window is real: bright
    //    full-frame white (mean > 200) with dark navy glyphs in the center crop.
    const overlaySpec = normalizeAssemblyOverlays({ flash: { text: 'EmpireLaunchAi.com', durationSec: 1.5 } }, grownDurs.length);
    if (overlaySpec && overlaySpec.flash) {
      const clipSecs = postClips.map((c) => parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', c])));
      const sceneStarts = resolveSceneVideoStarts(clipSecs, DISSOLVE_OVERLAP_SECONDS);
      const overlaid = join(dir, 'flashed.mp4');
      await applyAssemblyOverlays(out, overlaid, overlaySpec, sceneStarts);
      assert.ok(existsSync(overlaid), 'flash overlay pass produced output');
      const total = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', overlaid]));
      assert.ok(Number.isFinite(total) && total > 0, 'overlaid duration readable');
      const flashT = total - 0.75; // mid-flash (flash = final 1.5s)
      const full = cropLumaMinMax(overlaid, flashT, 0, 0, 1080, 1920);
      assert.ok(full.max > 200, `flash frame has bright white pixels (max ${full.max})`);
      assert.ok(full.min < 110, `flash frame has dark navy glyph pixels (min ${full.min})`);
      const textStrip = cropLumaMinMax(overlaid, flashT, 200, 800, 680, 320);
      assert.ok(textStrip.min < 110, `text strip contains glyph pixels (min ${textStrip.min})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});