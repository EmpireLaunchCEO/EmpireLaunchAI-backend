/**
 * SCENE ASSEMBLY — NARRATION-CARRYING REAL-GRAPH FIXTURE (owner Nov 4, launch render)
 *
 * WHY THIS FILE EXISTS
 * The owner's launch render generated and PAID FOR five stills, five Veo clips and
 * five narration tracks — and then died at the final assembly step with
 *
 *     ffmpeg match-cut concat exited with code 1:
 *     Invalid stream specifier: ad0.
 *     Stream map 'ad0' matches no streams.
 *
 * Two defects, both invisible to a unit test:
 *   1. the match-cut join (`trimEdgeBlack` / `cutFrames` / `trimTailSeconds`) passed
 *      `-an`, so it STRIPPED the narration out of every clip it cut. Four of five
 *      clips lost their audio; the one that survived made `aIns.length === 1`, and
 *      the single-track branch mapped the bare token `ad0` instead of `[ad0]` — which
 *      ffmpeg reads as a STREAM SPECIFIER, not a filtergraph output.
 *   2. a graph built with no audio at all could still be handed to ffmpeg.
 *
 * This fixture runs the REAL assembly function (`concatClips`, the same one the
 * pipeline calls) over synthetic local clips — ZERO paid APIs — and measures the
 * delivered file:
 *
 *   CASE A — five clips, each carrying its own distinct narration track:
 *            exit 0, output has BOTH a video and an audio stream, the audio is not
 *            silent (RMS measured, not assumed), and the delivered duration matches
 *            the join's own length contract. A SHORT video is a hard failure.
 *   CASE B — five clips, NO audio anywhere: assembles cleanly, output carries no
 *            audio stream, and the graph-integrity check refuses any `ad` reference.
 *   CASE C — five clips, EXACTLY ONE carrying narration: this is the production
 *            failure, reproduced. It must assemble, and its audio must be audible.
 *
 * Run standalone (it is an FFmpeg fixture):
 *   node --import tsx --test src/services/__tests__/sceneAssemblyNarrationFixture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { concatClips, assertAudioGraphIntegrity } from '../sceneVideoPipelineService.js';

const W = 1080;
const H = 1920;
const FPS = 30;
/** Clip length. 2.0s keeps the fixture cheap while still leaving the join real
 *  material to search (12 frames at each end) and cut. */
const CLIP_SECONDS = 2.0;
/** The narration burst inside each clip: spoken for the first 1.2s, then silence,
 *  exactly as renderClip's `apad=whole_dur=<window>` leaves a real TTS take. */
const SPEECH_SECONDS = 1.2;
/** concatClips' join allowance (SCENE_TRANSITION_MS ?? 800) — with match-cut it is
 *  what each join FOLDS AWAY, so it is also the delivered-length contract. */
const TR = 0.8;

/** Bright, clearly different solid colours: blackdetect must find nothing to trim
 *  (pix_th 0.10) and each clip is visually distinct, as real scene stills are. */
const COLOURS = ['0x2e6f9e', '0x9e5a2e', '0x3d9e4a', '0x8a3d9e', '0x9e2e3d'];
/** A distinct narration pitch per scene so "distinct synthetic narration track" is
 *  literally true of the audio, not just of the file names. */
const PITCH_HZ = [440, 554, 659, 784, 880];

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

/** Build one scene clip the way renderClip does: exact window, 30fps, yuv420p, and
 *  a narration track fitted to (padded out to) that window. `withAudio: false`
 *  builds the same picture with no audio stream at all. */
