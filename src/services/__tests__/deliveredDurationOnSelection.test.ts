/**
 * THE DELIVERED FILE LANDS ON THE LENGTH SHE PICKED (owner, 23 Nov).
 *
 * "the clients only have the voice and video length options we give them to select
 *  from. so it should aim to get it on the dot or within a second or 2 from that
 *  selection."
 *
 * The 30s band (29.5–30.5) was the only length anything was held to, and only in
 * fixtures. A 10s or 15s video was whatever the plan plus the measured narration
 * added up to: the narration-overrun growth passes widen scene windows so no spoken
 * word is cut (right), which made the VIDEO longer than the selection (wrong), and
 * the persisted length was arithmetic on the plan rather than a measurement of the
 * file.
 *
 * So: the band is now a function of the SELECTION and identical for every length the
 * product offers; the finished file is probed and, when it is out of band, FITTED
 * (picture via setpts, narration via atempo — nothing cut, nothing frozen) before the
 * QC probe, the variant export and the R2 upload, so the number the row carries and
 * the bytes the client downloads are the same artefact.
 *
 * $0 fixtures: pure arithmetic plus real ffmpeg on synthetic clips. No paid calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deliveredDurationBand,
  deliveredDurationInBand,
  planDeliveredDurationFit,
  fitDeliveredFileToSelection,
  fitClipToDuration,
  probeDuration,
  DELIVERED_DURATION_TOLERANCE_SECONDS,
} from '../sceneVideoPipelineService.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
const HAS_FFPROBE = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;
const SKIP = !HAS_FFMPEG || !HAS_FFPROBE ? 'ffmpeg/ffprobe unavailable' : false;

function workDir(): string {
  return mkdtempSync(join(tmpdir(), 'duration-band-'));
}
/** A finished video of `seconds`, with narration audio (testsrc2 + sine). */
function makeFile(file: string, seconds: number, withAudio = true): void {
  const args = ['-y', '-f', 'lavfi', '-i', `testsrc2=size=320x568:rate=30:duration=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac');
  args.push(file);
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
}
function hasAudio(file: string): boolean {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file,
  ]).toString().trim();
  return out.length > 0;
}
/** Seconds of BLACK the decoded file actually contains (0 = no black frame). */
function blackSeconds(file: string): number {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.04:pix_th=0.10', '-f', 'null', '-'], { encoding: 'utf8' });
  const stderr = String(res.stderr || '');
  let total = 0;
  for (const m of stderr.matchAll(/black_duration:\s*([0-9.]+)/g)) total += Number(m[1]);
  return Math.round(total * 100) / 100;
}
/** One decoded greyscale frame at `seconds`. */
function frameAt(file: string, seconds: number): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 16 * 1024 * 1024 });
}

test('the band is the SAME standard for every length the product offers (10s / 15s / 30s)', () => {
  assert.equal(DELIVERED_DURATION_TOLERANCE_SECONDS, 0.5);
  assert.deepEqual(deliveredDurationBand(10), { min: 9.5, max: 10.5 });
  assert.deepEqual(deliveredDurationBand(15), { min: 14.5, max: 15.5 });
  // The 30s band that already existed, unchanged by this work.
  assert.deepEqual(deliveredDurationBand(30), { min: 29.5, max: 30.5 });
  // On the dot, inside the band, outside it — for a 10s pick.
  assert.equal(deliveredDurationInBand(10.0, 10), true);
  assert.equal(deliveredDurationInBand(10.4, 10), true);
  assert.equal(deliveredDurationInBand(11.4, 10), false, 'a 10s pick delivered as 11.4s is not in band');
  assert.equal(deliveredDurationInBand(8.9, 10), false);
  // An unmeasurable file is never "in band" (never a silent pass).
  assert.equal(deliveredDurationInBand(0, 10), false);
  assert.equal(deliveredDurationInBand(NaN, 10), false);
});

test('an out-of-band finished file gets a retime plan; an absurd one is declined, not hidden', () => {
  // A 10s pick delivered as 11.4s (a narration overrun): compress to 10s.
  const overrun = planDeliveredDurationFit({ measuredSeconds: 11.4, selectedSeconds: 10 });
  assert.equal(overrun.needed, true);
  assert.equal(overrun.strategy, 'retime');
  assert.equal(overrun.reason, 'overrun-compressed');
  assert.ok(Math.abs(overrun.factor - 10 / 11.4) < 1e-3, `factor ${overrun.factor} must be selected/measured`);

  // A 15s pick delivered as 13.6s: stretch to 15s.
  const underrun = planDeliveredDurationFit({ measuredSeconds: 13.6, selectedSeconds: 15 });
  assert.equal(underrun.strategy, 'retime');
  assert.equal(underrun.reason, 'underrun-stretched');
  assert.ok(underrun.factor > 1);

  // Already on the selection: nothing to do.
  const fine = planDeliveredDurationFit({ measuredSeconds: 15.2, selectedSeconds: 15 });
  assert.equal(fine.needed, false);
  assert.equal(fine.reason, 'in-band');

  // A 10s pick delivered as 25s is a PLANNING defect — playing the shot at 2.5x would
  // be a lie, so the fit declines and the honest number is what gets recorded.
  const absurd = planDeliveredDurationFit({ measuredSeconds: 25, selectedSeconds: 10 });
  assert.equal(absurd.needed, true);
  assert.equal(absurd.strategy, 'none');
  assert.equal(absurd.reason, 'outside-repairable-range');
});

test('a 10s pick whose file came out 11.4s is FITTED: the delivered file probes in band (real ffmpeg)', { skip: SKIP }, async () => {
  const dir = workDir();
  try {
    const file = join(dir, 'final.mp4');
    makeFile(file, 11.4);
    assert.ok(Math.abs(probeDuration(file) - 11.4) < 0.1, 'fixture must start out of band');

    const fit = await fitDeliveredFileToSelection(file, 10);
    assert.equal(fit.applied, true, 'an out-of-band file must be fitted, not shipped');
    assert.ok(Math.abs(fit.before - 11.4) < 0.1);
    assert.ok(fit.inBand, `fitted file must land in band (got ${fit.after})`);

    // MEASURED ON THE FINISHED FILE, not on the plan.
    const measured = probeDuration(file);
    assert.ok(deliveredDurationInBand(measured, 10), `delivered file ${measured}s is not inside 9.5–10.5`);
    // The narration is compressed, never dropped, and the picture never goes black.
    assert.equal(hasAudio(file), true, 'the narration must still be there after the fit');
    assert.equal(blackSeconds(file), 0, 'a fit must never introduce a black frame');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a narration overrun does NOT extend the video: a 15s pick delivered as 18.2s lands on 15s', { skip: SKIP }, async () => {
  const dir = workDir();
  try {
    const file = join(dir, 'final.mp4');
    // 18.2s = the shape of render #8: the measured narration grew the scene windows
    // past the selection. The grown windows stay (no word is cut) — the FILE is fitted.
    makeFile(file, 18.2);
    const fit = await fitDeliveredFileToSelection(file, 15);
    assert.equal(fit.applied, true);
    const measured = probeDuration(file);
    assert.ok(deliveredDurationInBand(measured, 15), `delivered ${measured}s outside 14.5–15.5`);
    assert.ok(Math.abs(measured - 18.2) > 2, 'the delivered file must not keep the overrun length');
    assert.equal(blackSeconds(file), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a short motion take is REPAIRED over its window (FFmpeg), never refused: 5.5s take in a 6s window', { skip: SKIP }, async () => {
  const dir = workDir();
  try {
    const clip = join(dir, 'take.mp4');
    makeFile(clip, 5.5, false); // the take came back 0.5s short of its 6s window
    const before = probeDuration(clip);
    assert.ok(Math.abs(before - 5.5) < 0.1);

    await fitClipToDuration(clip, 6);
    const after = probeDuration(clip);
    assert.ok(Math.abs(after - 6) < 0.06, `take must fill its window exactly (got ${after}s)`);

    // The gap is covered by the PICTURE THAT WAS BOUGHT: the motion continues through
    // the repaired tail (the shot is retimed, not frozen and not black).
    assert.equal(blackSeconds(clip), 0, 'a repaired take must never end in black');
    const late = frameAt(clip, 5.2);
    const last = frameAt(clip, 5.9);
    assert.notDeepEqual(late, last, 'the tail of a repaired take must still be MOVING, not a frozen frame');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fit runs on the FINISHED file, before the probe, the variants and the upload', () => {
  const src = readFileSync(new URL('../sceneVideoPipelineService.ts', import.meta.url), 'utf8');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `pipeline must call ${needle}`);
    return i;
  };
  const fit = at('fitDeliveredFileToSelection(assembled, selectedDurationSeconds)');
  const qc = at('runRenderQC(assembled');
  const variants = at('generateVideoExportVariants(assembled');
  const upload = at('r2Storage.uploadLocalFile(assembled');
  assert.ok(fit < qc, 'the fit must run BEFORE QC probes the file (so deliveredDurationSeconds measures the fitted bytes)');
  assert.ok(fit < variants, 'the fit must run before the variant export reads the master');
  assert.ok(fit < upload, 'the fit must run before the upload — the client must download the fitted file');

  // The length she picked is persisted at creation and read back by the worker.
  assert.ok(/selectedDurationSeconds: duration,/.test(src), 'createProject must persist the SELECTED length');
  assert.ok(/const selectedDurationSeconds = /.test(src), 'the worker must read the selected length');
  // The row carries the measured length, its source, and the band it was held to.
  assert.ok(/deliveredDurationSource: delivered\.source,/.test(src));
  assert.ok(/deliveredDurationBand: \{/.test(src));
  assert.ok(/narrationOverrunFitted/.test(src), 'a narration overrun must be recorded as fitted, not as a longer video');
});
