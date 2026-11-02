/**
 * SCENE JOIN — MATCH-CUT, the PURE half (owner, Nov 2 2026).
 *
 *   "cant FFmpeg cut out ANY dip inbetween scenes? with the extra 2 seconds FFmpeg
 *    has that to work with to make it as seamless as possible even ending a scene
 *    and starting the next one with the same image. if there is a 0.4 dip FFmpeg
 *    could stitch that out couldn't it?"
 *
 * The whole join now rests on four pure functions in `sceneJoinService.ts`:
 *
 *   parseBlackDetect   — FFmpeg's blackdetect stderr → black runs
 *   edgeBlackFromRuns  — which of those runs are at a clip's EDGES (cuttable)
 *   frameDifference    — PSNR between two decoded gray frames (the join's unit)
 *   chooseMatchPair    — which frame pair to cut on, under a frame budget
 *
 * Until this file existed they were exercised ONLY by a paid Veo run ($0.60,
 * three calls), which is far too expensive and too flaky to be a regression gate.
 * These fixtures are cheap and deterministic: no ffmpeg, no network, no spend.
 *
 * The cases that matter for the real pipeline are all here: a black run that
 * covers the WHOLE clip (a broken take, not a join dip), a clip with no black at
 * all, a best pair at the very FIRST and very LAST candidate frame, ties (which
 * must keep the video's length), and the frame budget that stops the cuts from
 * eating more than the 2s of slack the 4×6s + 1×8s plan bought.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlackDetect,
  edgeBlackFromRuns,
  frameDifference,
  chooseMatchPair,
  JOIN_GOOD_PSNR,
  JOIN_VISIBLE_PSNR,
  JOIN_SEARCH_FRAMES,
  JOIN_FPS,
  BLACK_MAX_TRIM_SECONDS,
  type BlackRun,
} from '../sceneJoinService.js';

// ─── helpers ────────────────────────────────────────────────────────────────
/** A gray frame of `n` pixels all at `value` — the cheapest honest frame. */
const flat = (value: number, n = 16): Buffer => Buffer.alloc(n, value);

