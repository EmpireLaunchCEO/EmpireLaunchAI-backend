/**
 * ASSEMBLY OVERLAY HELPERS (RENDER #7 PREP — owner ADJUST #2: bullets on screen +
 * EmpireLaunchAI.com at the bottom). Pure determinants, no ffmpeg, no DB:
 *   - resolveSceneVideoStarts: dissolve-compensated scene starts (same math as
 *     concatClips so bullet windows align with the delivered picture),
 *   - escapeDrawtext: user-visible text safe inside an ffmpeg drawtext value,
 *   - normalizeAssemblyOverlays: untrusted metadata → clean spec (or null).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSceneVideoStarts, escapeDrawtext, normalizeAssemblyOverlays, resolveOverlayFont, normalizeBottomBarBlink, resolveBottomBarBlinkWindows, buildBottomBarEnableExpression, type BottomBarBlink } from '../assemblyOverlays.js';

test('resolveSceneVideoStarts: dissolve-compensated starts', () => {
  assert.deepEqual(resolveSceneVideoStarts([6, 5, 4], 0.8), [0, 5.2, 9.4]);
  assert.deepEqual(resolveSceneVideoStarts([6], 0.8), [0]);
  assert.deepEqual(resolveSceneVideoStarts([2, 2], 1.0), [0, 1]);
  // transition larger than a scene never yields negative starts
  const starts = resolveSceneVideoStarts([0.5, 4], 0.8);
  assert.ok(starts[0] === 0 && starts[1] >= 0);
});

test('escapeDrawtext: user text is safe in a drawtext value', () => {
  assert.equal(escapeDrawtext('Go to EmpireLaunchAI.com to get started today!!'), 'Go to EmpireLaunchAI.com to get started today!!');
  assert.equal(escapeDrawtext('a:b,c[d]%e\\f'), 'a\\:b\\,c\\[d\\]%%e\\\\f');
  assert.equal(escapeDrawtext("it's 100% real — don't"), "it\\'s 100%% real — don\\'t");
  assert.equal(escapeDrawtext(''), '');
});

test('normalizeAssemblyOverlays: clean spec / malformed dropped / null when empty', () => {
  // 5-scene launch metadata (owner's 8 lines grouped per F4 scene mapping)
  const spec = normalizeAssemblyOverlays(
    {
      perScene: [
        { lines: ['Introducing EmpireLaunch AI.', 'Your new go to platform.'] },
        { lines: ['You get 76 videos a month.', 'And you don\u2019t pay for credits.'] },
        { lines: [''] },
        { lines: [], },
        { lines: ['Go to EmpireLaunchAI.com to get started today!!'] },
      ],
      bottomBar: 'EmpireLaunchAI.com',
    },
    5,
  );
  assert.ok(spec, 'spec present');
  assert.equal(spec?.perScene?.length, 3, 'empty/malformed groups dropped');
  assert.equal(spec?.perScene?.[0]?.lines?.length, 2);
  assert.equal(spec?.bottomBar, 'EmpireLaunchAI.com');

  // absent / empty → null (today's pixel-exact output, zero re-encode)
  assert.equal(normalizeAssemblyOverlays(undefined, 5), null);
  assert.equal(normalizeAssemblyOverlays(null, 5), null);
  assert.equal(normalizeAssemblyOverlays({ perScene: [{ lines: [] }] }, 5), null);
  assert.equal(normalizeAssemblyOverlays({ bottomBar: '   ' }, 5), null);

  // over-long perScene trimmed to scene count
  const trimmed = normalizeAssemblyOverlays(
    { perScene: [{ lines: ['a'] }, { lines: ['b'] }], bottomBar: 'x' },
    1,
  );
  assert.equal(trimmed?.perScene?.length, 1, 'perScene trimmed to sceneCount');
});

test('resolveOverlayFont: a drawtext-usable font resolves on this runtime', () => {
  const f = resolveOverlayFont();
  assert.ok(f.length > 0);
});
/* ── BLINKING BOTTOM BAR (OWNER, Nov 2 — her launch video) ──────────────────
 * "EmpireLaunchAI.com" burned into the whole video at 0.5s on / 0.4s off.
 * The tests below EVALUATE the generated `enable=` expression (parse each
 * between() clause, then evaluate it at times) — they never pattern-match the
 * string, so a wrong cadence cannot pass by looking right.
 */

