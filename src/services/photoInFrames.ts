/**
 * ─── IS HER PHOTO ACTUALLY IN THE FINISHED FRAMES? (roadmap 78) ──────────────
 *
 * Owner rule: "anything the client uploads must change the output" — and until
 * now nothing measured whether it did. `metadata.sourceImagePlacement` is written
 * from the PLAN, so a video that never composited her photo still claimed it was
 * placed. This module is the MEASUREMENT, on the delivered file, $0:
 *
 *   1. `readGrayImage` / `readGrayFrames` — decode the uploaded photo and a
 *      handful of frames from the scene window(s) it was assigned to, as plain
 *      grayscale pixels (ffmpeg only; no model, no paid call).
 *   2. `centerCropGrid` — the photo may be cropped or scaled into the frame, so
 *      every image is reduced to a 9x8 grid at a ladder of centre-crop zooms.
 *   3. `compareGrids` — dHash (64 bits, Hamming distance) AND the Pearson
 *      correlation of the same 72 luminance values. Two independent tests, so a
 *      flat or blurry crop cannot pass on structure alone.
 *   4. `measurePhotoInFrames` — the verdict, from pixels:
 *        'present'            the photo's own content is in the frames
 *        'absent'             it is not, measured on real frames
 *        'not-pixel-provable'  no measurement was possible — and `reason` says why
 *                             (unreadable photo, no frames, no assigned scene).
 *                             NEVER a pass.
 *   5. `ensurePhotoInDeliveredFrames` — REPAIR BEFORE REFUSAL: on 'absent' the
 *      photo is composited into the scene window(s) it was assigned to (scale,
 *      no distortion, centred) and the check re-runs on the NEW file. Present
 *      after that ⇒ `repaired: true`. Still absent ⇒ the caller must say so in
 *      her words and claim nothing.
 *
 * A check that cannot fail proves nothing (plan rule 20): the fixture builds a
 * render where the photo was never composited and requires 'absent'.
 *
 * Pure comparison logic is exported so the fixture can pin it without ffmpeg.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/** One decoded image: grayscale bytes, row-major. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The 9x8 luminance grid a comparison is made on (72 values, 0–255). */
export interface GrayGrid {
  width: number;
  height: number;
  values: number[];
}

export interface GridComparison {
  /** dHash Hamming distance over 64 bits (0 = identical structure). */
  hamming: number;
  /** Pearson correlation of the same 72 luminance values (−1..1, 0 = flat). */
  correlation: number;
  /** Both tests passed. */
  match: boolean;
}

export type PhotoInFramesVerdictKind = 'present' | 'absent' | 'not-pixel-provable';

export interface PhotoInFramesResult {
  verdict: PhotoInFramesVerdictKind;
  /** Best (lowest) Hamming distance found; null when nothing was measured. */
  bestDistance: number | null;
  framesChecked: number;
  /** The frame the best match was found on, in video time. */
  matchedFrame: { sceneNumber: number; atSeconds: number } | null;
  repaired: boolean;
  /** Plain reason — always present when the verdict is not 'present'. */
  reason?: string;
  /** The scene numbers the photo was assigned to (placement targets). */
  sceneNumbers: number[];
  /** Internal: the repaired file to deliver, when the repair produced one. */
  repairedVideoPath?: string;
}

/* ───────────────────────────── thresholds ───────────────────────────── */

/**
 * The joint gate. dHash alone says "the light goes this way" — a blurred 9x8
 * grid of an unrelated scene can land inside 12 bits. The correlation of the
 * same 72 values is the second opinion that makes a match mean something.
 * Calibrated on the fixture (negative control: a real render WITHOUT the photo
 * must fail) — never loosened to make a test pass.
 */
export const PHOTO_MATCH_MAX_HAMMING = 12;
export const PHOTO_MATCH_MIN_CORRELATION = 0.8;
/** Centre-crop zoom ladder (fraction of the shorter side). Dense because the
 *  photo may be cover-cropped, contained, or a small inset — we do not know. */
export const PHOTO_CROP_ZOOMS = [
  1, 0.88, 0.78, 0.69, 0.61, 0.54, 0.48, 0.42, 0.37, 0.33, 0.29, 0.25,
];
export const GRID_W = 9;
export const GRID_H = 8;

/* ─────────────────────── pure comparison (no I/O) ───────────────────── */

