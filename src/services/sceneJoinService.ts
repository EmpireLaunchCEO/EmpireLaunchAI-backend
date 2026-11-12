/**
 * SCENE JOIN — MATCH-CUT (owner decision, Nov 2 2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner's exact words set this design:
 *
 *   "running 4 8 second calls is to much wasting. we can do 4 6 seconds calls and
 *    1 8 second call. cant FFmpeg cut out ANY dip inbetween scenes? with the extra
 *    2 seconds FFmpeg has that to work with to make it as seamless as possible
 *    even ending a scene and starting the next one with the same image. if there is
 *    a 0.4 dip FFmpeg could stitch that out couldn't it?"
 *
 * So there is NO TRANSITION between scenes in Scene mode: no xfade, no dip to
 * black, no cross-dissolve (she rejected the dissolve on Oct 12 — "transition
 * flash"). Instead:
 *
 *   1. Each clip is VEO-GENERATED FROM ITS OWN DESIGNED STILL (image-to-video), and
 *      clips 1..n-1 additionally carry `lastFrame` = the NEXT scene's designed still,
 *      so the clip is *asked* to end on the next scene's picture. That steering does
 *      NOT land exactly (measured: 21.91 dB against the target vs ~45 dB for a true
 *      match) — it gets us CLOSE, which is what makes step 3 cheap.
 *   2. `blackdetect` finds black runs at either end of every clip and they are cut
 *      out — "cant FFmpeg cut out ANY dip inbetween scenes?" → yes.
 *   3. The last N frames of clip A are compared against the first N frames of clip B
 *      and the pair with the SMALLEST frame difference is chosen. Both clips are cut
 *      at that pair and concatenated with NO filter transition.
 *
 * MEASUREMENT CHOICE: frame difference is computed as PSNR on a downscaled GRAY
 * frame buffer decoded by FFmpeg (`scale=180:320,format=gray` → rawvideo). PSNR is
 * the same unit the Veo wire measurement already uses (frame 0 vs still = 47.57 dB),
 * so a join number and a fidelity number are directly comparable. It is also
 * separable: adjacent frames of the SAME shot sit in the 30–45 dB band, a different
 * picture sits well below 20 dB.
 *
 * HONEST LIMIT: this makes the join the smallest jump the material allows, NOT a
 * physically continuous shot. If the best pair is still poor the video is DELIVERED
 * (the client asked for a video, not a perfect one) and the measured delta is
 * recorded on the project so the quality is visible instead of assumed.
 */
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { mediaToolTimeoutMs, isMediaToolTimeout, mediaToolFailure } from './mediaToolDeadline.js';

// ─── Tunables (documented, deterministic) ────────────────────────────────────
/** Frames searched at each end of a join. 12 @30fps = 0.4s — the owner's own
 *  "if there is a 0.4 dip" figure. The biggest cut one join can make is therefore
 *  (N-1) tail frames + (N-1) head frames ≈ 0.73s. */
export const JOIN_SEARCH_FRAMES = 12;
/** The output cadence contract every rendered scene clip obeys (renderClip). */
export const JOIN_FPS = 30;
/** Comparison frame size (gray). Small enough to be cheap, big enough that a
 *  different picture cannot score like a matched one. */
export const JOIN_FRAME_W = 180;
export const JOIN_FRAME_H = 320;
/** A join at/above this PSNR reads as the same picture (adjacent frames of one shot
 *  normally sit 30–45 dB; a genuine scene change is well under 20 dB). */
export const JOIN_GOOD_PSNR = 30;
/** Below this the cut is visibly a cut: delivered, flagged, measured. */
export const JOIN_VISIBLE_PSNR = 20;
/** blackdetect: a frame is black below this luma and the run must last this long.
 *  0.08s ≈ 2 frames at 24fps — short enough to catch a 1–2 frame dip, long enough
 *  not to confuse a naturally dark frame with a dip. */
export const BLACK_PIX_TH = 0.10;
export const BLACK_MIN_DURATION = 0.08;
/** A detected black run longer than this is NOT a join dip — it is a broken clip.
 *  Fail loud instead of silently lopping seconds off a scene. */
export const BLACK_MAX_TRIM_SECONDS = 1.5;
/** The most of itself a single clip may give to the exact-length correction before
 *  the other clips are asked first (defect 3b — the tail is no longer the donor of
 *  first resort). The fallback pass still meets the length contract exactly. */
