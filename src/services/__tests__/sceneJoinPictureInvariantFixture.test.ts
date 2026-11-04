/**
 * SCENE JOIN — PICTURE INVARIANT FIXTURE (REAL ffmpeg, zero paid APIs).
 *
 * The owner's launch render (project 5365af90, 2026-11-04 22:17 UTC) failed at the
 * FINAL assembly step after every paid stage: Veo 5/5, $0.96 of motion, all scenes
 * completed, and then
 *
 *   ffmpeg match-cut concat exited with code 1 … Stream map '0:v:0' matches no streams
 *
 * Root cause (proven by local reproduction, `/tmp/cutproof`): `cutFrames` passed
 * `-map 0:a:0` and nothing else. In ffmpeg the FIRST `-map` suppresses default
 * stream selection, so ONLY the mapped streams are written — the cut file was
 * AUDIO-ONLY and its `-vf` picture chain was silently ignored. The exact-length
 * correction then called `trimTailSeconds` on that video-less file, which maps
 * `0:v:0` and dies.
 *
 * WHY THREE RENDERS DIED WITHOUT THIS BEING CAUGHT: the existing narration fixture
 * never ran `cutFrames` → `trimTailSeconds` on a NARRATED clip. Scene durations on
 * a launch-style render come out 7,7,7,6,6 = 33s against a 30s target, so the
 * exact-length correction ALWAYS runs and the sequence is always exercised in
 * production — but never in a test.
 *
 * What this fixture proves, on real files:
 *   1. `cutFrames` writes BOTH the picture and the narration (the reproduction).
 *   2. The exact failing sequence cutFrames → trimTailSeconds delivers a clip with
 *      a picture and non-silent audio.
 *   3. The production shape: 5 narrated clips summing to 33s, targetSeconds 30 ⇒ the
 *      correction genuinely runs, and the delivered file has both streams, audible
 *      audio (mean volume measured, not assumed) and an EXACT duration.
 *   4. The same shape with no audio assembles clean, video only.
 *   5. Every intermediate clip written by the join has a video stream — a video-less
 *      clip cannot reach the concat, because the helpers now refuse to return one.
 *
 * ffmpeg/ffprobe are required; the tests SKIP (never fail) when they are missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concatClips } from '../sceneVideoPipelineService.js';
import {
  planMatchCutCuts,
  cutFrames,
  trimTailSeconds,
  probeStreams,
  probeSecondsOf,
  assertClipPicture,
  assertClipStreams,
} from '../sceneJoinService.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
const HAS_FFPROBE = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;
const SKIP = !HAS_FFMPEG || !HAS_FFPROBE ? 'ffmpeg/ffprobe unavailable' : false;

/** Small on purpose (2 CPUs, shared sandbox): the fixture proves STREAMS and
 *  TIMING, not resolution. 270x480 is an even, yuv420p-legal 9:16 frame. */
const W = 270;
const H = 480;

function ff(args: string[]): string {
  return execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).toString();
}

/** A clip in the shape the assembler consumes: testsrc picture + (optionally) a
 *  narration stand-in tone. `hue` makes each scene visually distinct, like Veo's
 *  per-scene stills. */
function makeClip(file: string, seconds: number, opts: { audio: boolean; hue: number }): string {
  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=30:duration=${seconds},hue=h=${opts.hue}`,
  ];
  if (opts.audio) args.push('-f', 'lavfi', '-i', `sine=frequency=${300 + opts.hue}:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-r', '30');
  if (opts.audio) args.push('-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '2', '-shortest');
  args.push(file);
  ff(args);
  return file;
}

/** Mean volume of the first audio stream, in dB (ffmpeg's own volumedetect).
 *  "Non-silent" is measured, never assumed — a silent track is a failure mode
 *  that costs the most. */
function meanVolumeDb(file: string): number {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr || ''));
  return m ? parseFloat(m[1]) : NaN;
}