/** Durations are subtractions of floats (6 − 5.8), so compare with a tolerance. */
const close = (actual: number, expected: number, what = 'value'): void => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ~${expected}, got ${actual}`);
};

/** FFmpeg's real blackdetect stderr shape (a log line, then the three fields). */
const blackLine = (start: number, end: number, dur: number): string =>
  `[blackdetect @ 0x5591c0] black_start:${start} black_end:${end} black_duration:${dur}`;

// ═══ parseBlackDetect ═══════════════════════════════════════════════════════
test('blackdetect: one dip parses to one run with start/end/duration', () => {
  const runs = parseBlackDetect(blackLine(0, 0.4, 0.4));
  assert.deepEqual(runs, [{ startSec: 0, endSec: 0.4, durationSec: 0.4 }]);
});

test('blackdetect: several dips come back in TIME order even when the log is not', () => {
  // FFmpeg prints in decode order, but a filter log is not a contract — the join
  // assumes ascending runs (head = first, tail = last), so sorting is load-bearing.
  const stderr = [
    blackLine(5.6, 6, 0.4),
    blackLine(0, 0.2, 0.2),
    blackLine(2.9, 3.1, 0.2),
  ].join('\n');
  const runs = parseBlackDetect(stderr);
  assert.deepEqual(runs.map((r) => r.startSec), [0, 2.9, 5.6]);
  assert.deepEqual(runs.map((r) => r.endSec), [0.2, 3.1, 6]);
});

test('blackdetect: a run that covers the WHOLE clip still parses (it is caught later, not here)', () => {
  // parseBlackDetect must NOT silently drop this: edgeBlackFromRuns needs to see it
  // to report head=full, and detectEdgeBlack then refuses the clip as broken.
  const runs = parseBlackDetect(blackLine(0, 6, 6));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].startSec, 0);
  assert.equal(runs[0].endSec, 6);
  assert.ok(runs[0].durationSec > BLACK_MAX_TRIM_SECONDS,
    'a full-clip run is over the trim limit — the loud-failure path depends on seeing it');
});

test('blackdetect: no black at all → empty (the common, healthy case)', () => {
  const clean = [
    'frame=  180 fps=0.0 q=-0.0 size=N/A time=00:00:06.00 bitrate=N/A speed= 1x',
    'Input #0, mov,mp4,m4a, from \'clip.mp4\':',
    '  Duration: 00:00:06.00, start: 0.000000, bitrate: 1234 kb/s',
  ].join('\n');
  assert.deepEqual(parseBlackDetect(clean), []);
});

test('blackdetect: junk input never throws and never invents a run', () => {
  assert.deepEqual(parseBlackDetect(''), []);
  assert.deepEqual(parseBlackDetect(undefined as unknown as string), []);
  assert.deepEqual(parseBlackDetect(null as unknown as string), []);
  // A truncated line (black_start without end/duration) is not a run.
  assert.deepEqual(parseBlackDetect('black_start:1.0 black_end:'), []);
  assert.deepEqual(parseBlackDetect('black_start:abc black_end:2 black_duration:1'), []);
});

// ═══ edgeBlackFromRuns ══════════════════════════════════════════════════════
const run = (startSec: number, endSec: number, durationSec = endSec - startSec): BlackRun =>
  ({ startSec, endSec, durationSec });

test('edge black: a run covering the WHOLE clip is a head dip only — never double-counted as a tail', () => {
  const edge = edgeBlackFromRuns([run(0, 6)], 6);
  assert.equal(edge.headSeconds, 6, 'the clip starts black for its whole length');
  assert.equal(edge.tailSeconds, 0, 'the same run must not be charged twice');
  assert.equal(edge.runs.length, 1, 'the runs are passed through for the report');
});

test('edge black: a clip with no black at all is left completely alone', () => {
  const edge = edgeBlackFromRuns([], 6);
  assert.equal(edge.headSeconds, 0);
  assert.equal(edge.tailSeconds, 0);
  assert.deepEqual(edge.runs, []);
});

test('edge black: a head dip and a tail dip are both found', () => {
  const edge = edgeBlackFromRuns([run(0, 0.2), run(5.8, 6)], 6);
  close(edge.headSeconds, 0.2, 'head');
  close(edge.tailSeconds, 0.2, 'tail');
});

test('edge black: a black BEAT in the middle of the shot is left alone', () => {
  // A deliberately black moment in the middle is the director's picture, not a
  // join artefact — cutting it would silently delete a scene beat.
  const edge = edgeBlackFromRuns([run(2.9, 3.1)], 6);
  assert.equal(edge.headSeconds, 0);
  assert.equal(edge.tailSeconds, 0);
});

test('edge black: the 2-frame tolerance decides what counts as an edge', () => {
  const tol = 2 / JOIN_FPS; // 0.0667s at 30fps
  // Starting just inside the tolerance → still a head dip (0.5 − 0.033 = 0.467s).
  close(edgeBlackFromRuns([run(tol * 0.5, 0.5)], 6).headSeconds, 0.5 - tol * 0.5, 'head');
  // Ending just inside the tolerance → still a tail dip (0.5 − 0.033 = 0.467s).
  close(edgeBlackFromRuns([run(5.5, 6 - tol * 0.5)], 6).tailSeconds, 0.5 - tol * 0.5, 'tail');
  // Starting clearly outside it → not an edge, nothing cut.
  assert.equal(edgeBlackFromRuns([run(tol * 3, 0.5)], 6).headSeconds, 0);
  assert.equal(edgeBlackFromRuns([run(5.5, 6 - tol * 3)], 6).tailSeconds, 0);
});

test('edge black: an unmeasurable clip (0s) reports no tail rather than a negative', () => {
  const edge = edgeBlackFromRuns([run(0, 0)], 0);
  assert.equal(edge.tailSeconds, 0);
  assert.ok(edge.headSeconds >= 0 && edge.tailSeconds >= 0, 'never a negative trim');
});

// ═══ frameDifference ════════════════════════════════════════════════════════
test('frame difference: identical frames score the capped 99 dB, not Infinity', () => {
  // 99 and not Infinity on purpose: the number is persisted into project metadata
  // (JSON) and compared in the report, and Infinity does not survive either.
  const { psnr, rmse } = frameDifference(flat(120), flat(120));
  assert.equal(rmse, 0);
  assert.equal(psnr, 99);
  assert.ok(Number.isFinite(psnr), 'the value must survive JSON');
});

test('frame difference: the worst possible pair (0 vs 255) is 0 dB — a jump cut', () => {
  const { psnr, rmse } = frameDifference(flat(0), flat(255));
  assert.equal(rmse, 255);
  assert.equal(psnr, 0);
});

test('frame difference: one luma step apart is ~48 dB (a matched pair sits well above the 30 dB bar)', () => {
  const { psnr } = frameDifference(flat(100), flat(101));
  assert.ok(Math.abs(psnr - 48.13) < 0.02, `got ${psnr}`);
  assert.ok(psnr > JOIN_GOOD_PSNR);
});

test('frame difference: the good/visible bars bracket a real picture change', () => {
  // 12 luma steps apart → ~26.6 dB: the band a WEAK join lands in (a real Veo
  // naive join measured 25.93 dB). It must read as "not a match", not "a jump".
  const weak = frameDifference(flat(100), flat(112)).psnr;
  assert.ok(weak < JOIN_GOOD_PSNR, `${weak} must read as NOT a match`);
  assert.ok(weak > JOIN_VISIBLE_PSNR, `${weak} is weak, not a visible jump`);
  // 101 luma steps apart (the worst real case) is a visible cut.
  assert.ok(frameDifference(flat(139), flat(240)).psnr < JOIN_VISIBLE_PSNR);
});

test('frame difference: mismatched buffer lengths compare the common prefix and never throw', () => {
  const { rmse } = frameDifference(flat(10, 16), flat(10, 4));
  assert.equal(rmse, 0, 'the shorter buffer is the comparison length');
});

test('frame difference: an empty buffer is a total miss, not a NaN', () => {
  assert.deepEqual(frameDifference(Buffer.alloc(0), flat(9)), { psnr: 0, rmse: 255 });
});

// ═══ chooseMatchPair ════════════════════════════════════════════════════════
test('choose pair: the best pair can be at the very FIRST candidate frame of A', () => {
  // A's tail is [10, 200, 240]; B's head is [250, 10]. The naive join (A's real
  // last frame 240 vs B's real first frame 250) is only ~28 dB, but A's EARLIEST
  // searched frame (10) matches B's SECOND frame (10) exactly — so the cut has to
  // walk back 2 frames of A and 1 frame of B to land on it.
  const tail = [flat(10), flat(200), flat(240)];
  const head = [flat(250), flat(10)];
  const pair = chooseMatchPair(tail, head)!;
  assert.equal(pair.tailIndex, 0, 'the winner is the FIRST searched frame of A');
  assert.equal(pair.headIndex, 1);
  assert.equal(pair.psnr, 99);
  assert.equal(pair.aTailDropFrames, 2, 'two frames come off the end of A');
  assert.equal(pair.bHeadDropFrames, 1);
  assert.equal(pair.totalDropFrames, 3);
  assert.equal(pair.quality, 'matched');
  // The naive join it improves on is reported alongside it, for the record.
  assert.ok(Math.abs(pair.naivePsnr - frameDifference(flat(240), flat(250)).psnr) < 0.01);
  assert.ok(pair.psnr > pair.naivePsnr, 'the search must be an improvement, not a shuffle');
});

test('choose pair: the best pair can be at the very LAST candidate frame of B', () => {
  // A's tail is [10, 20, 30]; B's head is [200, 210, 30]. Only the LAST head frame
  // matches A's last tail frame — the cut takes 2 frames off B's start and none
  // off A's end.
  const tail = [flat(10), flat(20), flat(30)];
  const head = [flat(200), flat(210), flat(30)];
  const pair = chooseMatchPair(tail, head)!;
  assert.equal(pair.tailIndex, 2);
  assert.equal(pair.headIndex, 2, 'the LAST head frame is the match');
  assert.equal(pair.psnr, 99);
  assert.equal(pair.aTailDropFrames, 0);
  assert.equal(pair.bHeadDropFrames, 2);
});

test('choose pair: ties keep the video\'s length — equal PSNR prefers the SMALLEST cut', () => {
  // Every pair matches equally (a static shot), so the only sane answer is to cut
  // nothing at all: spending slack we do not need would shorten the delivered video.
  const pair = chooseMatchPair([flat(50), flat(50)], [flat(50), flat(50)])!;
  assert.equal(pair.psnr, 99);
  assert.equal(pair.totalDropFrames, 0, 'a tie must never spend frames it does not need');
  assert.equal(pair.tailIndex, 1);
  assert.equal(pair.headIndex, 0);
  // Same rule with three tail frames: still the zero-cut pair.
  const wider = chooseMatchPair([flat(50), flat(50), flat(50)], [flat(50), flat(50)])!;
  assert.equal(wider.totalDropFrames, 0);
  assert.equal(wider.tailIndex, 2);
});

test('choose pair: a tie at a NON-zero cut still prefers the cheaper of the two', () => {
  // Two frames of A both match B's first frame; neither is A's last frame, so the
  // cut cannot be zero — it must be the smaller of the two options.
  const tail = [flat(10), flat(10), flat(200)];
  const head = [flat(10)];
  const pair = chooseMatchPair(tail, head)!;
  assert.equal(pair.psnr, 99);
  assert.equal(pair.aTailDropFrames, 1, 'one frame off A (index 1), not two (index 0)');
  assert.equal(pair.bHeadDropFrames, 0);
  assert.equal(pair.totalDropFrames, 1);
});

test('choose pair: the frame budget caps the cut and falls back to a cheaper pair', () => {
  // The 3-frame winner is unaffordable; the best pair inside a 2-frame budget is
  // the uncut one. This is what stops the joins from eating the delivered length.
  const tail = [flat(10), flat(200), flat(240)];
  const head = [flat(250), flat(10)];
  const generous = chooseMatchPair(tail, head)!;
  assert.equal(generous.totalDropFrames, 3);
  const tight = chooseMatchPair(tail, head, 2)!;
  assert.equal(tight.totalDropFrames, 0, 'no cut fits the budget');
  assert.equal(tight.tailIndex, 2);
  assert.equal(tight.headIndex, 0);
  assert.ok(tight.psnr < generous.psnr, 'the budgeted answer is honestly worse');
});

test('choose pair: a zero budget means "join with no cut" rather than no join', () => {
  const pair = chooseMatchPair([flat(10), flat(240)], [flat(250), flat(10)], 0)!;
  assert.ok(pair, 'a pair is always returned when frames exist — the caller must never cut blind');
  assert.equal(pair.totalDropFrames, 0);
  assert.equal(pair.quality, 'visible', 'and it is flagged honestly');
});

test('choose pair: quality is the 30 dB bar, and a weak best pair is called visible', () => {
  const matched = chooseMatchPair([flat(100)], [flat(100)])!;
  assert.equal(matched.quality, 'matched');
  const weak = chooseMatchPair([flat(100)], [flat(200)])!;
  assert.ok(weak.psnr < JOIN_GOOD_PSNR);
  assert.equal(weak.quality, 'visible');
});

test('choose pair: no frames at either end → undefined (the caller must fail loudly, not guess)', () => {
  assert.equal(chooseMatchPair([], [flat(10)]), undefined);
  assert.equal(chooseMatchPair([flat(10)], []), undefined);
  assert.equal(chooseMatchPair([], []), undefined);
});

test('choose pair: a single frame on each side still yields a usable answer', () => {
  const pair = chooseMatchPair([flat(77)], [flat(77)])!;
  assert.equal(pair.tailIndex, 0);
  assert.equal(pair.headIndex, 0);
  assert.equal(pair.totalDropFrames, 0);
  assert.equal(pair.psnr, 99);
});

test('choose pair: the search window is the owner\'s 0.4s (12 frames at 30fps)', () => {
  assert.equal(JOIN_SEARCH_FRAMES, 12);
  assert.equal(JOIN_FPS, 30);
  assert.equal(JOIN_SEARCH_FRAMES / JOIN_FPS, 0.4);
  // The worst case a single join can remove: (N-1) tail + (N-1) head frames.
  assert.ok((2 * (JOIN_SEARCH_FRAMES - 1)) / JOIN_FPS < 0.8,
    'one join can never eat more than the 800ms the old transition used to overlap');
});
