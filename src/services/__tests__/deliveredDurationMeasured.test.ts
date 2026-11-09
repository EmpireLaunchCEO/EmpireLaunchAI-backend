/**
 * DEFECT 4 — `deliveredDurationSeconds` was arithmetic, not a measurement.
 *
 * It was written twice, both times as a PROJECTION: at creation from the planned
 * script (before a frame existed) and at completion from the DB scene rows. The final
 * file IS probed for real — `runRenderQC` probes it and yields `qc.duration`
 * (post-overlay, the exact bytes uploaded) — but that number only ever reached the
 * draft payload, never `metadata.deliveredDurationSeconds`. So the row could claim a
 * length the file did not have (a clip one frame short, or a `-t` cap biting).
 *
 * The fix: at the completion write, persist `qc.duration` — the probe of the
 * delivered artefact — and fall back to the projection ONLY when QC did not run. The
 * creation-time value is renamed `plannedDurationSeconds` so the two can never be
 * confused again.
 *
 * This fixture assembles a real file whose true length differs from the projection
 * (ffmpeg only, zero paid APIs) and asserts the persisted number tracks the FILE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDeliveredDuration, deliveredVideoDuration, type SceneScript } from '../sceneVideoPipelineService.js';
import { probeSecondsOf, JOIN_FPS } from '../sceneJoinService.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
const HAS_FFPROBE = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;
const SKIP = !HAS_FFMPEG || !HAS_FFPROBE ? 'ffmpeg/ffprobe unavailable' : false;

/** The 5-scene plan the owner's launch renders actually carried: 7,7,7,6,6 = 33s. */
const ROWS: Array<{ duration: number }> = [
  { duration: 7 }, { duration: 7 }, { duration: 7 }, { duration: 6 }, { duration: 6 },
];

test('delivered duration: a MEASURED length wins over the projection', () => {
  const projected = deliveredVideoDuration(ROWS);
  const resolved = resolveDeliveredDuration({ qcDuration: 27.31, sceneRows: ROWS });
  assert.equal(resolved.source, 'measured');
  assert.equal(resolved.seconds, 27.31);
  assert.notEqual(resolved.seconds, projected, 'a file that came out short must not be reported as the plan');
});

test('delivered duration: the projection is used ONLY when QC did not run, and says so', () => {
  const projected = deliveredVideoDuration(ROWS);
  for (const qcDuration of [undefined, null, 0, Number.NaN]) {
    const resolved = resolveDeliveredDuration({ qcDuration, sceneRows: ROWS });
    assert.equal(resolved.source, 'projected', `qcDuration=${String(qcDuration)} must fall back`);
    assert.equal(resolved.seconds, projected);
  }
});

test('delivered duration: the number persisted is within one frame of the real FILE', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivered-duration-'));
  try {
    // A real file one second SHORT of its planned window: the exact case a projection
    // cannot see (a clip came out short / a -t cap bit).
    const file = join(dir, 'delivered.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=30:duration=40',
      '-t', '27.31', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '30', file,
    ], { maxBuffer: 32 * 1024 * 1024 });

    const probed = probeSecondsOf(file);
    const projection = deliveredVideoDuration(ROWS);
    assert.ok(Math.abs(probed - projection) > 1, `the fixture must differ from the projection (file=${probed}, projection=${projection})`);

    const persisted = resolveDeliveredDuration({ qcDuration: probed, sceneRows: ROWS });
    assert.equal(persisted.source, 'measured');
    assert.ok(
      Math.abs(persisted.seconds - probed) <= 1 / JOIN_FPS,
      `metadata.deliveredDurationSeconds (${persisted.seconds}) must be within one frame of the file (${probed})`,
    );
    assert.notEqual(persisted.seconds, projection, 'and it must NOT be the projection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delivered duration: the creation-time value is a PLAN, and is named as one', () => {
  // The fixture for the rename: a planned script reports its plan, never a delivery.
  const planned: SceneScript[] = [
    { sceneNumber: 1, duration: 7, visualType: 'still', visualPrompt: 'a', narration: 'x' },
    { sceneNumber: 2, duration: 7, visualType: 'still', visualPrompt: 'b', narration: 'y' },
  ];
  assert.equal(deliveredVideoDuration(planned), 13.2, 'creation-time arithmetic is the plan (14s − 0.8s dissolve)');
});