const types = (file: string): string[] => probeStreams(file).types;
const close = (actual: number, expected: number, tol: number, what: string): void => {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ${expected}s ± ${tol}s, got ${actual}s`,
  );
};

// ═══ 1. THE PURE HALF OF THE INVARIANT ══════════════════════════════════════
test('picture invariant: an audio-only clip is REFUSED, and the error names the helper + streams', () => {
  // The exact stream list the buggy cutFrames wrote (proven in /tmp/cutproof).
  assert.throws(
    () => assertClipStreams({ hasVideo: false, hasAudio: true, types: ['audio'] }, { helper: 'cutFrames', file: '/tmp/cut.mp4', expectAudio: true }),
    (err: any) => {
      assert.match(err.message, /CLIP_PICTURE_INVARIANT cutFrames/);
      assert.match(err.message, /NO video stream/);
      assert.match(err.message, /streams=\[audio\]/);
      assert.match(err.message, /0:v:0/);
      return true;
    },
  );
  // A clip that lost the narration its source carried is refused too.
  assert.throws(
    () => assertClipStreams({ hasVideo: true, hasAudio: false, types: ['video'] }, { helper: 'cutFrames', file: '/tmp/cut.mp4', expectAudio: true }),
    /CLIP_AUDIO_INVARIANT cutFrames/,
  );
  // The healthy shapes pass: video+audio for a narrated clip, video-only when the
  // source had no narration.
  assertClipStreams({ hasVideo: true, hasAudio: true, types: ['video', 'audio'] }, { helper: 'cutFrames', file: 'ok.mp4', expectAudio: true });
  assertClipStreams({ hasVideo: true, hasAudio: false, types: ['video'] }, { helper: 'cutFrames', file: 'ok.mp4', expectAudio: false });
});

// ═══ 2. THE REPRODUCTION — cutFrames must keep the picture AND the narration ══
test('cutFrames: a NARRATED clip keeps BOTH streams (the exact bug that killed the launch render)', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joinpicture-'));
  try {
    const clip = makeClip(join(dir, 'clip.mp4'), 3, { audio: true, hue: 40 });
    const cut = join(dir, 'cut.mp4');
    await cutFrames(clip, cut, 15, 15);
    const s = probeStreams(cut);
    assert.equal(s.hasVideo, true, `cut clip has NO picture — streams=[${s.types.join(',')}] (this is the launch-render bug)`);
    assert.equal(s.hasAudio, true, 'cut clip lost the narration');
    // 3s @30fps = 90 frames, minus 15 head + 15 tail = 60 frames = 2.0s.
    close(probeSecondsOf(cut), 2.0, 0.1, 'cut clip duration');
    assert.ok(meanVolumeDb(cut) > -45, `cut clip audio is silent (mean ${meanVolumeDb(cut)} dB)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══ 3. THE EXACT FAILING SEQUENCE: cutFrames → trimTailSeconds ═════════════
test('exact-length correction survives a cut narrated clip (cutFrames → trimTailSeconds)', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joinpicture-'));
  try {
    const clip = makeClip(join(dir, 'clip.mp4'), 7, { audio: true, hue: 90 });
    const cut = join(dir, 'cut.mp4');
    const exact = join(dir, 'exact.mp4');
    await cutFrames(clip, cut, 6, 6);
    // This is the call that threw "Stream map '0:v:0' matches no streams" on the
    // owner's launch video, after all five Veo clips had been paid for.
    await trimTailSeconds(cut, exact, 6.5);
    const s = probeStreams(exact);
    assert.equal(s.hasVideo, true, `correction produced a video-less clip — streams=[${s.types.join(',')}]`);
    assert.equal(s.hasAudio, true, 'correction dropped the narration');
    close(probeSecondsOf(exact), 6.5, 0.1, 'corrected clip duration');
    assert.ok(meanVolumeDb(exact) > -45, `corrected clip audio is silent (mean ${meanVolumeDb(exact)} dB)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the OLD audio-only command shape is refused by the invariant (guard proven on a real file)', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'joinpicture-'));
  try {
    const clip = makeClip(join(dir, 'clip.mp4'), 2, { audio: true, hue: 200 });
    const bad = join(dir, 'audio-only.mp4');
    // Verbatim the pre-fix cutFrames map list: `-map 0:a:0` and no `-map 0:v:0`.
    ff([
      '-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-i', clip,
      '-vf', 'fps=30,trim=start_frame=0:end_frame=30,setpts=PTS-STARTPTS',
      '-map', '0:a:0', '-af', 'atrim=start=0.000:end=1.000,asetpts=N/SR/TB',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
      bad,
    ]);
    assert.deepEqual(types(bad), ['audio'], 'reproduction: the old map list writes an audio-only file');
    assert.throws(
      () => assertClipPicture(bad, 'cutFrames', true),
      /CLIP_PICTURE_INVARIANT cutFrames/,
      'the invariant must refuse the exact file the old code produced',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══ 4. THE PRODUCTION SHAPE: 33s of narrated clips → targetSeconds 30 ══════
test('production shape: 5 narrated clips (33s) → target 30s delivers video + non-silent audio at exact length', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joinpicture-'));
  try {
    // The launch render's measured scene durations, exactly.
    const durations = [7, 7, 7, 6, 6];
    const clips = durations.map((d, i) => makeClip(join(dir, `clip-${i}.mp4`), d, { audio: true, hue: i * 55 }));
    const rawSum = clips.reduce((a, f) => a + probeSecondsOf(f), 0);
    assert.ok(Math.abs(rawSum - 33) < 0.3, `fixture clips must sum to ~33s, got ${rawSum}s`);

    const plan = await planMatchCutCuts(clips, { workDir: join(dir, 'join'), targetSeconds: 30 });
    // The exact-length correction genuinely ran: 33s of take cannot become 30s any
    // other way, and the launch render is why it matters.
    assert.ok(plan.report.deliveredSeconds <= 30.05, `delivered ${plan.report.deliveredSeconds}s > 30s target`);
    close(plan.report.deliveredSeconds, 30, 0.05, 'plan delivered length');

    // NO video-less clip anywhere in the plan — the whole point of the fix.
    for (const [i, p] of plan.paths.entries()) {
      const s = probeStreams(p);
      assert.equal(s.hasVideo, true, `plan clip ${i} has no picture — streams=[${s.types.join(',')}]`);
      assert.equal(s.hasAudio, true, `plan clip ${i} lost its narration`);
    }

    // The delivered file: concat the plan's clips the way the assembler consumes
    // them (stream copy — this fixture is about the join, not the concat graph,
    // which has its own fixture).
    const list = join(dir, 'list.txt');
    writeFileSync(list, plan.paths.map((p) => `file '${p}'`).join('\n') + '\n');
    const delivered = join(dir, 'delivered.mp4');
    ff(['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', delivered]);

    const s = probeStreams(delivered);
    assert.equal(s.hasVideo, true, `delivered file has no picture — streams=[${s.types.join(',')}]`);
    assert.equal(s.hasAudio, true, 'delivered file has no audio');
    close(probeSecondsOf(delivered), 30, 0.1, 'delivered duration');
    const mean = meanVolumeDb(delivered);
    assert.ok(Number.isFinite(mean), 'could not measure the delivered audio');
    assert.ok(mean > -45, `delivered audio is silent (mean ${mean} dB)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══ 5. NO AUDIO: the same shape assembles clean, video only ════════════════
test('production shape with NO narration: 5 silent clips (33s) → target 30s assembles video-only, exact length', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joinpicture-'));
  try {
    const durations = [7, 7, 7, 6, 6];
    const clips = durations.map((d, i) => makeClip(join(dir, `silent-${i}.mp4`), d, { audio: false, hue: i * 55 }));
    const plan = await planMatchCutCuts(clips, { workDir: join(dir, 'join'), targetSeconds: 30 });
    close(plan.report.deliveredSeconds, 30, 0.05, 'plan delivered length (silent)');
    for (const [i, p] of plan.paths.entries()) {
      const s = probeStreams(p);
      assert.equal(s.hasVideo, true, `silent plan clip ${i} has no picture — streams=[${s.types.join(',')}]`);
      assert.equal(s.hasAudio, false, `silent plan clip ${i} invented an audio stream`);
    }
    const list = join(dir, 'list.txt');
    writeFileSync(list, plan.paths.map((p) => `file '${p}'`).join('\n') + '\n');
    const delivered = join(dir, 'delivered.mp4');
    ff(['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', delivered]);
    const s = probeStreams(delivered);
    assert.equal(s.hasVideo, true, 'silent delivered file has no picture');
    assert.equal(s.hasAudio, false, 'silent delivered file has audio');
    close(probeSecondsOf(delivered), 30, 0.1, 'silent delivered duration');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══ 6. THE FULL PRODUCTION PATH (concatClips join:'match-cut') ═════════════
test('full production path: concatClips(join: match-cut) on 33s of narrated clips exits 0 with every intermediate carrying a picture', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joinpicture-'));
  try {
    const durations = [7, 7, 7, 6, 6];
    const clips = durations.map((d, i) => makeClip(join(dir, `clip-${i}.mp4`), d, { audio: true, hue: i * 55 }));
    const joinWorkDir = join(dir, 'join');
    const final = join(dir, 'final.mp4');
    // This is the call the assembler makes (sceneVideoPipelineService.concatClips).
    // Pre-fix it threw: "ffmpeg match-cut concat exited with code 1 … Stream map
    // '0:v:0' matches no streams" — i.e. it died BEFORE this line returned.
    const report = await concatClips(clips, final, { join: 'match-cut', joinWorkDir, joinLabel: 'fixture' });
    assert.ok(report, 'match-cut report missing');

    // Every intermediate the join wrote must be a real clip.
    const intermediates = readdirSync(joinWorkDir).filter((f) => f.endsWith('.mp4'));
    assert.ok(intermediates.length > 0, 'no join intermediates were written');
    for (const f of intermediates) {
      const s = probeStreams(join(joinWorkDir, f));
      assert.equal(s.hasVideo, true, `join intermediate ${f} has NO picture — streams=[${s.types.join(',')}]`);
    }

    const s = probeStreams(final);
    assert.equal(s.hasVideo, true, `final file has no picture — streams=[${s.types.join(',')}]`);
    assert.equal(s.hasAudio, true, 'final file has no audio');
    // The delivery contract for match-cut: sum(clips) − 0.8s × (n−1) = 33 − 3.2.
    close(probeSecondsOf(final), 33 - 0.8 * 4, 0.35, 'final delivered duration');
    const mean = meanVolumeDb(final);
    assert.ok(Number.isFinite(mean) && mean > -45, `final audio is silent (mean ${mean} dB)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
