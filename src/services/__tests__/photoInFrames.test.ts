/**
 * IS HER PHOTO ACTUALLY IN THE FINISHED FRAMES? (roadmap 78) — $0, real ffmpeg.
 *
 * `sourceImagePlacement` was written from the PLAN, so a video that never
 * composited her photo still claimed it was placed. This fixture makes the
 * measurement real, and — the point of the whole file — it contains a
 * NEGATIVE CONTROL: a real render where the photo was never composited must
 * come back `absent`. A check that cannot fail proves nothing (plan rule 20).
 *
 *   • NEGATIVE CONTROL: video built from a DIFFERENT picture than the photo,
 *     nothing composited ⇒ verdict 'absent', no matched frame.
 *   • POSITIVE CONTROL: the same photo composited into the same video ⇒
 *     verdict 'present' with a matched frame.
 *   • REPAIR: `ensurePhotoInDeliveredFrames` on the un-composited file
 *     composites the photo in itself, re-measures the NEW file, and reports
 *     `repaired: true` — without changing the video's length.
 *   • HONESTY: an unreadable photo or an unassigned photo is
 *     'not-pixel-provable' with a reason, never a pass.
 *
 * Zero paid calls: ffmpeg on synthetic frames only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PHOTO_MATCH_MAX_HAMMING,
  PHOTO_MATCH_MIN_CORRELATION,
  bestPhotoFrameMatch,
  centerCropGrid,
  compareGrids,
  compositePhotoIntoWindows,
  dhashFromGrid,
  ensurePhotoInDeliveredFrames,
  gridCorrelation,
  hammingDistance,
  measurePhotoInFrames,
  overlayEnableExpression,
  probeSeconds,
  type GrayImage,
} from '../photoInFrames.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0
  && spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;
const SKIP = HAS_FFMPEG ? false : 'ffmpeg/ffprobe unavailable';

/* ───────────────────────── pure logic (no ffmpeg) ───────────────────────── */

/** A 100x100 image: mid grey everywhere except a bright square in the centre. */
function centreBlockImage(): GrayImage {
  const width = 100;
  const height = 100;
  const data = new Uint8Array(width * height).fill(60);
  for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) data[y * width + x] = 230;
  return { width, height, data };
}

/** A deterministic non-flat grid, so a comparison has something to compare. */
function rampGrid(): { values: number[]; width: number; height: number } {
  const values: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) values.push(((x * 37 + y * 11) % 200) + 20);
  return { width: 9, height: 8, values };
}

test('pure: the same grid is a perfect match — dHash 0, correlation 1', () => {
  const a = rampGrid();
  const cmp = compareGrids(a, a);
  assert.equal(cmp.hamming, 0);
  assert.equal(Number(cmp.correlation.toFixed(6)), 1);
  assert.equal(cmp.match, true);
});

test('pure: a flat grid carries no structure and can NEVER match', () => {
  const flat = { width: 9, height: 8, values: new Array(72).fill(128) };
  const other = rampGrid();
  // Same dHash (all-zero bits) — but correlation 0, so the joint gate refuses it.
  assert.equal(hammingDistance(dhashFromGrid(flat), dhashFromGrid(flat)), 0);
  assert.equal(gridCorrelation(flat, other), 0);
  assert.equal(compareGrids(flat, other).match, false);
});

test('pure: an unrelated structure fails both halves of the gate', () => {
  const a = rampGrid();
  const b = { ...rampGrid(), values: rampGrid().values.slice().reverse() };
  const cmp = compareGrids(a, b);
  assert.ok(cmp.hamming > PHOTO_MATCH_MAX_HAMMING, `expected a large Hamming distance, got ${cmp.hamming}`);
  assert.ok(cmp.correlation < PHOTO_MATCH_MIN_CORRELATION, `expected a low correlation, got ${cmp.correlation}`);
  assert.equal(cmp.match, false);
});

test('pure: the centre crop is really the centre (zoom ladder reads the middle)', () => {
  const img = centreBlockImage();
  const whole = centerCropGrid(img, 1);
  const centre = centerCropGrid(img, 0.2);
  const mean = (g: { values: number[] }) => g.values.reduce((s, v) => s + v, 0) / g.values.length;
  assert.ok(mean(centre) > mean(whole) * 2, 'the tight centre crop must be dominated by the bright centre block');
});

test('pure: a best match reports the frame it was found on', () => {
  const photo: GrayImage = { width: 90, height: 80, data: new Uint8Array(90 * 80) };
  for (let y = 0; y < 80; y++) for (let x = 0; x < 90; x++) photo.data[y * 90 + x] = (x * 3 + y * 7) % 256;
  const blank: GrayImage = { width: 90, height: 80, data: new Uint8Array(90 * 80).fill(40) };
  const match = bestPhotoFrameMatch(photo, [blank, photo]);
  assert.equal(match.match, true);
  assert.equal(match.frameIndex, 1, 'the frame that IS the photo must be the one reported');
});

test('pure: the overlay window expression is a union of between() clauses', () => {
  const expr = overlayEnableExpression([
    { sceneNumber: 1, startSec: 0, endSec: 4 },
    { sceneNumber: 3, startSec: 8, endSec: 12.5 },
  ]);
  assert.equal(expr, 'between(t,0.000,4.000)+between(t,8.000,12.500)');
  assert.equal(overlayEnableExpression([]), '0');
});

/* ─────────────────── real ffmpeg: the two controls ─────────────────── */

const DIR = mkdtempSync(join(tmpdir(), 'photo-in-frames-'));
const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { maxBuffer: 1 << 28 });