function buildClip(file: string, index: number, withAudio: boolean): void {
  const video = ['-f', 'lavfi', '-i', `color=c=${COLOURS[index % COLOURS.length]}:s=${W}x${H}:r=${FPS}:d=${CLIP_SECONDS}`];
  if (!withAudio) {
    ffmpeg([...video, '-map', '0:v:0', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', String(CLIP_SECONDS), file]);
    return;
  }
  ffmpeg([
    ...video,
    '-f', 'lavfi', '-i', `sine=frequency=${PITCH_HZ[index % PITCH_HZ.length]}:duration=${SPEECH_SECONDS}:sample_rate=44100`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-af', `apad=whole_dur=${CLIP_SECONDS}`,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-t', String(CLIP_SECONDS),
    file,
  ]);
}

interface Probe { hasVideo: boolean; hasAudio: boolean; seconds: number; }
function probe(file: string): Probe {
  const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', file], { maxBuffer: 4 * 1024 * 1024 }).toString();
  const types = raw.split('\n').filter((l) => l.startsWith('codec_type=')).map((l) => l.split('=')[1].trim());
  const durLine = raw.split('\n').find((l) => l.startsWith('duration=')) || '';
  const seconds = Number.parseFloat(durLine.split('=')[1] || 'NaN');
  return { hasVideo: types.includes('video'), hasAudio: types.includes('audio'), seconds: Number.isFinite(seconds) ? seconds : NaN };
}

/** RMS level in dBFS of the delivered file's audio, measured by decoding it.
 *  `astats` reports per-channel RMS; we take the overall value. A silent AAC track
 *  measures about -91 dB (the codec's noise floor), real narration measures far
 *  above -35 dB. */
function measuredRmsDb(file: string): number {
  // astats reports on STDERR — spawnSync so we can read it (execFileSync returns
  // stdout only, which is how the first version of this fixture silently measured
  // nothing).
  const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const text = String(res.stderr || '');
  const all = [...text.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  // Channels are reported first, then the "Overall" block; the maximum across all
  // reported values is the honest "is there audible signal" number.
  return all.length ? Math.max(...all) : NaN;
}

test('SCENE ASSEMBLY — five narrated clips assemble with real, audible narration', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scene-narr-assembly-'));
  try {
    const clips = COLOURS.map((_, i) => {
      const f = path.join(dir, `clip-${i + 1}.mp4`);
      buildClip(f, i, true);
      assert.ok(probe(f).hasAudio, `fixture clip ${i + 1} must carry its own narration track`);
      return f;
    });
    const out = path.join(dir, 'assembled.mp4');
    const report = await concatClips(clips, out, {
      join: 'match-cut',
      joinWorkDir: path.join(dir, 'join-cut'),
      joinLabel: 'fixture',
    });

    // 1. ffmpeg EXITED 0 — concatClips resolved (it throws on a non-zero exit).
    assert.ok(existsSync(out), 'assembly produced no output file');
    assert.ok(report, 'match-cut assembly must return its join report');

    // 2. BOTH streams are in the delivered file.
    const p = probe(out);
    assert.equal(p.hasVideo, true, 'delivered file has no video stream');
    assert.equal(p.hasAudio, true, 'delivered file has NO audio stream — the narration was lost');

    // 3. The audio is AUDIBLE — measured RMS, not stream presence.
    const rms = measuredRmsDb(out);
    assert.ok(Number.isFinite(rms), 'could not measure the delivered audio RMS');
    assert.ok(rms > -35, `delivered narration is effectively silent (RMS ${rms} dBFS) — a stream that carries silence is not narration`);

    // 4. Duration matches the join's own length contract; SHORT IS A HARD FAILURE.
    const expected = report!.targetSeconds;
    assert.ok(expected > 0, 'join report carries no target duration');
    assert.ok(
      p.seconds >= expected - 0.15,
      `delivered video is SHORT: ${p.seconds.toFixed(3)}s against a ${expected.toFixed(3)}s target (short deliveries are a hard failure, never a warning)`,
    );
    assert.ok(
      Math.abs(p.seconds - expected) <= 0.35,
      `delivered duration ${p.seconds.toFixed(3)}s drifted from the ${expected.toFixed(3)}s target`,
    );
    // eslint-disable-next-line no-console
    console.log(`[fixture] A: exit=0 streams=video+audio rms=${rms.toFixed(1)}dBFS duration=${p.seconds.toFixed(3)}s target=${expected.toFixed(3)}s joins=${report!.joins.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SCENE ASSEMBLY — no audio anywhere still assembles, and the graph carries no ad reference', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scene-silent-assembly-'));
  try {
    const clips = COLOURS.map((_, i) => {
      const f = path.join(dir, `silent-${i + 1}.mp4`);
      buildClip(f, i, false);
      assert.equal(probe(f).hasAudio, false, `fixture clip ${i + 1} must be silent`);
      return f;
    });
    const out = path.join(dir, 'assembled-silent.mp4');
    const report = await concatClips(clips, out, { join: 'match-cut', joinWorkDir: path.join(dir, 'join-cut'), joinLabel: 'silent' });
    assert.ok(existsSync(out), 'silent assembly produced no output file');
    const p = probe(out);
    assert.equal(p.hasVideo, true, 'delivered file has no video stream');
    assert.equal(p.hasAudio, false, 'a video assembled from silent clips must not gain an audio stream');
    assert.ok(report, 'silent match-cut assembly must still return its join report');

    // The invariant that makes this structural: a graph with no audio may not
    // reference audio labels, and the maps may not either.
    assert.throws(
      () => assertAudioGraphIntegrity({
        filterComplex: '[0:v]fps=30,setpts=PTS-STARTPTS[v0p];[v0p]concat=n=1:v=1:a=0[vout];[0:a]atrim=0:2,adelay=0:all=1[ad0]',
        videoMap: '[vout]',
        audioMap: null,
        audioLabels: [],
      }),
      /CONCAT_GRAPH_INVARIANT/,
      'a graph that declares an ad label with no audio map must be refused before ffmpeg runs',
    );
    // eslint-disable-next-line no-console
    console.log(`[fixture] B: exit=0 streams=video duration=${p.seconds.toFixed(3)}s audioStreams=0`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SCENE ASSEMBLY — ONE narrated clip among five (the production crash) now assembles and speaks', { timeout: 300_000 }, async () => {
  // This is the exact shape of the owner's failed launch render: the join stripped
  // the narration from every clip it cut, leaving a single audio-bearing input.
  // The old single-track branch mapped it as `ad0` (no brackets) and ffmpeg exited 1.
  const dir = mkdtempSync(path.join(tmpdir(), 'scene-one-audio-'));
  try {
    const clips = COLOURS.map((_, i) => {
      const f = path.join(dir, `mixed-${i + 1}.mp4`);
      buildClip(f, i, i === 3); // only scene 4 carries narration
      return f;
    });
    const out = path.join(dir, 'assembled-one-audio.mp4');
    await concatClips(clips, out, { join: 'match-cut', joinWorkDir: path.join(dir, 'join-cut'), joinLabel: 'one-audio' });
    assert.ok(existsSync(out), 'assembly produced no output file');
    const p = probe(out);
    assert.equal(p.hasVideo, true, 'delivered file has no video stream');
    assert.equal(p.hasAudio, true, 'the one narration track was dropped from the delivered file');
    // Only one of five clips speaks, so the whole-file RMS is diluted by the four
    // silent stretches (~1.2s of tone inside 6.8s). A silent AAC track measures
    // about -91 dBFS, so -45 dB is still a wide, unambiguous margin for "audible".
    const rms = measuredRmsDb(out);
    assert.ok(Number.isFinite(rms) && rms > -45, `the surviving narration is not audible (RMS ${rms} dBFS)`);
    // eslint-disable-next-line no-console
    console.log(`[fixture] C: exit=0 streams=video+audio rms=${rms.toFixed(1)}dBFS duration=${p.seconds.toFixed(3)}s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIO GRAPH INVARIANT — the two ways this has already broken are refused before ffmpeg', () => {
  const graph = '[0:v]fps=30,setpts=PTS-STARTPTS[v0p];[v0p][1:v]concat=n=2:v=1:a=0[vout];[0:a]atrim=0:2,apad=whole_dur=4,adelay=0:all=1[ad0]';
  // Oct 9 shape: the graph declares nothing but the map names an audio label.
  assert.throws(
    () => assertAudioGraphIntegrity({ filterComplex: graph, videoMap: '[vout]', audioMap: '[ad9]', audioLabels: ['ad9'] }),
    /CONCAT_GRAPH_INVARIANT/,
  );
  // Nov 4 shape: the audio map is a bare stream-specifier token, not a label.
  assert.throws(
    () => assertAudioGraphIntegrity({ filterComplex: graph, videoMap: '[vout]', audioMap: 'ad0', audioLabels: ['ad0'] }),
    /CONCAT_GRAPH_INVARIANT/,
    'an unbracketed -map ad0 is a stream specifier and must never be emitted',
  );
  // The correct single-track shape passes.
  assertAudioGraphIntegrity({ filterComplex: graph, videoMap: '[vout]', audioMap: '[ad0]', audioLabels: ['ad0'] });
  // A declared label that never made it into the graph is refused.
  assert.throws(
    () => assertAudioGraphIntegrity({ filterComplex: graph, videoMap: '[vout]', audioMap: '[ad0]', audioLabels: ['ad0', 'ad1'] }),
    /CONCAT_GRAPH_INVARIANT/,
  );
  // No audio: an audio-free graph passes, an audio-referencing one does not.
  const silentGraph = '[0:v]fps=30,setpts=PTS-STARTPTS[v0p];[v0p][1:v]concat=n=2:v=1:a=0[vout]';
  assertAudioGraphIntegrity({ filterComplex: silentGraph, videoMap: '[vout]', audioMap: null, audioLabels: [] });
  assert.throws(
    () => assertAudioGraphIntegrity({ filterComplex: silentGraph, videoMap: '[vout]', audioMap: '[aout]', audioLabels: [] }),
    /CONCAT_GRAPH_INVARIANT/,
  );
});