export const TAIL_CORRECTION_SHARE = 0.25;

export interface BlackRun { startSec: number; endSec: number; durationSec: number; }
export interface EdgeBlack { headSeconds: number; tailSeconds: number; runs: BlackRun[]; note?: string; }

/** Parse FFmpeg blackdetect stderr into runs. Pure — unit-testable. */
export function parseBlackDetect(stderr: string): BlackRun[] {
  const runs: BlackRun[] = [];
  const re = /black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(stderr || ''))) !== null) {
    const startSec = Number(m[1]);
    const endSec = Number(m[2]);
    const durationSec = Number(m[3]);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    runs.push({ startSec, endSec, durationSec: Number.isFinite(durationSec) ? durationSec : endSec - startSec });
  }
  return runs.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Which part of a clip's black runs are at its EDGES (the parts a join can remove)?
 * A run that starts within 2 frames of 0 is a head dip; one that ends within 2
 * frames of the duration is a tail dip. Anything in the middle is a real black beat
 * in the shot and is left alone. Pure.
 */
export function edgeBlackFromRuns(runs: BlackRun[], clipSeconds: number, fps = JOIN_FPS): EdgeBlack {
  const edgeTol = 2 / fps;
  let headSeconds = 0;
  let tailSeconds = 0;
  const head = runs.find((r) => r.startSec <= edgeTol);
  if (head) headSeconds = head.durationSec;
  // The tail run must END at the clip's end (a head dip that is also the whole
  // clip is not a tail dip — guard against double counting the same run).
  const tail = [...runs].reverse().find((r) => clipSeconds > 0 && r.endSec >= clipSeconds - edgeTol);
  if (tail && tail !== head) tailSeconds = tail.durationSec;
  else if (tail && head && tail === head) tailSeconds = 0;
  return { headSeconds: Math.max(0, headSeconds), tailSeconds: Math.max(0, tailSeconds), runs };
}

/** RMS error + PSNR between two equal-length 8-bit gray frames. Pure. */
export function frameDifference(a: Buffer, b: Buffer): { psnr: number; rmse: number } {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { psnr: 0, rmse: 255 };
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sq += d * d;
  }
  const rmse = Math.sqrt(sq / n);
  // Identical frames are an infinite PSNR; report a large finite number so the
  // value survives JSON (metadata) and comparisons.
  const psnr = rmse === 0 ? 99 : 20 * Math.log10(255 / rmse);
  return { psnr: Math.round(psnr * 100) / 100, rmse: Math.round(rmse * 100) / 100 };
}

export interface MatchPair {
  /** index into A's tail frames (0 = earliest of the searched window, N-1 = A's last frame) */
  tailIndex: number;
  /** index into B's head frames (0 = B's first frame) */
  headIndex: number;
  /** PSNR of the chosen pair — the number the design lives or dies on */
  psnr: number;
  /** PSNR of the untouched naive join (A's true last frame vs B's true first frame) */
  naivePsnr: number;
  /** frames dropped from A's END (after tailIndex) */
  aTailDropFrames: number;
  /** frames dropped from B's START (before headIndex) */
  bHeadDropFrames: number;
  totalDropFrames: number;
  quality: 'matched' | 'visible';
}

/**
 * Choose the cut point. `tailFrames` are A's last N frames in order (last element =
 * A's true final frame); `headFrames` are B's first N frames in order. Pure.
 *
 * `budgetFrames` (optional) caps how many frames this join may remove in total — the
 * assembly uses it so the cuts can never take more than the slack the 6s+8s plan
 * bought, which is what keeps the delivered length exact.
 */