/** Her uploaded photo: one frame of the testsrc2 pattern. */
const PHOTO = join(DIR, 'uploaded-photo.png');
/** The delivered video: a DIFFERENT picture — the photo was never composited. */
const RENDER_WITHOUT_PHOTO = join(DIR, 'delivered-without-photo.mp4');
const WINDOW = [{ sceneNumber: 1, startSec: 0.5, endSec: 5.5 }];

function buildFixtures(): void {
  if (!HAS_FFMPEG || existsSync(RENDER_WITHOUT_PHOTO)) return;
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=512x512:rate=1:duration=1', '-frames:v', '1', PHOTO]);
  ff([
    '-f', 'lavfi', '-i', 'smptehdbars=size=540x960:rate=30:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '6', RENDER_WITHOUT_PHOTO,
  ]);
}

test('NEGATIVE CONTROL: a render that never composited the photo comes back absent', { skip: SKIP }, () => {
  buildFixtures();
  const result = measurePhotoInFrames({ videoPath: RENDER_WITHOUT_PHOTO, photoPath: PHOTO, windows: WINDOW });
  assert.equal(result.verdict, 'absent', 'a check that cannot fail proves nothing — this one MUST fail here');
  assert.equal(result.matchedFrame, null);
  assert.equal(result.repaired, false);
  assert.ok(result.framesChecked >= 3, `expected several frames checked, got ${result.framesChecked}`);
  assert.ok(result.bestDistance !== null && result.bestDistance > PHOTO_MATCH_MAX_HAMMING,
    `the closest frame must be further than the gate, got ${result.bestDistance}`);
  assert.ok(result.reason && /not the uploaded photo/.test(result.reason), 'an absent verdict must say why');
});

test('POSITIVE CONTROL: the same photo composited into the same render comes back present', { skip: SKIP }, () => {
  buildFixtures();
  const composited = join(DIR, 'delivered-with-photo.mp4');
  compositePhotoIntoWindows({ videoPath: RENDER_WITHOUT_PHOTO, photoPath: PHOTO, windows: WINDOW, outPath: composited });
  const result = measurePhotoInFrames({ videoPath: composited, photoPath: PHOTO, windows: WINDOW });
  assert.equal(result.verdict, 'present');
  assert.equal(result.repaired, false, 'this file was measured as delivered — the repair is not what made it present');
  assert.ok(result.matchedFrame, 'a present verdict must name the frame it was found on');
  assert.equal(result.matchedFrame!.sceneNumber, 1);
  assert.ok(result.bestDistance !== null && result.bestDistance <= PHOTO_MATCH_MAX_HAMMING);
});

test('REPAIR: an absent photo is composited in, re-measured, and reported as repaired', { skip: SKIP }, async () => {
  buildFixtures();
  const before = probeSeconds(RENDER_WITHOUT_PHOTO);
  const result = await ensurePhotoInDeliveredFrames({
    videoPath: RENDER_WITHOUT_PHOTO,
    photoPath: PHOTO,
    windows: WINDOW,
    repairedPath: join(DIR, 'final_photo_repaired.mp4'),
  });
  assert.equal(result.verdict, 'present');
  assert.equal(result.repaired, true);
  assert.ok(result.repairedVideoPath && existsSync(result.repairedVideoPath), 'the repaired file must be the one to deliver');
  const after = probeSeconds(result.repairedVideoPath!);
  assert.ok(Math.abs(after - before) <= 0.1, `the repair must not change her chosen length (${before.toFixed(2)}s -> ${after.toFixed(2)}s)`);
  // …and the delivered (repaired) file is what a second, independent check sees.
  const recheck = measurePhotoInFrames({ videoPath: result.repairedVideoPath!, photoPath: PHOTO, windows: WINDOW });
  assert.equal(recheck.verdict, 'present');
});

test('HONESTY: no measurement is claimed when the photo cannot be read', { skip: SKIP }, () => {
  buildFixtures();
  const result = measurePhotoInFrames({
    videoPath: RENDER_WITHOUT_PHOTO,
    photoPath: join(DIR, 'missing-photo.png'),
    windows: WINDOW,
  });
  assert.equal(result.verdict, 'not-pixel-provable', 'not-pixel-provable is a real verdict, never a pass');
  assert.equal(result.bestDistance, null);
  assert.equal(result.framesChecked, 0);
  assert.ok(result.reason && /could not be read/.test(result.reason));
});

test('HONESTY: a photo assigned to no scene is not claimed in the frames', { skip: SKIP }, () => {
  buildFixtures();
  const result = measurePhotoInFrames({ videoPath: RENDER_WITHOUT_PHOTO, photoPath: PHOTO, windows: [] });
  assert.equal(result.verdict, 'not-pixel-provable');
  assert.ok(result.reason && /not assigned to any scene/.test(result.reason));
});

test('HONESTY: a repair that cannot prove the photo never claims one', { skip: SKIP }, async () => {
  buildFixtures();
  // A "photo" that decodes to a flat black image can never be found in frames —
  // the repair runs, re-measures, still cannot prove it, and says so.
  const flat = join(DIR, 'flat-photo.png');
  writeFileSync(flat, execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:size=256x256',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { maxBuffer: 1 << 26 }));
  const result = await ensurePhotoInDeliveredFrames({
    videoPath: RENDER_WITHOUT_PHOTO,
    photoPath: flat,
    windows: WINDOW,
    repairedPath: join(DIR, 'flat-repaired.mp4'),
  });
  assert.notEqual(result.verdict, 'present', 'a flat picture must never be reported as visible in the video');
  assert.equal(result.repaired, false);
  assert.ok(result.reason && /could not be found in the frames/.test(result.reason), 'the reason must say the repair was tried and failed');
});

test('cleanup', { skip: SKIP }, () => {
  rmSync(DIR, { recursive: true, force: true });
});