/** Parse a generated `enable='between(t,a,b)+…'` into ON intervals and evaluate
 *  it the way ffmpeg does (between() is INCLUSIVE on both ends; `+` = OR). */
function parseEnableWindows(enable: string): Array<[number, number]> {
  const m = /^enable='(.+)'$/.exec(enable);
  assert.ok(m, `a single quoted filter option: ${enable}`);
  const clauses = m![1].split('+');
  return clauses.map((clause) => {
    const b = /^between\(t,(-?[\d.]+),(-?[\d.]+)\)$/.exec(clause);
    assert.ok(b, `every clause is between(t,a,b): ${clause}`);
    return [Number(b![1]), Number(b![2])] as [number, number];
  });
}
function isOn(windows: Array<[number, number]>, t: number): boolean {
  return windows.some(([a, b]) => t >= a && t <= b);
}
/** Contiguous ON runs (seconds) sampled from the expression at 1ms resolution. */
function sampleOnRuns(windows: Array<[number, number]>, total: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let open: number | null = null;
  for (let ms = 0; ms <= Math.round(total * 1000); ms++) {
    const on = isOn(windows, ms / 1000);
    if (on && open === null) open = ms / 1000;
    if (!on && open !== null) { runs.push([open, (ms - 1) / 1000]); open = null; }
  }
  if (open !== null) runs.push([open, total]);
  return runs;
}

test('normalizeBottomBarBlink: the owner cadence is accepted, garbage falls back to persistent', () => {
  assert.deepEqual(normalizeBottomBarBlink({ onSeconds: 0.5, offSeconds: 0.4 }), { onSeconds: 0.5, offSeconds: 0.4 });
  assert.deepEqual(normalizeBottomBarBlink({ onSeconds: '0.5', offSeconds: '0.4' }), { onSeconds: 0.5, offSeconds: 0.4 });
  // malformed / absent / contradictory ⇒ null ⇒ the persistent bar (today's output)
  assert.equal(normalizeBottomBarBlink(undefined), null);
  assert.equal(normalizeBottomBarBlink(null), null);
  assert.equal(normalizeBottomBarBlink({}), null);
  assert.equal(normalizeBottomBarBlink({ onSeconds: 0.5 }), null, 'offSeconds required');
  assert.equal(normalizeBottomBarBlink({ onSeconds: 0, offSeconds: 0.4 }), null, '"never visible" is not a bar');
  assert.equal(normalizeBottomBarBlink({ onSeconds: -1, offSeconds: 0.4 }), null);
  assert.equal(normalizeBottomBarBlink({ onSeconds: 0.5, offSeconds: -0.4 }), null);
  assert.equal(normalizeBottomBarBlink('0.5/0.4'), null);
  // clamps keep a render alive on absurd input
  assert.deepEqual(normalizeBottomBarBlink({ onSeconds: 99, offSeconds: 99 }), { onSeconds: 10, offSeconds: 10 });
  assert.deepEqual(normalizeBottomBarBlink({ onSeconds: 0.001, offSeconds: 0.4 }), { onSeconds: 0.05, offSeconds: 0.4 });
});