export function chooseMatchPair(
  tailFrames: Buffer[],
  headFrames: Buffer[],
  budgetFrames: number = Number.POSITIVE_INFINITY,
): MatchPair | undefined {
  const nTail = tailFrames.length;
  const nHead = headFrames.length;
  if (nTail === 0 || nHead === 0) return undefined;
  const naive = frameDifference(tailFrames[nTail - 1], headFrames[0]);
  let best: MatchPair | undefined;
  for (let i = nTail - 1; i >= 0; i--) {
    for (let j = 0; j < nHead; j++) {
      const aTailDropFrames = nTail - 1 - i;
      const totalDropFrames = aTailDropFrames + j;
      if (totalDropFrames > budgetFrames) continue;
      const { psnr } = frameDifference(tailFrames[i], headFrames[j]);
      const candidate: MatchPair = {
        tailIndex: i,
        headIndex: j,
        psnr,
        naivePsnr: naive.psnr,
        aTailDropFrames,
        bHeadDropFrames: j,
        totalDropFrames,
        quality: psnr >= JOIN_GOOD_PSNR ? 'matched' : 'visible',
      };
      // Smallest frame difference wins; ties prefer the SMALLEST cut (keeps length
      // and refuses to spend slack it does not need).
      if (
        !best ||
        candidate.psnr > best.psnr + 1e-9 ||
        (Math.abs(candidate.psnr - best.psnr) <= 1e-9 && candidate.totalDropFrames < best.totalDropFrames)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

export interface JoinDecision {
  /** One entry per join, in video order; undefined only when a strip had no frames. */
  pairs: Array<MatchPair | undefined>;
  /** Frames each join was ALLOWED to spend — the fair share it was reserved. */
  allowances: number[];
  /** Frames actually spent on match cuts across all joins. */
  spentFrames: number;
  /** Slack the plan bought and the cuts did NOT need. */
  unusedFrames: number;
  /** Joins that had to be left uncut even though slack existed (should be empty). */
  starvedJoins: number[];
}

/**
 * Decide every join's cut under ONE shared frame budget, FAIRLY (owner Nov 5 —
 * defect 3).
 *
 * The old loop handed the whole remaining budget to each join in video order, so
 * join 0 could spend all of it for a fractionally better match and every later
 * join was silently given a 0-frame allowance — which was recorded as
 * `quality:'visible'`, a bad cut reported as a fine one. Reachable in production:
 * one join can spend up to 22 frames and a four-join plan can want 88, while black
 * trimming shrinks the slack the plan actually has.
 *
 * Now each join is reserved `floor(slack / joinsRemaining)` before it spends, so no
 * join can starve the ones after it. PSNR is still the objective WITHIN that
 * allowance. Pure: frames in, decisions out — no ffmpeg, no files.
 */
export function planJoinCuts(
  strips: Array<{ tail: Buffer[]; head: Buffer[] }>,
  slackFrames: number,
): JoinDecision {
  const budget = Math.max(0, Math.floor(Number.isFinite(slackFrames) ? slackFrames : 0));
  let slack = budget;
  const pairs: Array<MatchPair | undefined> = [];
  const allowances: number[] = [];
  const starvedJoins: number[] = [];
  for (let i = 0; i < strips.length; i++) {
    const remaining = strips.length - i;
    const allowance = Math.min(slack, Math.floor(slack / remaining));
    allowances.push(allowance);
    const { tail, head } = strips[i];
    if (!tail?.length || !head?.length) { pairs.push(undefined); continue; }
    const pair = chooseMatchPair(tail, head, allowance);
    pairs.push(pair);
    if (!pair) continue;
    slack -= pair.totalDropFrames;
    if (pair.totalDropFrames === 0) starvedJoins.push(i);
  }
  const spentFrames = pairs.reduce((a, p) => a + (p ? p.totalDropFrames : 0), 0);
  return { pairs, allowances, spentFrames, unusedFrames: Math.max(0, budget - spentFrames), starvedJoins };
}

// ─── FFmpeg-backed helpers ───────────────────────────────────────────────────
function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', timeout: mediaToolTimeoutMs('ffmpeg') }, (err, _stdout, stderr) => {
      const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
      if (err) reject(mediaToolFailure('ffmpeg', 'sceneJoinService.runFfmpeg', err, text));
      else resolve(text);
    });
  });
}
function runFfmpegRaw(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 128 * 1024 * 1024, encoding: 'buffer', timeout: mediaToolTimeoutMs('ffmpeg') }, (err, stdout, stderr) => {
      if (err) {
        const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
        reject(mediaToolFailure('ffmpeg', 'sceneJoinService.runFfmpegRaw', err, text));
      } else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || '')));
    });
  });
}
export function probeSecondsOf(file: string): number {
  try {
    const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { maxBuffer: 1024 * 1024, timeout: mediaToolTimeoutMs('ffprobe') }).toString().trim();
    const n = parseFloat(d);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (err) {
    if (isMediaToolTimeout(err)) console.warn(`[SceneJoin] probeSecondsOf TIMED OUT after ${mediaToolTimeoutMs('ffprobe')}ms on ${file} — duration is unmeasurable`);
    return 0;
  }
}
/** Does this clip carry an audio stream? Deterministic local ffprobe.
 *  WHY THIS EXISTS (owner Nov 4 launch render): every re-encode in this module
 *  used to pass `-an`, so the match-cut join silently STRIPPED the narration out
 *  of every clip it touched. The assembler then saw 1-of-5 clips with audio,
 *  emitted `-map ad0`, and the render died at the very last (already-paid) step
 *  with "Invalid stream specifier: ad0". A cut is a cut of the PICTURE — the
 *  narration belongs to the clip and must survive it. */
