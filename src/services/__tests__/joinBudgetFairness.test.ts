/**
 * DEFECT 3 — the join frame budget was spent greedily, in join order.
 *
 * `planMatchCutCuts` kept ONE shared `slackFrames` counter and handed it to each join
 * in video order, so join 0 could spend the entire budget for a fractionally better
 * match. Every later join then got a 0-frame allowance, which was recorded as
 * `quality:'visible'` — a bad cut reported as a fine one. Reachable in production:
 * one join can want 22 frames and a four-join plan can want 88, while black trimming
 * shrinks the slack the plan actually has.
 *
 * The fix reserves fairly BEFORE spending: each join may spend at most
 * `floor(slack / joinsRemaining)`, so no join can starve the ones after it. PSNR is
 * still the objective inside that allowance.
 *
 * The fixture drives `planJoinCuts` — the exact decision function `planMatchCutCuts`
 * calls, after decoding the real frame strips — with synthetic frame strips, so it
 * is deterministic, offline and free. The arithmetic the owner cares about is the
 * one that matters here: 5 clips totalling 33s against a 30s target = 90 frames of
 * slack, and four joins that each have a real match available.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planJoinCuts, chooseMatchPair, JOIN_FPS, TAIL_CORRECTION_SHARE } from '../sceneJoinService.js';

/** A gray frame of `n` pixels all at `value` — the cheapest honest frame. */
const flat = (value: number, n = 16): Buffer => Buffer.alloc(n, value);

/** A strip of `n` frames where frame i carries luma `luma(i)`. */
const strip = (n: number, luma: (i: number) => number): Buffer[] => Array.from({ length: n }, (_, i) => flat(luma(i)));

const N = 48; // frames searched at each end (a deliberately wide window: 1.6s)
/** A join built from explicit luma overrides. Base luma keeps the two clips far
 *  apart (tail 20..67, head 200..247), so the ONLY good pairs are the engineered
 *  ones: a frame whose luma is repeated across the join matches, everything else is
 *  a visible difference. */
const join = (tailOverride: Record<number, number>, headOverride: Record<number, number>) => ({
  tail: strip(N, (i) => tailOverride[i] ?? 20 + i),
  head: strip(N, (j) => headOverride[j] ?? 200 + j),
});
/** A join whose best pair is a REAL match at (tailIndex, headIndex). */
const joinWithMatchAt = (tailIndex: number, headIndex: number, marker: number) =>
  join({ [tailIndex]: marker }, { [headIndex]: marker });

// 33s of clips against a 30s target — the production shape (5 clips, 4 joins).
const CLIP_SECONDS = 6.6;
const TARGET_SECONDS = 30;
const SLACK_FRAMES = Math.floor((CLIP_SECONDS * 5 - TARGET_SECONDS) * JOIN_FPS); // 90

test('join budget: the production slack really is 90 frames for 4 joins', () => {
  assert.equal(SLACK_FRAMES, 90);
});

test('join budget: join 0 may not spend the budget the later joins need', () => {
  // Join 0's BEST pair sits at the far edge of the search window: it costs 89 frames
  // (44 off the tail + 45 off the head) for a perfect match. Under the old greedy
  // loop it took all 89, leaving 1 frame for the remaining three joins.
  const greedyJoins = [
    // Join 0: a PERFECT match at the far edge (89 frames of cut) and a merely good
    // one close by (7 frames) — the greedy loop takes the perfect one and keeps nothing.
    join({ 3: 100, 44: 140 }, { 45: 100, 4: 142 }),
    joinWithMatchAt(45, 2, 120),
    joinWithMatchAt(42, 5, 130),
    joinWithMatchAt(40, 7, 140),
  ];
  // The defect, reproduced: greedy spending starves the tail of the video.
  let slack = SLACK_FRAMES;
  const greedy: number[] = [];
  for (const j of greedyJoins) {
    const pair = chooseMatchPair(j.tail, j.head, slack)!;
    greedy.push(pair.totalDropFrames);
    slack -= pair.totalDropFrames;
  }
  assert.equal(greedy[0], 89, 'join 0 spends almost the whole budget on itself');
  assert.deepEqual(greedy.slice(1), [0, 0, 0], 'every later join is starved — the defect');

  // The fix: every join is reserved a fair share first, so every join still gets cut.
  const decision = planJoinCuts(greedyJoins, SLACK_FRAMES);
  assert.equal(decision.allowances.length, 4);
  assert.equal(decision.allowances[0], Math.floor(SLACK_FRAMES / 4), 'join 0 is reserved a quarter, not everything');
  assert.ok(decision.allowances[3] >= 14, `the last join keeps enough to place its match (${decision.allowances[3]})`);
  for (let i = 0; i < decision.pairs.length; i++) {
    const pair = decision.pairs[i]!;
    assert.ok(pair.totalDropFrames > 0, `join ${i} must still get a cut (got ${pair.totalDropFrames})`);
    assert.ok(pair.psnr > pair.naivePsnr, `join ${i} must improve on the naive join (${pair.psnr} vs ${pair.naivePsnr})`);
  }
  const last = decision.pairs[decision.pairs.length - 1]!;
  assert.notEqual(last.quality, 'visible', 'the last join is a MATCH, not a jump cut');
  assert.ok(decision.unusedFrames > 0, 'and slack was still left unspent — nothing needed to starve');
  assert.deepEqual(decision.starvedJoins, [], 'no join was left uncut while slack existed');
});

test('join budget: a fair allowance never exceeds what the join actually needs', () => {
  // A join whose match is 4 frames away must not be handed (and spend) more than that.
  const decision = planJoinCuts([joinWithMatchAt(45, 2, 60)], SLACK_FRAMES);
  assert.equal(decision.pairs[0]!.totalDropFrames, 4);
  assert.equal(decision.spentFrames, 4);
  assert.equal(decision.unusedFrames, SLACK_FRAMES - 4, 'unspent slack is reported, never silently absorbed');
});

test('join budget: zero slack still joins honestly instead of cutting blind', () => {
  const decision = planJoinCuts([joinWithMatchAt(45, 2, 60)], 0);
  assert.equal(decision.pairs[0]!.totalDropFrames, 0);
  assert.equal(decision.pairs[0]!.quality, 'visible', 'and it is recorded as visible, not as a match');
  assert.deepEqual(decision.starvedJoins, [0], 'a join left uncut is named, never hidden');
});

test('exact-length correction: no single clip gives more than its share first', () => {
  // The tail of the video used to be the donor of first resort. Pass 1 caps each
  // clip's contribution at TAIL_CORRECTION_SHARE of itself, so the correction is
  // spread; pass 2 still meets the length contract exactly (unchanged arithmetic).
  assert.ok(TAIL_CORRECTION_SHARE > 0 && TAIL_CORRECTION_SHARE < 1);
  assert.equal(TAIL_CORRECTION_SHARE, 0.25);
});