/**
 * Reduce a square centre crop of `image` (side = min(w,h) * zoom, centred) to a
 * 9x8 grid by box-averaging. Pure arithmetic — the whole zoom ladder is free.
 */
export function centerCropGrid(image: GrayImage, zoom = 1, gw = GRID_W, gh = GRID_H): GrayGrid {
  const { width, height, data } = image;
  const short = Math.min(width, height);
  const z = Math.min(1, Math.max(0.01, Number(zoom) || 1));
  const side = Math.max(1, Math.round(short * z));
  const x0 = Math.floor((width - side) / 2);
  const y0 = Math.floor((height - side) / 2);
  const values: number[] = [];
  for (let gy = 0; gy < gh; gy++) {
    const ya = y0 + Math.floor((gy * side) / gh);
    const yb = Math.max(ya + 1, y0 + Math.floor(((gy + 1) * side) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const xa = x0 + Math.floor((gx * side) / gw);
      const xb = Math.max(xa + 1, x0 + Math.floor(((gx + 1) * side) / gw));
      let sum = 0;
      let n = 0;
      for (let y = ya; y < Math.min(yb, y0 + side); y++) {
        const row = y * width;
        for (let x = xa; x < Math.min(xb, x0 + side); x++) {
          sum += data[row + x];
          n++;
        }
      }
      values.push(n ? sum / n : 0);
    }
  }
  return { width: gw, height: gh, values };
}

/**
 * dHash over the grid: one bit per horizontal neighbour comparison, 8x8 = 64
 * bits. BigInt keeps the hash exact (no float string round-trip).
 */
export function dhashFromGrid(grid: GrayGrid): bigint {
  let bits = 0n;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W - 1; x++) {
      const left = grid.values[y * GRID_W + x];
      const right = grid.values[y * GRID_W + x + 1];
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * Pearson correlation of the two grids' luminance. 0 when either grid is flat —
 * a flat grid carries no structure, and claiming a match from it would be the
 * exact kind of false pass this module exists to prevent.
 */
export function gridCorrelation(a: GrayGrid, b: GrayGrid): number {
  const n = Math.min(a.values.length, b.values.length);
  if (!n) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a.values[i];
    sb += b.values[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a.values[i] - ma;
    const y = b.values[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da < 1e-6 || db < 1e-6) return 0;
  return num / Math.sqrt(da * db);
}

export function compareGrids(
  a: GrayGrid,
  b: GrayGrid,
  maxHamming = PHOTO_MATCH_MAX_HAMMING,
  minCorrelation = PHOTO_MATCH_MIN_CORRELATION,
): GridComparison {
  const hamming = hammingDistance(dhashFromGrid(a), dhashFromGrid(b));
  const correlation = gridCorrelation(a, b);
  return { hamming, correlation, match: hamming <= maxHamming && correlation >= minCorrelation };
}

export interface BestMatch extends GridComparison {
  photoZoom: number;
  frameZoom: number;
  frameIndex: number;
}

/**
 * Best match of one photo against many frames, over the whole zoom ladder.
 * "Best" is the closest structure (lowest Hamming) among the pairs that also
 * pass the correlation gate; when none pass, the closest pair overall is
 * returned so the recorded distance is the honest best we saw.
 */
export function bestPhotoFrameMatch(
  photo: GrayImage,
  frames: GrayImage[],
  zooms: number[] = PHOTO_CROP_ZOOMS,
  maxHamming = PHOTO_MATCH_MAX_HAMMING,
  minCorrelation = PHOTO_MATCH_MIN_CORRELATION,
): BestMatch {
  const photoGrids = zooms.map((z) => centerCropGrid(photo, z));
  let best: BestMatch = { hamming: 65, correlation: -1, match: false, photoZoom: 1, frameZoom: 1, frameIndex: -1 };
  let bestMatching: BestMatch | null = null;
  frames.forEach((frame, frameIndex) => {
    zooms.forEach((fz) => {
      const frameGrid = centerCropGrid(frame, fz);
      photoGrids.forEach((pg, pi) => {
        const cmp = compareGrids(pg, frameGrid, maxHamming, minCorrelation);
        const candidate: BestMatch = { ...cmp, photoZoom: zooms[pi], frameZoom: fz, frameIndex };
        if (cmp.hamming < best.hamming || (cmp.hamming === best.hamming && cmp.correlation > best.correlation)) best = candidate;
        if (cmp.match && (!bestMatching || cmp.hamming < bestMatching.hamming
          || (cmp.hamming === bestMatching.hamming && cmp.correlation > bestMatching.correlation))) {
          bestMatching = candidate;
        }
      });
    });
  });
  return bestMatching ?? best;
}

/* ─────────────────────────── ffmpeg read path ────────────────────────── */

const FFMPEG_TIMEOUT_MS = 120_000;
const MAX_FRAME_EDGE = 640;
const MAX_PHOTO_EDGE = 640;

/** Width/height of the first video (or image) stream. */
export function probeSize(file: string): { width: number; height: number } {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x', file,
  ], { maxBuffer: 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS }).toString().trim();
  const [w, h] = out.split('\n')[0].split('x').map((n) => Number(n));
  return { width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0 };
}

/** Even, capped output size so every raw frame has a known byte length. */
function scaledSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const k = Math.min(1, maxEdge / Math.max(width, height));
  const even = (n: number) => Math.max(2, Math.round(n * k / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Decode one image (a photo, or one frame of a video) to grayscale pixels. */
export function readGrayImage(file: string, atSeconds?: number): GrayImage {
  const size = probeSize(file);
  if (!size.width || !size.height) throw new Error(`could not read image size of ${path.basename(file)}`);
  const out = scaledSize(size.width, size.height, MAX_PHOTO_EDGE);
  const args = ['-v', 'error'];
  if (atSeconds !== undefined) args.push('-ss', String(Math.max(0, atSeconds)));
  args.push('-i', file, '-frames:v', '1',
    '-vf', `scale=${out.width}:${out.height},format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1');
  const buf = execFileSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS });
  return { width: out.width, height: out.height, data: new Uint8Array(buf) };
}

/**
 * A handful of frames spread across [startSec, endSec) — never one, because a
 * single frame can land on a dissolve or a black frame. The window edges are
 * skipped for the same reason.
 */
export function readGrayFrames(
  file: string,
  startSec: number,
  endSec: number,
  samples = 5,
): { frames: GrayImage[]; times: number[] } {
  const size = probeSize(file);
  if (!size.width || !size.height) throw new Error(`could not read video size of ${path.basename(file)}`);
  const out = scaledSize(size.width, size.height, MAX_FRAME_EDGE);
  const span = Math.max(0.1, endSec - startSec);
  const margin = Math.min(0.35, span * 0.15);
  const inner = Math.max(0.1, span - margin * 2);
  const fps = Math.max(0.1, samples / inner);
  const args = [
    '-v', 'error',
    '-ss', String(Math.max(0, startSec + margin)),
    '-t', String(inner),
    '-i', file,
    '-vf', `fps=${fps.toFixed(4)},scale=${out.width}:${out.height},format=gray`,
    '-vsync', '0',
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ];
  const buf = execFileSync('ffmpeg', args, { maxBuffer: 128 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS });
  const frameBytes = out.width * out.height;
  const count = Math.floor(buf.length / frameBytes);
  const frames: GrayImage[] = [];
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      width: out.width,
      height: out.height,
      data: new Uint8Array(buf.subarray(i * frameBytes, (i + 1) * frameBytes)),
    });
    times.push(Number((startSec + margin + i / fps).toFixed(3)));
  }
  return { frames, times };
}

/* ───────────────────────────── the verdict ──────────────────────────── */

export interface PhotoWindow {
  sceneNumber: number;
  startSec: number;
  endSec: number;
}

export interface MeasureOptions {
  videoPath: string;
  photoPath: string;
  windows: PhotoWindow[];
  samplesPerWindow?: number;
  maxHamming?: number;
  minCorrelation?: number;
}

/**
 * Measure the photo in the delivered file. Deterministic, $0, no model call.
 * `not-pixel-provable` is only ever returned when no measurement was possible,
 * and `reason` always says which one.
 */
export function measurePhotoInFrames(opts: MeasureOptions): PhotoInFramesResult {
  const sceneNumbers = [...new Set(opts.windows.map((w) => w.sceneNumber))].sort((a, b) => a - b);
  const base: PhotoInFramesResult = {
    verdict: 'not-pixel-provable',
    bestDistance: null,
    framesChecked: 0,
    matchedFrame: null,
    repaired: false,
    sceneNumbers,
  };
  if (!sceneNumbers.length) {
    return { ...base, reason: 'the photo was not assigned to any scene, so there is no frame to measure it in' };
  }
  if (!opts.photoPath || !fs.existsSync(opts.photoPath)) {
    return { ...base, reason: 'the uploaded photo could not be read, so its pixels were never compared with the video' };
  }
  if (!opts.videoPath || !fs.existsSync(opts.videoPath)) {
    return { ...base, reason: 'the delivered video file was not readable, so no frame could be measured' };
  }
  let photo: GrayImage;
  try {
    photo = readGrayImage(opts.photoPath);
  } catch (err: any) {
    return { ...base, reason: `the uploaded photo could not be decoded (${err?.message || 'unknown error'})` };
  }
  const samples = Math.max(2, opts.samplesPerWindow ?? 5);
  let best: BestMatch | null = null;
  let framesChecked = 0;
  let lastError: string | undefined;
  for (const w of opts.windows) {
    let frames: GrayImage[] = [];
    let times: number[] = [];
    try {
      const read = readGrayFrames(opts.videoPath, w.startSec, w.endSec, samples);
      frames = read.frames;
      times = read.times;
    } catch (err: any) {
      lastError = err?.message || 'frame extraction failed';
      continue;
    }
    if (!frames.length) { lastError = 'no frame could be extracted from the scene window'; continue; }
    framesChecked += frames.length;
    const match = bestPhotoFrameMatch(photo, frames, PHOTO_CROP_ZOOMS, opts.maxHamming, opts.minCorrelation);
    if (!best || match.hamming < best.hamming
      || (match.hamming === best.hamming && match.correlation > best.correlation)
      || (match.match && !best.match)) {
      best = { ...match, frameIndex: match.frameIndex };
      (best as any).__sceneNumber = w.sceneNumber;
      (best as any).__times = times;
    }
  }
  if (!best || framesChecked === 0) {
    return { ...base, framesChecked, reason: lastError || 'no frame could be extracted from the delivered video' };
  }
  const times = ((best as any).__times as number[]) || [];
  const sceneNumber = (best as any).__sceneNumber as number;
  return {
    verdict: best.match ? 'present' : 'absent',
    bestDistance: best.hamming,
    framesChecked,
    matchedFrame: best.match ? { sceneNumber, atSeconds: times[best.frameIndex] ?? null } : null,
    repaired: false,
    ...(best.match ? {} : {
      reason: `measured ${framesChecked} frame(s) in scene(s) ${sceneNumbers.join(', ')}: the closest frame was ${best.hamming} bits away (correlation ${best.correlation.toFixed(2)}), which is not the uploaded photo`,
    }),
    sceneNumbers,
  };
}

/* ────────────────────────────── the repair ──────────────────────────── */

/** A `between(t,a,b)` clause per window, joined into one enable expression. */
export function overlayEnableExpression(windows: PhotoWindow[]): string {
  return windows
    .filter((w) => Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec > w.startSec)
    .map((w) => `between(t,${w.startSec.toFixed(3)},${w.endSec.toFixed(3)})`)
    .join('+') || '0';
}

/**
 * REPAIR: composite the photo into the scene window(s) it was assigned to.
 * Scaled to fit (never stretched), centred, no crop of her photo, inside the
 * existing window — the picture and the timing are otherwise untouched, and the
 * audio is stream-copied.
 */
export function compositePhotoIntoWindows(opts: {
  videoPath: string;
  photoPath: string;
  windows: PhotoWindow[];
  outPath: string;
}): void {
  const enable = overlayEnableExpression(opts.windows);
  if (enable === '0') throw new Error('no scene window to composite the photo into');
  // The still is BOUNDED to the video's own length: an unbounded `-loop 1` input
  // never ends, and overlay's default `eof_action=repeat` then repeats the last
  // frame forever — the repair would encode an endless file instead of the video.
  const seconds = probeSeconds(opts.videoPath);
  if (!(seconds > 0)) throw new Error('could not read the length of the video to repair');
  const args = [
    '-y', '-v', 'error',
    '-i', opts.videoPath,
    '-loop', '1', '-t', seconds.toFixed(3), '-i', opts.photoPath,
    '-filter_complex',
    `[1:v]scale=w=trunc(iw*0.86/2)*2:h=trunc(ih*0.86/2)*2,format=yuv420p[ph];`
    + `[0:v][ph]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:shortest=1:enable='${enable}'[v]`,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart',
    opts.outPath,
  ];
  execFileSync('ffmpeg', args, { maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
}

/** Duration of a media file in seconds (0 when it cannot be read). */
export function probeSeconds(file: string): number {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { maxBuffer: 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS }).toString().trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/* ─────────────────────── measure → repair → measure ─────────────────── */

export interface EnsureOptions extends MeasureOptions {
  /** Where the repaired file is written (default: beside the delivered file). */
  repairedPath?: string;
  /** Download the photo when only a URL is available (R2 / presigned). */
  photoUrl?: string;
  /** Fetch implementation (injectable for the fixture; defaults to global fetch). */
  fetchImpl?: typeof fetch;
  trace?: (line: string) => void;
}

async function downloadPhoto(url: string, dest: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return dest;
  } catch {
    return null;
  }
}

/**
 * The one entry point the worker calls. Measures the delivered file; on
 * 'absent' composites the photo in and measures AGAIN on the new file. The
 * repaired file is returned in `repairedVideoPath` so the caller delivers THAT
 * file (variants and the upload must see the same bytes that were measured).
 *
 * It never throws: an unreadable photo or a failed repair becomes a recorded
 * verdict with a reason, never a lost video.
 */
export async function ensurePhotoInDeliveredFrames(opts: EnsureOptions): Promise<PhotoInFramesResult> {
  const trace = opts.trace || (() => {});
  const workDir = path.dirname(opts.videoPath);
  let photoPath = opts.photoPath;
  if ((!photoPath || !fs.existsSync(photoPath)) && opts.photoUrl) {
    const ext = (() => {
      try { return path.extname(new URL(opts.photoUrl).pathname) || '.jpg'; } catch { return '.jpg'; }
    })();
    const downloaded = await downloadPhoto(opts.photoUrl, path.join(workDir, `source-photo${ext}`), opts.fetchImpl || fetch);
    if (downloaded) photoPath = downloaded;
  }
  const measured = measurePhotoInFrames({ ...opts, photoPath });
  trace(`photo_in_frames_measured project_delivered=${path.basename(opts.videoPath)} verdict=${measured.verdict} best=${measured.bestDistance} frames=${measured.framesChecked} scenes=[${measured.sceneNumbers.join(',')}]${measured.reason ? ` reason=${measured.reason}` : ''}`);
  if (measured.verdict !== 'absent') return measured;

  // REPAIR BEFORE REFUSAL — composite her photo in, then measure the NEW file.
  const repairedPath = opts.repairedPath || path.join(workDir, 'final_photo_repaired.mp4');
  const before = probeSeconds(opts.videoPath);
  try {
    compositePhotoIntoWindows({ videoPath: opts.videoPath, photoPath, windows: opts.windows, outPath: repairedPath });
  } catch (err: any) {
    trace(`photo_in_frames_repair_failed err=${err?.message}`);
    return { ...measured, repaired: false };
  }
  const after = probeSeconds(repairedPath);
  if (!fs.existsSync(repairedPath) || after <= 0) {
    trace('photo_in_frames_repair_failed reason=no-output-file');
    return { ...measured, repaired: false };
  }
  if (before > 0 && Math.abs(after - before) > 0.1) {
    // The repair must never change the length she chose — a repaired file of the
    // wrong length is a worse defect than the missing photo.
    trace(`photo_in_frames_repair_failed reason=duration-changed before=${before.toFixed(2)} after=${after.toFixed(2)}`);
    return { ...measured, repaired: false, reason: `${measured.reason}; the repair changed the video length (${before.toFixed(2)}s -> ${after.toFixed(2)}s) so it was not delivered` };
  }
  const recheck = measurePhotoInFrames({ ...opts, videoPath: repairedPath, photoPath });
  trace(`photo_in_frames_rechecked verdict=${recheck.verdict} best=${recheck.bestDistance} frames=${recheck.framesChecked}`);
  if (recheck.verdict === 'present') {
    return { ...recheck, repaired: true, repairedVideoPath: repairedPath };
  }
  return {
    ...measured,
    repaired: false,
    reason: `${measured.reason}; your photo was then placed into the video and still could not be found in the frames`,
  };
}