export function probeHasAudio(file: string): boolean {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
      { maxBuffer: 1024 * 1024, timeout: mediaToolTimeoutMs('ffprobe') },
    ).toString().trim();
    return out.length > 0;
  } catch (err) {
    if (isMediaToolTimeout(err)) console.warn(`[SceneJoin] probeHasAudio TIMED OUT after ${mediaToolTimeoutMs('ffprobe')}ms on ${file} — treating as no audio`);
    return false;
  }
}

/** ─── PICTURE INVARIANT (owner launch render #3, Nov 4 2026) ──────────────────
 *  THE THIRD `-map` DISAGREEMENT — and the last one that can reach the concat.
 *
 *  In ffmpeg, as soon as ANY `-map` is given, ONLY the mapped streams are written.
 *  `cutFrames` mapped the narration (`-map 0:a:0`) and nothing else, so it wrote an
 *  AUDIO-ONLY file and the `-vf` picture chain was silently ignored; the exact-length
 *  correction then called `trimTailSeconds` on that file and assembly died with
 *  "Stream map '0:v:0' matches no streams" — AFTER every paid stage of the owner's
 *  launch video. Oct 9 (xfade labels) and Nov 4 (bare `ad0`) were the same class.
 *
 *  So every helper below that WRITES a clip now probes what it actually wrote and
 *  refuses to return a clip with no picture — and refuses to drop a narration the
 *  source carried. A video-less clip can no longer reach the concat at all: the
 *  failure is a named, precise error at the helper instead of a raw ffmpeg exit
 *  code at the very end of an already-paid render. */
export interface ClipStreams { hasVideo: boolean; hasAudio: boolean; types: string[]; }

/** What streams does this file actually contain? (local ffprobe, deterministic) */
export function probeStreams(file: string): ClipStreams {
  let types: string[] = [];
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file],
      { maxBuffer: 1024 * 1024, timeout: mediaToolTimeoutMs('ffprobe') },
    ).toString();
    types = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    if (isMediaToolTimeout(err)) console.warn(`[SceneJoin] probeStreams TIMED OUT after ${mediaToolTimeoutMs('ffprobe')}ms on ${file} — no stream list, so the picture invariant will refuse the clip`);
    types = [];
  }
  return { hasVideo: types.includes('video'), hasAudio: types.includes('audio'), types };
}

/** PURE half of the invariant: given what a clip actually contains, throw unless it
 *  has a picture — and unless it still carries the narration its source had. */
export function assertClipStreams(
  streams: ClipStreams,
  opts: { helper: string; file: string; expectAudio: boolean },
): void {
  const list = streams.types.length ? streams.types.join(',') : 'none';
  if (!streams.hasVideo) {
    throw new Error(
      `CLIP_PICTURE_INVARIANT ${opts.helper} wrote a clip with NO video stream — file=${opts.file} streams=[${list}]. ` +
      `A -map list that omits 0:v:0 makes ffmpeg write only the mapped streams and silently IGNORE the -vf chain ` +
      `(that is what wrote audio-only match-cut clips and killed the launch render at "Stream map '0:v:0' matches no streams"). ` +
      `Refusing to let a video-less clip reach the concat.`,
    );
  }
  if (opts.expectAudio && !streams.hasAudio) {
    throw new Error(
      `CLIP_AUDIO_INVARIANT ${opts.helper} dropped the narration — file=${opts.file} streams=[${list}]. ` +
      `The clip carried an audio stream before the cut, so it must carry one after it.`,
    );
  }
}

/** Probe the clip a helper just wrote and enforce the invariant on it. */
export function assertClipPicture(file: string, helper: string, expectAudio: boolean): void {
  assertClipStreams(probeStreams(file), { helper, file, expectAudio });
}