test('bottom bar blink: the generated enable= expression is genuinely periodic at 0.5s on / 0.4s off', () => {
  const total = 30;
  const blink: BottomBarBlink = { onSeconds: 0.5, offSeconds: 0.4 };
  const windows = parseEnableWindows(buildBottomBarEnableExpression(total, blink));
  assert.ok(windows.length >= 33, `a 30s video carries the bar ~33 times (got ${windows.length} ON windows)`);

  // first ON window starts at t=0 → the bar is on the FIRST frame
  assert.equal(windows[0][0], 0);
  assert.ok(isOn(windows, 0), 'bar present on the first frame');

  // EVERY ON window (except the corrected tail) starts exactly one 0.9s cycle
  // after the previous one — the cadence, measured on the expression itself.
  const period = blink.onSeconds + blink.offSeconds;
  for (let i = 1; i <= windows.length - 2; i++) {
    const delta = windows[i][0] - windows[i - 1][0];
    assert.ok(Math.abs(delta - period) < 1e-6, `ON window ${i} starts ${delta}s after the previous (want ${period}s)`);
  }
  // each periodic ON window is exactly 0.5s long, and every OFF gap in the body
  // of the video is exactly 0.4s (only the FINAL gap may be shorter, because the
  // last ON window is stretched back so the bar is on the final frame)
  for (let i = 0; i < windows.length - 1; i++) {
    assert.ok(Math.abs(windows[i][1] - windows[i][0] - blink.onSeconds) < 1e-6, `ON window ${i} is 0.5s`);
  }
  assert.ok(Math.abs(windows[windows.length - 1][1] - windows[windows.length - 1][0] - blink.onSeconds) < 1e-6, 'the FINAL ON window is a full 0.5s');
  for (let i = 0; i < windows.length - 2; i++) {
    const gap = windows[i + 1][0] - windows[i][1];
    assert.ok(Math.abs(gap - blink.offSeconds) < 1e-6, `OFF gap ${i} is 0.4s (got ${gap}s)`);
  }
  const tailGap = windows[windows.length - 1][0] - windows[windows.length - 2][1];
  assert.ok(tailGap > -1e-9 && tailGap <= period + 1e-9, `the final OFF gap is short, never negative (got ${tailGap}s)`);

  // SAMPLED: on inside an ON window, off inside the following OFF gap, and on
  // again in the next ON window — twice, an integer and a half cycle later.
  for (const [onAt, offAt] of [[0.25, 0.7], [1.15, 1.6], [10.05, 10.5], [28.95, 29.4]]) {
    assert.ok(isOn(windows, onAt), `bar ON at t=${onAt}`);
    assert.ok(!isOn(windows, offAt), `bar OFF at t=${offAt}`);
  }
});

test('bottom bar blink: non-integer-multiple durations still end with the bar ON the final frame', () => {
  const blink: BottomBarBlink = { onSeconds: 0.5, offSeconds: 0.4 };
  for (const total of [30, 29.99, 27, 27.35, 4, 4.05, 3.0001, 12.7]) {
    const windows = resolveBottomBarBlinkWindows(total, blink);
    const last = windows[windows.length - 1];
    // (windows are integer-millisecond, so a sub-ms input rounds to the nearest ms)
    assert.ok(Math.abs(last[1] - total) <= 0.001, `total=${total}: last ON window ends on the final frame (${last[1]})`);
    assert.ok(Math.abs(last[1] - last[0] - blink.onSeconds) <= 0.001, `total=${total}: last ON window is a FULL 0.5s (${last[1] - last[0]}s)`);
    // the expression derived from those windows agrees, and covers t=total.
    // Frames land on 1/30s boundaries, so the LAST REAL FRAME of the delivered
    // 30fps video is the timestamp checked here (the enable expression is
    // rounded to the millisecond, hence the frame-based check).
    const expr = parseEnableWindows(buildBottomBarEnableExpression(total, blink));
    const lastFrame = Math.floor(total * 30) / 30;
    assert.ok(isOn(expr, lastFrame), `total=${total}: bar visible on the final frame (t=${lastFrame})`);
    assert.ok(isOn(expr, total - 0.01), `total=${total}: bar visible on the last real frame`);
    assert.ok(isOn(expr, 0), `total=${total}: bar visible on the first frame`);
    // no ON window is longer than the cadence, no OFF gap in the body is longer
    // than 0.4s, and windows never overlap (the tail may swallow one gap)
    const period = blink.onSeconds + blink.offSeconds;
    for (let i = 0; i < windows.length; i++) {
      assert.ok(windows[i][1] - windows[i][0] <= blink.onSeconds + 1e-9, `total=${total}: window ${i} not longer than 0.5s`);
      if (i > 0) assert.ok(windows[i][0] >= windows[i - 1][1] - 1e-9, `total=${total}: windows never overlap`);
      if (i > 0 && i < windows.length - 1) assert.ok(windows[i][0] - windows[i - 1][1] <= blink.offSeconds + 1e-9, `total=${total}: gap ${i} <= 0.4s`);
      if (i > 0) assert.ok(windows[i][0] - windows[i - 1][1] <= period + 1e-9, `total=${total}: gap ${i} <= one cycle`);
    }
  }
  // 30s is 33.33 cycles: the naive loop would end inside an OFF gap; we do not.
  assert.ok(isOn(parseEnableWindows(buildBottomBarEnableExpression(30, blink)), 29.99), 'no OFF gap at the very end of a 30s video');
  // sampled runs of a non-integer-multiple duration: the ON runs keep the cadence
  const runs = sampleOnRuns(parseEnableWindows(buildBottomBarEnableExpression(12.7, blink)), 12.7);
  assert.ok(runs.length >= 14, `12.7s carries ~15 ON runs (got ${runs.length})`);
  assert.ok(Math.abs(runs[runs.length - 1][1] - 12.7) < 1e-9, 'the last ON run reaches the final frame');
});

