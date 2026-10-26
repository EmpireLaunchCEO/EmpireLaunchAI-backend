/** TWIN-MODE MEASURED-NARRATION WINDOW GROWTH (task 42ff404a, scope expansion
 *  — owner directive Oct 21: "make sure these fixes apply to scene and twin").
 *
 *  Arch context (verified against the HELD rebuild PR #115 feat/twin-shared-pipeline):
 *  the REBUILT twin engine routes through the SAME shared assembler the live
 *  Faceless/Scene path uses — buildTwinPlan sizes per-segment windows with
 *  normalizePlanTimeBudget (estimate-based: LLM time budget, NOT measured TTS),
 *  generateSceneAudio renders per-segment TTS, then composeTwinVideo calls
 *  renderClip + concatClips (the shared fail-closed NARRATION_OVERLAP_INVARIANT
 *  is inherited). The rebuild's own suite acknowledges a 0.8s dissolve overlap
 *  between adjacent segments (delivered == sum − 0.8·(n−1)); with estimate-sized
 *  windows and real TTS running longer, narration bleeds into the dissolve
 *  region / the next window — the same estimate-vs-measured bug class (its
 *  merge-checklist latent 0.8s overlap). Main-branch cinemaEngineService is a
 *  SILENT frame pipeline (zero TTS), so there is no narration schedule to size
 *  on main — the fix hooks exactly where the rebuild lands.
 *
 *  This fixture reproduces the rebuild's shape on the SHARED graph (own twin
 *  pitch, 5 segments, normalizePlanTimeBudget(30, dissolveCompensate) windows,
 *  per-segment TTS-like tones whose TRUE measured ends overrun the budget):
 *   1. PRE-FIX: estimate windows + shared renderClip/concatClips -> the
 *      invariant MUST trip (proves the rebuild's latent overlap is REAL and is
 *      caught fail-closed by the shared graph on main).
 *   2. POST-FIX: growSceneWindowsToMeasured (the SAME drop-in helper the
 *      rebuild should call in composeTwinVideo after generateSceneAudio) ->
 *      assembly PASSES: every narration inside its own window (Goertzel per
 *      track), previous silent >=400ms before the next opens, delivered ==
 *      sum − 0.8·(n−1) (the rebuild's own dissolve math) while speech never
 *      actually overlaps — the latent 0.8s class is CLOSED.
 *
 *  Heavy ffmpeg fixture — run STANDALONE, ONE AT A TIME (sandbox 3.9GB RAM):
 *    npx tsx --test src/services/__tests__/twinMeasuredNarrationAssembly.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderClip, concatClips, growSceneWindowsToMeasured, measureTrueSpeechEndMs,
  normalizePlanTimeBudget, DISSOLVE_OVERLAP_SECONDS, MEASURED_NARRATION_MARGIN_MS,
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

// The SAME finished twin pitch the HELD rebuild's suite uses (TWIN_PITCH in
// twinSharedPipeline.test.ts, PR #115) — honest provenance: the exact script
// whose 5 estimated segments carry the latent 0.8s-overlap checklist finding.
const TWIN_PITCH = [
  'Introducing EmpireLaunch AI — the all-in-one content creation platform.',
  'It creates professional videos for you in minutes.',
  'It writes every caption and hashtag for you automatically.',
  'It posts to TikTok, Instagram, and YouTube on autopilot.',
  'It saves you hours every single week.',
  'Stop paying for five separate apps, because EmpireLaunch AI does it all in one place.',
  'Go to empirelaunchai.com and sign up today.',
].join(' ');

// Split evenly by words into N segments (mirrors splitTwinScript semantics).
function splitScript(script: string, n: number): string[] {
  const words = script.split(/\s+/).filter(Boolean);
  const per = Math.ceil(words.length / Math.max(1, n));
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(words.slice(i * per, (i + 1) * per).join(' '));
  return out.filter((s) => s.length > 0);
}

// The rebuild's plan shape: duration:1 seeds -> normalizePlanTimeBudget with
// dissolveCompensate (buildTwinPlan's exact budget call) over a 30s target.
const SEGMENT_NARRATIONS = splitScript(TWIN_PITCH, 5);
const ESTIMATED = (() => {
  const base = SEGMENT_NARRATIONS.map((narration, i) => ({
    sceneNumber: i + 1, duration: 1, visualType: 'still', narration,
    visualPrompt: '', narrationRole: 'avatar-dialogue',
  }));
  return normalizePlanTimeBudget(base, 30, { dissolveCompensate: true })
    .map((s) => s.duration);
})();
// MEASURED true speech ends: every segment's REAL TTS runs longer than its
// estimate window (the rebuild's own latent-overlap class — segment 5 overruns
// and the cumulative speech overfills the budget -> pre-fix MUST trip).
const MEASURED_MS = [6300, 6600, 6400, 6100, 6900];
const TONES = [262, 330, 392, 466, 523];

test('growSceneWindowsToMeasured — Twin budget windows + measured TTS ends -> every window >= measured+400ms, grow-only (closes the rebuild 0.8s class)', () => {
  assert.equal(ESTIMATED.length, SEGMENT_NARRATIONS.length, 'budget windows per segment');
  // The estimate DISTRIBUTES the 30s band (deficit by design when real speech
  // is longer than the word-count/time-budget estimate).
  const scenes = ESTIMATED.map((d, i) => ({ sceneNumber: i + 1, duration: d }));
  const r = growSceneWindowsToMeasured(scenes, MEASURED_MS);
  const out = r.scenes.map((s) => s.duration);
  out.forEach((d, i) => {
    assert.ok(d * 1000 >= MEASURED_MS[i] + MEASURED_NARRATION_MARGIN_MS,
      `segment ${i + 1} window ${d}s >= measured ${MEASURED_MS[i]}ms + margin`);
    assert.ok(d >= ESTIMATED[i], `segment ${i + 1} never shrinks below the budget window`);
  });
  // The dissolve-compensated budget resolves to [7,7,7,6,6] (sum 33 → delivered
  // 33 − 0.8·4 = 29.8 ≈ 29.5–30.5s owner band) — the same shape as the owner's
  // Faceless plan, proving the rebuild's budget path carries the identical gap.
  assert.deepEqual(ESTIMATED, [7, 7, 7, 6, 6], `five dissolve-compensated windows (got ${JSON.stringify(ESTIMATED)})`);
});

test('TWIN (rebuild-shape) discriminator: estimate windows TRIP the shared invariant pre-fix; measured-truth growth PASSES (latent 0.8s-overlap class CLOSED)', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mntwin-' + Date.now()));
  try {
    assert.ok(SEGMENT_NARRATIONS.length >= 4, `pitch split into segments (got ${SEGMENT_NARRATIONS.length})`);
    assert.deepEqual(ESTIMATED, [7, 7, 7, 6, 6], 'dissolve-compensated 30s budget -> [7,7,7,6,6] windows');
    const stills = ESTIMATED.map((d, i) => {
      const p = join(dir, `s${i + 1}.png`);
      const hex = (0x2e8b57 - i * 0x0a0a0a).toString(16).padStart(6, '0');
      ff(['-f', 'lavfi', '-i', `color=c=0x${hex}:s=360x640`, '-frames:v', '1', p]);
      return p;
    });
    const tones = MEASURED_MS.map((ms, i) => {
      const p = join(dir, `t${i + 1}.wav`);
      ff(['-f', 'lavfi', '-i', `sine=frequency=${TONES[i]}:duration=${ms / 1000}:sample_rate=44100`,
        '-af', 'apad=pad_dur=0.4', '-c:a', 'pcm_s16le', p]);
      return p;
    });
    tones.forEach((t, i) => {
      const got = measureTrueSpeechEndMs(t);
      assert.ok(Math.abs(got - MEASURED_MS[i]) < 250, `tone ${i + 1} measured end ${got}ms ~= ${MEASURED_MS[i]}ms`);
    });
    // 1) DISCRIMINATOR — PRE-FIX (the rebuild TODAY): renderClip + concatClips at
    //    the ESTIMATE windows, last segment padVideoToAudio (composeTwinVideo's
    //    caller flag — same live dynamics as Faceless/Scene). The schedule runs
    //    out of room -> the shared invariant MUST fail closed. kenburns:false on
    //    every leg (the invariant + scheduler only probe AUDIO).
    const preClips: string[] = [];
    for (let i = 0; i < ESTIMATED.length; i++) {
      const c = join(dir, `pre${i + 1}.mp4`);
      await renderClip(stills[i], c, ESTIMATED[i], tones[i], {
        kenburns: false,
        padVideoToAudio: i === ESTIMATED.length - 1,
      });
      preClips.push(c);
    }
    const preOut = join(dir, 'prefinal.mp4');
    await assert.rejects(concatClips(preClips, preOut), /NARRATION_OVERLAP_INVARIANT/,
      'PRE-FIX (rebuild as-held): estimate windows MUST trip the shared fail-closed invariant');
    for (const f of [...preClips, preOut]) { try { rmSync(f, { force: true }); } catch { /* best-effort */ } }
    // 2) POST-FIX: the DROP-IN measured-truth growth (what the rebuild's
    //    composeTwinVideo should call after generateSceneAudio, before
    //    renderClip/concatClips) -> assemble PASSES, speech never overlaps.
    const scenes = ESTIMATED.map((d, i) => ({ sceneNumber: i + 1, duration: d }));
    const { scenes: grownScenes } = growSceneWindowsToMeasured(scenes, MEASURED_MS);
    const grownDurs = grownScenes.map((s) => s.duration);
    assert.deepEqual(grownDurs, [7, 7, 7, 7, 8], 'windows grow to [7,7,7,7,8] (measured + 400ms ceil)');
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
    assert.ok(existsSync(out), 'post-fix Twin assembly produced the MP4');
    const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Number.isFinite(dur), 'duration readable');
    // The rebuild's OWN dissolve math: delivered == sum(durations) − 0.8·(n−1).
    // The measured-truth fix keeps that math EXACT while making speech overlap
    // impossible — the latent 0.8s dissolve overlap stops being speech overlap.
    const grownSum = grownDurs.reduce((a, b) => a + b, 0);
    const expected = grownSum - DISSOLVE_OVERLAP_SECONDS * (grownDurs.length - 1);
    assert.ok(Math.abs(dur - expected) < 0.5, `delivered ${dur.toFixed(2)}s ~= sum − 0.8·(n−1) ${expected.toFixed(2)}s (dissolve math preserved, total grows to fit TTS)`);
    // 3) SINGLE VOICE (same scheduler math as concatClips) + >=400ms margins:
    //    each narration audible in its own window; previous already silent when
    //    the next opens.
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
        `twin segment ${i + 1} speech end leaves >=350ms headroom in its ${grownDurs[i]}s window`);
      assert.ok(tonePowerAt(out, starts[i] + 0.25, Math.max(0.5, Math.min(1.5, fit[i] - 0.35)), TONES[i]) > -42,
        `twin segment ${i + 1} narration (${TONES[i]}Hz) audible in its own window @ ${starts[i].toFixed(2)}s`);
      if (i > 0) {
        // NO OVERLAP: the previous narration must already be silent just after
        // THIS segment's speech begins (single-voice anchors the next start at
        // the previous speech end — the latent 0.8s dissolve overlap is now
        // visual-only; speech never overlaps)
        assert.ok(tonePowerAt(out, starts[i] + 0.05, 0.35, TONES[i - 1]) < -42,
          `twin segment ${i + 1} opens with the previous narration (${TONES[i - 1]}Hz) already silent (no overlap @ ${starts[i].toFixed(2)}s)`);
      }
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});