/** The audio half of a re-encode: carry the clip's narration through, or say
 *  explicitly that there is none. Never leaves the choice to ffmpeg's default.
 *  NOTE: this is only HALF a map list — every caller must pair it with
 *  `-map 0:v:0`, because the presence of any `-map` suppresses ffmpeg's default
 *  stream selection (the defect that cost the launch render). */
function audioCarryArgs(carry: boolean): string[] {
  return carry
    ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2']
    : ['-an'];
}

export function probeFrameCount(file: string): number {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1:nokey=1', file], { maxBuffer: 4 * 1024 * 1024, timeout: mediaToolTimeoutMs('ffprobe') }).toString().trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (err) {
    if (isMediaToolTimeout(err)) console.warn(`[SceneJoin] probeFrameCount TIMED OUT after ${mediaToolTimeoutMs('ffprobe')}ms on ${file} — frame count is unmeasurable`);
    return 0;
  }
}

/** blackdetect a clip and report ONLY its edge dips. */
export async function detectEdgeBlack(file: string): Promise<EdgeBlack> {
  const seconds = probeSecondsOf(file);
  const stderr = await runFfmpeg([
    '-hide_banner', '-nostats', '-i', file,
    '-vf', `blackdetect=d=${BLACK_MIN_DURATION}:pix_th=${BLACK_PIX_TH}`,
    '-f', 'null', '-',
  ]);
  const runs = parseBlackDetect(stderr);
  const edge = edgeBlackFromRuns(runs, seconds);
  if (edge.headSeconds > BLACK_MAX_TRIM_SECONDS || edge.tailSeconds > BLACK_MAX_TRIM_SECONDS) {
    throw new Error(
      `match-cut join: ${path.basename(file)} has a black run longer than ${BLACK_MAX_TRIM_SECONDS}s at its edge ` +
      `(head=${edge.headSeconds.toFixed(2)}s tail=${edge.tailSeconds.toFixed(2)}s) — that is a broken clip, not a join dip. Refusing to silently cut seconds off a scene.`,
    );
  }
  return edge;
}

/** Remove leading/trailing black runs. Returns the path written. */
export async function trimEdgeBlack(file: string, out: string): Promise<{ path: string; removedHead: number; removedTail: number; seconds: number }> {
  const edge = await detectEdgeBlack(file);
  const total = probeSecondsOf(file);
  const start = Math.max(0, edge.headSeconds - 1 / JOIN_FPS); // keep 1 frame of safety
  const keep = Math.max(0.1, total - start - Math.max(0, edge.tailSeconds - 1 / JOIN_FPS));
  const carry = probeHasAudio(file);
  if (edge.headSeconds === 0 && edge.tailSeconds === 0) {
    // Pass-through: nothing was written, but the clip that continues to the join is
    // still held to the picture invariant (a video-less input must fail HERE).
    assertClipPicture(file, 'trimEdgeBlack (pass-through)', carry);
    return { path: file, removedHead: 0, removedTail: 0, seconds: total };
  }
  await runFfmpeg([
    '-hide_banner', '-nostats', '-y',
    // `-ss` BEFORE `-i` = input seek, so it applies to the audio stream too: the
    // narration stays frame-aligned with the picture it was fitted to.
    '-ss', start.toFixed(3), '-i', file, '-t', keep.toFixed(3),
    // PICTURE FIRST, ALWAYS: any `-map` suppresses ffmpeg's default selection, so
    // 0:v:0 must be named explicitly next to the audio map (or the -vf is ignored).
    '-map', '0:v:0', ...audioCarryArgs(carry),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(JOIN_FPS),
    '-movflags', '+faststart', out,
  ]);
  assertClipPicture(out, 'trimEdgeBlack', carry);
  return { path: out, removedHead: edge.headSeconds, removedTail: edge.tailSeconds, seconds: probeSecondsOf(out) };
}