test('bottom bar: no cadence (or a degenerate one) keeps the EXACT legacy expression', () => {
  // the string this module has always emitted for a persistent bar
  assert.equal(buildBottomBarEnableExpression(30.4567), "enable='between(t,0,30.457)'");
  assert.equal(buildBottomBarEnableExpression(5.2, undefined), "enable='between(t,0,5.200)'");
  assert.equal(buildBottomBarEnableExpression(5.2, null), "enable='between(t,0,5.200)'");
  assert.equal(buildBottomBarEnableExpression(5.2, {} as BottomBarBlink), "enable='between(t,0,5.200)'");
  assert.equal(buildBottomBarEnableExpression(5.2, { onSeconds: 0, offSeconds: 0.4 }), "enable='between(t,0,5.200)'");
  // zero OFF gap = continuously on = the persistent string (no pointless graph)
  assert.equal(buildBottomBarEnableExpression(5.2, { onSeconds: 0.5, offSeconds: 0 }), "enable='between(t,0,5.200)'");
  // shorter than one ON window = on for the whole video = the persistent string
  assert.equal(buildBottomBarEnableExpression(0.3, { onSeconds: 0.5, offSeconds: 0.4 }), "enable='between(t,0,0.300)'");
});

test('normalizeAssemblyOverlays: the blink cadence rides on the bar and survives the metadata round-trip', () => {
  const spec = normalizeAssemblyOverlays(
    { bottomBar: 'EmpireLaunchAI.com', bottomBarBlink: { onSeconds: 0.5, offSeconds: 0.4 } },
    5,
  );
  assert.equal(spec?.bottomBar, 'EmpireLaunchAI.com');
  assert.deepEqual(spec?.bottomBarBlink, { onSeconds: 0.5, offSeconds: 0.4 });
  // the persisted metadata is re-normalized at assembly time — the cadence must
  // survive that second pass (this is how the renderer reads it back).
  const again = normalizeAssemblyOverlays(spec, 5);
  assert.deepEqual(again?.bottomBarBlink, { onSeconds: 0.5, offSeconds: 0.4 });
  // absent cadence ⇒ the spec is unchanged from before this feature
  assert.deepEqual(normalizeAssemblyOverlays({ bottomBar: 'EmpireLaunchAI.com' }, 5), { bottomBar: 'EmpireLaunchAI.com' });
  // a cadence with no bar text draws nothing at all (never a re-encode)
  assert.equal(normalizeAssemblyOverlays({ bottomBarBlink: { onSeconds: 0.5, offSeconds: 0.4 } }, 5), null);
  // malformed cadence with a bar ⇒ persistent bar, bar text kept
  const bad = normalizeAssemblyOverlays({ bottomBar: 'x', bottomBarBlink: { onSeconds: 'blink' } }, 5);
  assert.equal(bad?.bottomBar, 'x');
  assert.equal(bad?.bottomBarBlink, undefined);
});