/** Decode N gray frames from a clip's tail (position='tail') or head. */
export async function extractFrameStrip(file: string, position: 'head' | 'tail', count: number): Promise<Buffer[]> {
  const seekArgs = position === 'tail'
    ? ['-sseof', `-${((count + 3) / JOIN_FPS + 0.05).toFixed(3)}`]
    : ['-t', `${((count + 3) / JOIN_FPS + 0.05).toFixed(3)}`];
  const raw = await runFfmpegRaw([
    '-hide_banner', '-nostats', '-loglevel', 'error',
    ...seekArgs, '-i', file,
    '-vf', `fps=${JOIN_FPS},scale=${JOIN_FRAME_W}:${JOIN_FRAME_H},format=gray`,
    '-f', 'rawvideo', '-',
  ]);
  const frameBytes = JOIN_FRAME_W * JOIN_FRAME_H;
  const frames: Buffer[] = [];
  for (let off = 0; off + frameBytes <= raw.length; off += frameBytes) frames.push(raw.subarray(off, off + frameBytes));
  return position === 'tail' ? frames.slice(-count) : frames.slice(0, count);
}

/** Cut a clip's head and/or tail by an exact number of frames (output re-encoded at
 *  the 30fps contract). Frame-exact: `trim` on frame indices, never a time guess.
 *
 *  CADENCE DISCIPLINE: the frame indices are indices on the **30fps timeline** —
 *  `fps=30` runs BEFORE `trim`, exactly as it does in `extractFrameStrip`, so the
 *  index the search chose is the index this cut uses even when the provider handed
 *  us a 24fps clip (Veo's native cadence). Getting this wrong silently cuts at the
 *  wrong frame and turns a 44 dB match into a visible jump — measured, then fixed. */
export async function cutFrames(file: string, out: string, dropHeadFrames: number, dropTailFrames: number): Promise<string> {
  const total = Math.round(probeSecondsOf(file) * JOIN_FPS);
  if (!total) throw new Error(`match-cut join: could not measure ${path.basename(file)} — refusing to guess a cut point`);
  const startFrame = Math.max(0, Math.min(dropHeadFrames, total - 2));
  const endFrame = Math.max(startFrame + 1, total - Math.max(0, dropTailFrames));
  // NARRATION SURVIVES THE CUT: the audio is trimmed on the SAME 30fps timeline
  // (startFrame/30 .. endFrame/30) and its timestamps reset, so the line stays
  // where it was spoken relative to the picture. Without this the match-cut join
  // silently deleted the narration of every clip it touched.
  const carry = probeHasAudio(file);
  // PICTURE + NARRATION, BOTH MAPPED EXPLICITLY. `-map 0:a:0` on its own is not
  // "keep the audio as well" — it is "write ONLY the audio": ffmpeg's default
  // stream selection is suppressed by the first `-map`, so the `-vf` picture chain
  // is dropped and the output is an audio-only file. That file then died in
  // `trimTailSeconds` ("Stream map '0:v:0' matches no streams") at the last step of
  // the owner's launch render, after every paid stage had been spent.
  const audioArgs = carry
    ? [
        '-map', '0:a:0',
        '-af', `atrim=start=${(startFrame / JOIN_FPS).toFixed(3)}:end=${(endFrame / JOIN_FPS).toFixed(3)},asetpts=N/SR/TB`,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      ]
    : ['-an'];
  await runFfmpeg([
    '-hide_banner', '-nostats', '-y', '-i', file,
    '-map', '0:v:0',
    '-vf', `fps=${JOIN_FPS},trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS`,
    ...audioArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(JOIN_FPS),
    '-movflags', '+faststart', out,
  ]);
  // The cut must not be able to produce anything the concat cannot use.
  assertClipPicture(out, 'cutFrames', carry);
  return out;
}

/** Trim `seconds` off the END of a clip (used for the exact-length correction). */
export async function trimTailSeconds(file: string, out: string, keepSeconds: number): Promise<string> {
  const carry = probeHasAudio(file);
  await runFfmpeg([
    '-hide_banner', '-nostats', '-y', '-i', file,
    '-t', Math.max(0.1, keepSeconds).toFixed(3),
    '-map', '0:v:0', ...audioCarryArgs(carry),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(JOIN_FPS),
    '-movflags', '+faststart', out,
  ]);
  assertClipPicture(out, 'trimTailSeconds', carry);
  return out;
}

export interface JoinReport {
  from: number;
  to: number;
  /** PSNR of A's real last frame vs B's real first frame, before any cutting */
  naivePsnr: number;
  /** PSNR of the frame pair the join was actually cut on */
  cutPsnr: number;
  aTailDropFrames: number;
  bHeadDropFrames: number;
  cutSeconds: number;
  quality: 'matched' | 'visible';
  blackHeadSeconds: number;
  blackTailSeconds: number;
}

export interface MatchCutReport {
  joinedBy: 'match-cut';
  transition: 'none';
  /** frames searched at each end of every join */
  searchFrames: number;
  /** every join, in order */
  joins: JoinReport[];
  /** worst cut PSNR across the joins — the number to watch */
  worstCutPsnr: number;
  /** any join whose best pair was still visibly different */
  visibleJoins: number;
  blackTrimmedSeconds: number;
  targetSeconds: number;
  deliveredSeconds: number;
  correctionSeconds: number;
  frameRate: number;
  /** Frames each join was reserved before it spent (defect 3 — fair share). */
  joinFrameAllowances: number[];
  /** Slack the plan bought that the match cuts did not need. */
  unusedSlackFrames: number;
}

export interface MatchCutPlan { paths: string[]; report: MatchCutReport; }

/**
 * Cut every clip so the joins land on their best-matching frame pairs, then make the
 * total length EXACTLY `targetSeconds` (using the 6s+8s slack the plan buys).
 *
 * Order of operations per clip: black edges out first (a dip is a dip), THEN the
 * match cut (that is what gives the comparison real picture instead of black).
 * Between two clips the head-cut of B and the tail-cut of A are decided together —
 * the pair, not the two ends separately.
 */
export async function planMatchCutCuts(
  clips: string[],
  opts: { workDir: string; targetSeconds?: number; searchFrames?: number; label?: string },
): Promise<MatchCutPlan> {
  const { workDir } = opts;
  const searchFrames = Math.max(2, opts.searchFrames ?? JOIN_SEARCH_FRAMES);
  fs.mkdirSync(workDir, { recursive: true });
  const tag = opts.label ? `${opts.label}-` : '';
  if (!clips.length) throw new Error('match-cut join: no clips given');

  // 1. BLACK EDGES OUT
  const deblacked: string[] = [];
  let blackTrimmedSeconds = 0;
  const black: { headSeconds: number; tailSeconds: number }[] = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(workDir, `${tag}deblack-${i}.mp4`);
    const r = await trimEdgeBlack(clips[i], out);
    blackTrimmedSeconds += r.removedHead + r.removedTail;
    black.push({ headSeconds: r.removedHead, tailSeconds: r.removedTail });
    deblacked.push(r.path);
  }

  // 2. MATCH EACH JOIN
  const joins: JoinReport[] = [];
  const dropHead: number[] = deblacked.map(() => 0);
  const dropTail: number[] = deblacked.map(() => 0);
  const lengths = deblacked.map((f) => probeSecondsOf(f));
  let kept = lengths.reduce((a, b) => a + b, 0);
  const target = Number.isFinite(opts.targetSeconds) && (opts.targetSeconds as number) > 0
    ? (opts.targetSeconds as number)
    : kept;
  // The slack the plan bought (32s of take for a 30s video) — cuts may never spend
  // more than this, or the delivered video would come out SHORT.
  const slackFrames = Math.max(0, Math.floor((kept - target) * JOIN_FPS));
  // Decode every join's search window FIRST, then decide all the cuts together under
  // one FAIR budget (planJoinCuts). Nothing here may spend the budget in join order.
  const strips: Array<{ tail: Buffer[]; head: Buffer[] }> = [];
  for (let i = 0; i + 1 < deblacked.length; i++) {
    const [tailFrames, headFrames] = await Promise.all([
      extractFrameStrip(deblacked[i], 'tail', searchFrames),
      extractFrameStrip(deblacked[i + 1], 'head', searchFrames),
    ]);
    if (tailFrames.length < 2 || headFrames.length < 2) {
      throw new Error(`match-cut join: could not decode frames at the ${i}→${i + 1} join (tail=${tailFrames.length} head=${headFrames.length}) — refusing to cut blind`);
    }
    strips.push({ tail: tailFrames, head: headFrames });
  }
  const decision = planJoinCuts(strips, slackFrames);
  for (let i = 0; i < decision.pairs.length; i++) {
    const pair = decision.pairs[i];
    const { tail, head } = strips[i];
    if (!pair) {
      // A strip with no decodable frames — unreachable in practice (thrown above).
      joins.push({
        from: i, to: i + 1, naivePsnr: frameDifference(tail[tail.length - 1], head[0]).psnr,
        cutPsnr: frameDifference(tail[tail.length - 1], head[0]).psnr,
        aTailDropFrames: 0, bHeadDropFrames: 0, cutSeconds: 0, quality: 'visible',
        blackHeadSeconds: black[i + 1].headSeconds, blackTailSeconds: black[i].tailSeconds,
      });
      continue;
    }
    dropTail[i] = pair.aTailDropFrames;
    dropHead[i + 1] = pair.bHeadDropFrames;
    joins.push({
      from: i, to: i + 1,
      naivePsnr: pair.naivePsnr,
      cutPsnr: pair.psnr,
      aTailDropFrames: pair.aTailDropFrames,
      bHeadDropFrames: pair.bHeadDropFrames,
      cutSeconds: Math.round((pair.totalDropFrames / JOIN_FPS) * 1000) / 1000,
      quality: pair.quality,
      blackHeadSeconds: black[i + 1].headSeconds,
      blackTailSeconds: black[i].tailSeconds,
    });
    kept -= pair.totalDropFrames / JOIN_FPS;
  }
  if (decision.starvedJoins.length) {
    // Loud, never silent: a join that spent nothing while slack existed is exactly
    // the "bad cut reported as a fine one" this fix exists to stop.
    console.warn(`[sceneJoin] joins left uncut while ${decision.unusedFrames} slack frames remained: [${decision.starvedJoins.join(',')}]`);
  }

  // 3. APPLY THE CUTS (frame-exact)
  const cutPaths: string[] = [];
  for (let i = 0; i < deblacked.length; i++) {
    if (dropHead[i] === 0 && dropTail[i] === 0) { cutPaths.push(deblacked[i]); continue; }
    const out = path.join(workDir, `${tag}cut-${i}.mp4`);
    cutPaths.push(await cutFrames(deblacked[i], out, dropHead[i], dropTail[i]));
  }

  // 4. EXACT LENGTH — the delivered total must be the planned total. The arithmetic
  //    is unchanged (the total removed is exactly the excess), but WHICH clip gives is
  //    now spread instead of taken off the tail first (owner Nov 5 — defect 3b: the
  //    last scene was starved twice, once by the greedy join budget and again here).
  //    Pass 1 lets no clip give more than TAIL_CORRECTION_SHARE of itself; pass 2
  //    falls back to the old unbounded walk so the length contract is still met.
  const have = cutPaths.map((f) => probeSecondsOf(f));
  const sum = have.reduce((a, b) => a + b, 0);
  let correctionSeconds = 0;
  if (sum > target + 0.02) {
    let excess = sum - target;
    const trimPass = async (minKeep: (len: number) => number, suffix: string): Promise<void> => {
      for (let i = cutPaths.length - 1; i >= 0 && excess > 0.02; i--) {
        const keep = Math.max(0.5, minKeep(have[i]), have[i] - excess);
        const removed = have[i] - keep;
        if (removed <= 0.02) continue;
        const out = path.join(workDir, `${tag}${suffix}-${i}.mp4`);
        cutPaths[i] = await trimTailSeconds(cutPaths[i], out, keep);
        have[i] = probeSecondsOf(cutPaths[i]);
        correctionSeconds += removed;
        excess -= removed;
      }
    };
    await trimPass((len) => len * (1 - TAIL_CORRECTION_SHARE), 'exact');
    await trimPass(() => 0, 'exact2');
  }
  const deliveredSeconds = have.reduce((a, b) => a + b, 0);
  const worstCutPsnr = joins.length ? Math.min(...joins.map((j) => j.cutPsnr)) : 99;
  const report: MatchCutReport = {
    joinedBy: 'match-cut',
    transition: 'none',
    searchFrames,
    joins,
    worstCutPsnr,
    visibleJoins: joins.filter((j) => j.quality === 'visible').length,
    blackTrimmedSeconds: Math.round(blackTrimmedSeconds * 1000) / 1000,
    targetSeconds: Math.round(target * 1000) / 1000,
    deliveredSeconds: Math.round(deliveredSeconds * 1000) / 1000,
    correctionSeconds: Math.round(correctionSeconds * 1000) / 1000,
    frameRate: JOIN_FPS,
    joinFrameAllowances: decision.allowances,
    unusedSlackFrames: decision.unusedFrames,
  };
  return { paths: cutPaths, report };
}
