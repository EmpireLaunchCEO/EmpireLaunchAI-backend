/**
 * THE WORKER, DRIVEN FOR REAL (defect D — "what the tests actually prove").
 *
 * facelessVeoMotion.test.ts pins the PLAN and calls the worker's helpers. This file
 * calls the REAL `processProject` / `processScene` / `regenerateScene` for a Faceless
 * project, with the two paid boundaries stubbed (GPT Image and Veo) and an in-memory
 * database in place of Postgres. Nothing here costs money and nothing here asserts
 * on source text.
 *
 * What it pins, each on the ARTEFACT the run produced:
 *   A1  a window that FINISHED keeps its take when the span deadline expires —
 *       the other window falls back to its still, named, and does not fail the video.
 *   A3  `regenerateScene` passes the project's mode and never fails the project.
 *   A5  a Faceless Veo call sends NO `lastFrame` (the xfade join never reads one).
 *   A6  a lost window reuses the SAME designed still its motion was seeded from —
 *       one image call, not two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { db, schema } from '../../db/index.js';
import { sceneVideoPipelineService, planFacelessVeoSpans, type SoraSpan } from '../sceneVideoPipelineService.js';
import { renderingEngine } from '../renderingEngine.js';
import { veoVideoService, VEO_ERRORS } from '../veoVideoService.js';

const TMP = path.join(process.cwd(), 'temp', 'faceless-worker-real');
fs.mkdirSync(TMP, { recursive: true });

const USER_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_ID = 'project-faceless-worker';

// ─── the two real files the stubs hand back ─────────────────────────────────
const STILL = path.join(TMP, 'designed-still.png');
const TAKE = path.join(TMP, 'veo-take.mp4');
if (!fs.existsSync(STILL)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=0x203040:size=1024x1792:rate=30', '-frames:v', '1', STILL]);
}
const TAKE_BRIGHT = path.join(TMP, 'veo-take-bright.mp4');
if (!fs.existsSync(TAKE_BRIGHT)) {
  // A take whose luma is DETERMINISTIC (a solid bright frame), so a decoded frame's
  // brightness is a measurement and not a guess about the pattern.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=0xE0E0E0:size=720x1280:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', TAKE_BRIGHT],
    { maxBuffer: 32 * 1024 * 1024 });
}
/** 3.2s of tone: long enough that the MEASURED narration end (3200ms) + the 400ms
 *  margin outgrows a 3s planned window, which is what makes the window GROW. */
const NARRATION = path.join(TMP, 'narration-3.2s.wav');
if (!fs.existsSync(NARRATION)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=3.2', '-c:a', 'pcm_s16le', NARRATION]);
}
// The take has to MOVE, or C1's own sanity gate cannot fire. `testsrc2` does not
// move enough for that: measured on ffmpeg 6.1.1, its 64x64 grey frame at 1.5s
// differs from the frame at 0.5s by 2.3/255 — under C1's >10 threshold, so the test
// fails on its sanity assertion instead of on the defect. `mandelbrot` is a real
// zoom: measured 21.6 at 1s, 34.3 at 2s, 42.5 at 3s. Delete this file to regenerate.
if (!fs.existsSync(TAKE)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'mandelbrot=size=720x1280:rate=30', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', TAKE],
    { maxBuffer: 32 * 1024 * 1024 });
}

// ─── IN-MEMORY DATABASE ─────────────────────────────────────────────────────
// The service imports `db` and calls db.select()/update()/insert() at call time, so
// swapping those three methods gives the real worker a real store. Any predicate
// shape it cannot evaluate THROWS, so this can never silently mis-filter.
type Row = Record<string, any>;
const store = new Map<any, Row[]>();
const rowsOf = (t: any): Row[] => { if (!store.has(t)) store.set(t, []); return store.get(t)!; };

const isColumn = (n: any) => n && typeof n === 'object' && !n.queryChunks && typeof n.name === 'string' && n.table;
const isParam = (n: any) => n && typeof n === 'object' && !n.queryChunks && !n.table && 'value' in n;

function paramsIn(chunks: any[], out: any[] = []): any[] {
  for (const c of chunks) {
    if (Array.isArray(c)) paramsIn(c, out);
    else if (isParam(c)) out.push(c.value);
  }
  return out;
}

/** drizzle columns carry the SQL name (`project_id`); the rows here use the JS key
 *  (`projectId`). Resolve either, so a predicate can never silently match nothing. */
function colValue(row: Row, name: string): any {
  if (name in row) return row[name];
  return row[name.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())];
}

function evalPred(node: any, row: Row): boolean {
  if (node == null) return true;
  const chunks: any[] = Array.isArray(node?.queryChunks) ? node.queryChunks : [node];
  const nested = chunks.filter((c) => c && typeof c === 'object' && Array.isArray(c.queryChunks));
  const cols = chunks.filter(isColumn);
  if (nested.length && !cols.length) {
    const text = chunks.filter((c) => typeof c === 'string' || c instanceof String).map(String).join('');
    const results = nested.map((n) => evalPred(n, row));
    return /\bor\b/i.test(text) ? results.some(Boolean) : results.every(Boolean);
  }
  const params = paramsIn(chunks);
  if (cols.length === 1 && params.length === 1) {
    const v = params[0];
    const actual = colValue(row, cols[0].name);
    if (v == null) return actual == null;
    return actual === v || String(actual) === String(v);
  }
  if (cols.length === 1 && params.length > 1) {
    return params.some((v) => String(colValue(row, cols[0].name)) === String(v));
  }
  throw new Error(`fake-db: unsupported predicate (cols=${cols.length} params=${params.length})`);
}

const copy = (r: Row): Row => ({ ...r, metadata: { ...(r.metadata || {}) } });

function selectChain(yieldRead?: boolean): any {
  let table: any; let pred: any; let orderBy: any; let limitN: number | undefined;
  const self: any = {
    from(t: any) { table = t; return self; },
    where(p: any) { pred = p; return self; },
    orderBy(o: any) { orderBy = o; return self; },
    limit(n: number) { limitN = n; return self; },
    then(res: any, rej: any) {
      const out = rowsOf(table).filter((r) => evalPred(pred, r));
      if (orderBy && table === schema.videoScenes) out.sort((a, b) => a.sceneNumber - b.sceneNumber);
      const sliced = limitN ? out.slice(0, limitN) : out;
      const settle = () => Promise.resolve(sliced.map(copy));
      if (yieldRead) return new Promise<void>((r) => setImmediate(r)).then(settle).then(res, rej);
      return settle().then(res, rej);
    },
  };
  return self;
}

/** Optional observer so a test can SEE a write land (e.g. the moment a window's cost
 *  is recorded) instead of guessing with a sleep. */
let dbUpdateObserver: ((table: any, values: any) => void) | undefined;

function updateChain(table: any, yieldWriteMs?: number): any {
  let values: any; let pred: any;
  const self: any = {
    set(v: any) { values = v; return self; },
    where(p: any) { pred = p; return self; },
    then(res: any, rej: any) {
      const apply = () => {
        for (const r of rowsOf(table)) if (evalPred(pred, r)) Object.assign(r, values);
        dbUpdateObserver?.(table, values);
        return Promise.resolve([]);
      };
      if (yieldWriteMs) return new Promise<void>((r) => setTimeout(r, yieldWriteMs)).then(apply).then(res, rej);
      return apply().then(res, rej);
    },
  };
  return self;
}

function installDb(
  seed: { project: Row; scenes: Row[] },
  onUpdate?: (table: any, values: any) => void,
  /** RACE SIMULATION (defect C3): make the store yield between a read and the write
   *  that follows it, so two concurrent read-modify-write cycles really do interleave
   *  instead of winning a microtask race by luck. `yieldRead` yields one macrotask on
   *  every read; `yieldWriteMs` delays every write. */
  raceOpts?: { yieldRead?: boolean; yieldWriteMs?: number },
) {
  dbUpdateObserver = onUpdate;
  const anyDb = db as any;
  const orig = { select: anyDb.select, update: anyDb.update, insert: anyDb.insert };
  store.clear();
  store.set(schema.videoProjects, [seed.project]);
  store.set(schema.videoScenes, seed.scenes);
  anyDb.select = () => selectChain(raceOpts?.yieldRead);
  anyDb.update = (t: any) => updateChain(t, raceOpts?.yieldWriteMs);
  anyDb.insert = (t: any) => ({
    values(v: any) {
      const list = Array.isArray(v) ? v : [v];
      rowsOf(t).push(...list.map(copy));
      return Promise.resolve([]);
    },
  });
  return () => { Object.assign(anyDb, orig); dbUpdateObserver = undefined; };
}

const scenesOf = () => rowsOf(schema.videoScenes);
const projectRow = () => rowsOf(schema.videoProjects)[0];

// ─── THE FIXTURE: the real Faceless shape (hook + payoff, two 8s windows) ────
function facelessProject(opts: { voice?: string; duration?: number } = {}) {
  const dur = opts.duration ?? 2;
  const scenes = [
    { sceneNumber: 1, duration: dur, visualPrompt: 'Warm bakery counter at sunrise, a happy family spending time together' },
    { sceneNumber: 2, duration: dur, visualPrompt: 'The bakery storefront at golden hour, a happy family spending time together' },
  ].map((s) => ({
    id: `scene-${s.sceneNumber}`,
    projectId: PROJECT_ID,
    sceneNumber: s.sceneNumber,
    duration: s.duration,
    visualType: 'motion',
    narration: `line ${s.sceneNumber}`,
    visualPrompt: s.visualPrompt,
    status: 'pending',
    metadata: {
      importantSora: true,
      veoWindowReady: true,
      soraBlock: 0,
      motionStartSeconds: (s.sceneNumber - 1) * 8,
      motionSeconds: 8,
      spanOffset: (s.sceneNumber - 1) * 8,
    },
  }));
  const spans: SoraSpan[] = [{
    soraBlock: 0,
    sceneNumbers: [1, 2],
    totalSeconds: 16,
    windows: [
      { sceneNumber: 1, motionStartSeconds: 0, motionSeconds: 8 },
      { sceneNumber: 2, motionStartSeconds: 8, motionSeconds: 8 },
    ],
    prompt: 'Render ONE continuous 16-second single take.',
  }];
  const project = {
    id: PROJECT_ID,
    userId: USER_ID,
    status: 'generating',
    metadata: { mode: 'faceless', voice: opts.voice ?? 'none', spans },
  };
  return { project, scenes };
}

/** Stub the two paid boundaries and record what they were asked to do. */
function stubProviders(opts: {
  /** window sceneNumber → behaviour */
  veo: (sceneNumber: number, call: any) => Promise<any> | any;
  onVeo?: (call: any) => void;
  onRender?: (prompt: string) => void;
  /** A REAL narration file, so the measured-narration path (and the growth it
   *  causes) runs on a measurement instead of being skipped. */
  audioPath?: string;
}) {
  const engine: any = renderingEngine;
  const veo: any = veoVideoService;
  const svc: any = sceneVideoPipelineService;
  const origRender = engine.renderImage;
  const origVeo = veo.generateSceneVideo;
  const origAudio = Object.prototype.hasOwnProperty.call(svc, 'generateAudio') ? svc.generateAudio : undefined;
  engine.renderImage = async (prompt: string) => {
    opts.onRender?.(String(prompt));
    return { success: true, imageUrl: STILL };
  };
  veo.generateSceneVideo = async (call: any) => {
    opts.onVeo?.(call);
    const n = Number(String(call.sceneKey).split('scene').pop());
    return opts.veo(n, call);
  };
  // Narration is not what this file is about: no GPT-Audio call, no audio file.
  svc.generateAudio = async () => ({ localPath: opts.audioPath ?? path.join(TMP, 'no-audio.mp3') });
  return () => {
    engine.renderImage = origRender;
    veo.generateSceneVideo = origVeo;
    if (origAudio) svc.generateAudio = origAudio; else delete svc.generateAudio;
  };
}

// ═══ A1 + A5 + A6, through the REAL processProject ══════════════════════════
test('A1/A5/A6 — the real worker: a finished window keeps its take when the span deadline expires', async (t) => {
  const { project, scenes } = facelessProject();
  // DETERMINISM. The span deadline is a WALL CLOCK, so a fixture that simply sets a
  // short one races its own work: window 1's still render + ffmpeg fit take longer
  // than the deadline, so window 1 was counted LOST before its take had landed. That
  // measured the test's speed, not the worker. The clock is faked here instead — the
  // deadline can only fire when this test ticks it, and it ticks it only AFTER window
  // 1's take is in the worker's registry. The code under test is untouched and real.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  // The one observable that runs a microtask BEFORE the take is handed to the
  // registry (recordVeoCost → onTake), so landing it here means the take is about to
  // land; the setImmediate drain below closes that gap.
  let windowOneBilled: () => void = () => {};
  const billed = new Promise<void>((resolve) => { windowOneBilled = resolve; });
  const restoreDb = installDb({ project, scenes }, (table, values) => {
    if (table === schema.videoProjects && values?.metadata?.motionCost?.perWindow?.['block0-scene1'] !== undefined) {
      windowOneBilled();
    }
  });
  const veoCalls: any[] = [];
  const renders: string[] = [];
  const restore = stubProviders({
    onVeo: (c) => veoCalls.push(c),
    onRender: (p) => renders.push(p),
    veo: (n) => n === 1
      // Window 1 comes back fast — it has been PAID FOR.
      ? Promise.resolve({ success: true, videoPath: TAKE, billedSeconds: 8, operationName: 'op-1' })
      // Window 2 never returns: the span deadline expires while it is in flight.
      : new Promise(() => { /* hangs forever — no timer, nothing to leak */ }),
  });
  process.env.VEO_PREPASS_DEADLINE_MS = '400';
  try {
    const run = sceneVideoPipelineService.processProject(PROJECT_ID, USER_ID);
    // REAL-TIME watchdog (native timer, unaffected by the faked clock) so a worker
    // that never lands window 1 fails the test instead of hanging the suite.
    await Promise.race([
      billed,
      new Promise<void>((_resolve, reject) => {
        AbortSignal.timeout(60_000).addEventListener('abort', () => reject(new Error('window 1 never landed within 60s of real time')));
      }),
    ]);
    // Let the take reach the registry (pure microtasks from here — setImmediate is
    // NOT faked). The span promise is still pending: window 2 is still hanging.
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    // NOW the span deadline expires — after the take landed, which is the whole point.
    t.mock.timers.tick(400);
    // Back to the real clock for the rest of the worker (scene loop, ffmpeg, exports).
    t.mock.timers.reset();
    await run;
  } finally {
    delete process.env.VEO_PREPASS_DEADLINE_MS;
    t.mock.timers.reset();
    restore();
    restoreDb();
  }

  const [s1, s2] = scenesOf();
  const s1Meta = s1.metadata;
  const s2Meta = s2.metadata;

  // A5 — Faceless dissolves (xfade); it must never send a lastFrame.
  assert.equal(veoCalls.length, 2, 'both elected windows were called');
  for (const c of veoCalls) {
    assert.equal(c.lastFramePath, undefined, `FACELESS SENT A lastFrame the xfade join never reads: ${c.sceneKey}`);
  }
  // A4 — one call, one beat, its own real length.
  assert.ok(/8-second single take of ONE beat/.test(String(veoCalls[0].prompt)), `the window prompt describes its own beat and length: ${veoCalls[0].prompt}`);
  assert.ok(!/16-second/.test(String(veoCalls[0].prompt)), 'the 16-second span text is not sent to an 8-second call');

  // A1 — the finished window KEPT its motion.
  assert.equal(s1.status, 'completed', `the finished window's scene must complete: ${s1Meta.error || ''}`);
  assert.match(String(s1Meta.localPath), /\.mp4$/, `THE FINISHED WINDOW LOST ITS TAKE TO THE DEADLINE: localPath=${s1Meta.localPath}`);
  assert.equal(s1Meta.motionFallbackReason, undefined, 'a window that produced a take is not a fallback');

  // A1 — the lost window falls back to its still, and the loss is NAMED.
  assert.equal(s2.status, 'completed', `a lost window must not fail its scene: ${s2Meta.error || ''}`);
  assert.match(String(s2Meta.motionFallbackReason), /timed out/i, `the lost window is named on its scene: ${s2Meta.motionFallbackReason}`);
  // A6 — THE DISCRIMINATOR IS THE CALL COUNT: the still was already drawn for the
  // motion seed, so a lost window must reuse it, not buy a second one.
  assert.ok(s2Meta.motionStillPath, 'the motion still was rendered and recorded');
  const stillsForScene2 = renders.filter((p) => /storefront at golden hour/i.test(p));
  assert.equal(stillsForScene2.length, 1, `A LOST WINDOW PAID FOR A SECOND STILL (${stillsForScene2.length} image calls for that beat)`);
  assert.match(String(s2Meta.localPath), /designed-still\.png$/, 'the fallback picture is the designed still the motion was seeded from');

  // A1 — the loss is rolled up onto the project, and the video is NOT failed by it.
  assert.deepEqual((projectRow().metadata.motionFallbacks || []).map((m: any) => m.sceneNumber), [2],
    'the project names the window that lost its motion');
  assert.equal(projectRow().metadata.failedSceneCount, undefined, 'a lost motion window never fails the project');
  assert.notEqual(projectRow().status, 'failed', `the video still finishes: ${projectRow().metadata.error || ''}`);
});

// ═══ A3, through the REAL regenerateScene ═══════════════════════════════════
test('A3 — the real regenerateScene: passes the mode and never fails the project', async () => {
  const { project, scenes } = facelessProject();
  // A finished video: every scene already completed.
  for (const s of scenes) {
    s.status = 'completed';
    s.metadata = { ...s.metadata, localPath: TAKE, motionStillPath: STILL };
  }
  project.status = 'completed';
  const restoreDb = installDb({ project, scenes });
  const veoCalls: any[] = [];
  const restore = stubProviders({
    onVeo: (c) => veoCalls.push(c),
    // The window this regeneration re-runs fails. Faceless must fall back to its
    // still and finish; the project must NOT be marked failed.
    veo: () => ({ success: false, error: `${VEO_ERRORS.imageRejected} (provider refused the frame)` }),
  });
  try {
    await sceneVideoPipelineService.regenerateScene('scene-1', USER_ID);
  } finally {
    restore();
    restoreDb();
  }

  assert.equal(veoCalls.length, 1, 'the click re-ran THAT scene\'s own window (one paid call)');
  const s1 = scenesOf().find((s) => s.sceneNumber === 1)!;
  assert.equal(s1.status, 'completed',
    `A REGENERATION FAILED THE SCENE (mode was not passed): ${s1.metadata.error || ''}`);
  assert.match(String(s1.metadata.localPath), /\.png$/, 'it fell back to the designed still');
  assert.ok(/REJECTED|refused/i.test(String(s1.metadata.motionFallbackReason || '')), 'and the loss is stated');
  assert.notEqual(projectRow().status, 'failed', `ONE CLICK DESTROYED THE PROJECT: ${projectRow().metadata.error || ''}`);
});

// ─── ARTEFACT READERS ───────────────────────────────────────────────────────
// Every assertion below is made on a FILE the worker actually produced — a decoded
// frame or the final metadata — never on an argument, a filter string or source
// text. A filter that looks right is not a picture that is right.
function probeSeconds(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]).toString().trim();
  const n = parseFloat(out);
  return Number.isFinite(n) ? n : 0;
}
/** Decode ONE frame at `atSeconds` as a 64x64 grey raster. */
function greyFrame(file: string, atSeconds: number): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(atSeconds), '-i', file, '-frames:v', '1',
    '-vf', 'scale=64:64,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 8 * 1024 * 1024 });
}
function meanLuma(g: Buffer): number {
  if (!g.length) return 0;
  let s = 0;
  for (const v of g) s += v;
  return s / g.length;
}
/** Mean absolute difference between two decoded frames (0 = identical picture). */
function frameDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 255;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}
const projectDir = () => path.join(process.cwd(), 'temp', 'scene-projects', PROJECT_ID);

// ═══ §1 — PER-WINDOW TIMEOUT, through the REAL processProject ═══════════════
test('PER-WINDOW TIMEOUT — a hung window is abandoned at its OWN deadline; the landed take survives and only one call is billed', async (t) => {
  const { project, scenes } = facelessProject();
  // Same fake clock as A1: the deadline can only fire when this test ticks it, so the
  // result measures the worker instead of the fixture's speed.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const veoCalls: any[] = [];
  let callsWhenWindowOneLanded = -1;
  let windowOneBilled: () => void = () => {};
  const billed = new Promise<void>((resolve) => { windowOneBilled = resolve; });
  const restoreDb = installDb({ project, scenes }, (table, values) => {
    if (table === schema.videoProjects && values?.metadata?.motionCost?.perWindow?.['block0-scene1'] !== undefined) {
      callsWhenWindowOneLanded = veoCalls.length;
      windowOneBilled();
    }
  });
  const restore = stubProviders({
    onVeo: (c) => veoCalls.push(c),
    veo: (n) => n === 1
      // Window 1 lands (it has been paid for).
      ? Promise.resolve({ success: true, videoPath: TAKE, billedSeconds: 8, operationName: 'op-1' })
      // Window 2 never returns — a provider that accepted the call and went quiet.
      : new Promise(() => { /* hangs forever — no timer, nothing to leak */ }),
  });
  // THE SPAN BUDGET IS NOT WHAT SAVES THIS VIDEO: it is parked ten minutes out, so
  // ONLY the per-window deadline can end window 2. A worker without one waits on the
  // hung window forever (measured: the run never resolves).
  process.env.VEO_PREPASS_DEADLINE_MS = '600000';
  process.env.VEO_WINDOW_DEADLINE_MS = '400';
  try {
    const run = sceneVideoPipelineService.processProject(PROJECT_ID, USER_ID);
    await Promise.race([
      billed,
      new Promise<void>((_resolve, reject) => {
        AbortSignal.timeout(60_000).addEventListener('abort', () => reject(new Error('window 1 never landed within 60s of real time')));
      }),
    ]);
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    // CONCURRENCY: both windows were in flight at the same moment — window 2 was
    // already called while window 1 was still working.
    assert.equal(callsWhenWindowOneLanded, 2, 'the two windows must START concurrently — a per-window deadline must never serialise them');
    // Now window 2's OWN deadline expires.
    t.mock.timers.tick(400);
    t.mock.timers.reset();
    await Promise.race([
      run,
      new Promise<void>((_resolve, reject) => {
        AbortSignal.timeout(20_000).addEventListener('abort', () => reject(
          new Error('THE HUNG WINDOW WAS NEVER ABANDONED: 20s of real time passed with window 2 still in flight — the worker has no per-window deadline, so the whole video waits for a dead provider'),
        ));
      }),
    ]);
  } finally {
    delete process.env.VEO_PREPASS_DEADLINE_MS;
    delete process.env.VEO_WINDOW_DEADLINE_MS;
    t.mock.timers.reset();
    restore();
    restoreDb();
  }

  const [s1, s2] = scenesOf();
  // The window that FINISHED keeps its take.
  assert.equal(s1.status, 'completed', `the finished window's scene must complete: ${s1.metadata.error || ''}`);
  assert.match(String(s1.metadata.localPath), /\.mp4$/, `THE FINISHED WINDOW LOST ITS TAKE TO THE PER-WINDOW DEADLINE: localPath=${s1.metadata.localPath}`);
  assert.equal(s1.metadata.motionFallbackReason, undefined, 'a window that produced a take is not a fallback');
  // The abandoned window falls back to its designed still, NAMED, and is not fatal.
  assert.equal(s2.status, 'completed', `an abandoned window must not fail its scene: ${s2.metadata.error || ''}`);
  assert.match(String(s2.metadata.motionFallbackReason), /timed out/i, `the abandoned window is named on its own scene: ${s2.metadata.motionFallbackReason}`);
  assert.match(String(s2.metadata.localPath), /designed-still\.png$/, 'the fallback picture is the designed still the motion was seeded from');
  // THE LEDGER BILLS EXACTLY WHAT WAS SPENT: one landed call, nothing for the window
  // that never returned.
  const cost = projectRow().metadata.motionCost;
  assert.equal(cost.calls, 1, `the ledger must bill exactly the one window that landed: ${JSON.stringify(cost)}`);
  assert.deepEqual(Object.keys(cost.perWindow), ['block0-scene1'], 'only the landed window is on the ledger');
  assert.equal(cost.usd, 0.24, `one 8s call is $0.24: ${JSON.stringify(cost)}`);
  assert.notEqual(projectRow().status, 'failed', `the video still finishes: ${projectRow().metadata.error || ''}`);
});

// ═══ C1 — a grown motion window is RE-FITTED, never replayed ════════════════
test('C1 — a grown motion window keeps the motion continuous: the mid frame is not a replay of the opening frame', async () => {
  // 3s planned windows (growSceneWindowsToMeasured never shrinks below 3s) with 3.2s
  // of measured narration → both windows GROW to 4s after the take was already fitted
  // to 3s. That is the exact shape the owner's renders hit.
  const { project, scenes } = facelessProject({ voice: 'female', duration: 3 });
  const restoreDb = installDb({ project, scenes });
  const restore = stubProviders({
    audioPath: NARRATION,
    veo: () => ({ success: true, videoPath: TAKE, billedSeconds: 8, operationName: 'op-x' }),
  });
  process.env.SCENE_TRANSITION_MS = '40'; // a 40ms join, so scene 1 owns [0, 4s) of the delivered file
  try {
    await sceneVideoPipelineService.processProject(PROJECT_ID, USER_ID);
  } finally {
    delete process.env.SCENE_TRANSITION_MS;
    restore();
    restoreDb();
  }

  const s1 = scenesOf().find((s) => s.sceneNumber === 1)!;
  assert.equal(s1.duration, 4, `the measured narration must have GROWN this window from 3s: ${s1.duration}`);
  const final = path.join(projectDir(), 'final.mp4');
  assert.ok(fs.existsSync(final), 'the video assembled');
  assert.ok(probeSeconds(final) > 7, `the delivered video covers both 4s windows: ${probeSeconds(final)}s`);

  // DECODE THE DELIVERED FILE. Scene 1 is the first clip, so its own timeline is the
  // output's first 4 seconds.
  const start = greyFrame(final, 0.5);
  const mid = greyFrame(final, 2.5);
  const end = greyFrame(final, 3.5);
  const moves = frameDiff(greyFrame(final, 1.5), start);
  assert.ok(moves > 10, `sanity — this take really does move (frame 1.5s differs from 0.5s by ${moves.toFixed(1)})`);
  const midDiff = frameDiff(mid, start);
  const endDiff = frameDiff(end, start);
  // Pre-fix, `-stream_loop 1` restarts the 3s take at 3.0s... and at 2.5s the picture
  // is already the frame the clip opened with (a 4s window over a 3s take replays it
  // from frame 0). A re-fit stretches the take instead, so 2.5s is DIFFERENT content.
  assert.ok(midDiff > 10, `THE GROWN WINDOW REPLAYED THE CLIP FROM FRAME 0: the frame at 2.5s is a near-duplicate of the opening frame (difference ${midDiff.toFixed(1)}/255) — the picture jumps back mid-motion`);
  assert.ok(endDiff > 10, `the frame at 3.5s is a near-duplicate of the opening frame (difference ${endDiff.toFixed(1)}/255)`);
});

// ═══ C2 — the closing shot must not fade up from black ═════════════════════
test('C2 — the closing shot does not fade up from black in the assembled video', async () => {
  const { project, scenes } = facelessProject({ voice: 'female', duration: 3 });
  const restoreDb = installDb({ project, scenes });
  const restore = stubProviders({
    audioPath: NARRATION,
    // A solid bright take: the closing shot's brightness is then a measurement.
    veo: () => ({ success: true, videoPath: TAKE_BRIGHT, billedSeconds: 8, operationName: 'op-b' }),
  });
  process.env.SCENE_TRANSITION_MS = '40';
  try {
    await sceneVideoPipelineService.processProject(PROJECT_ID, USER_ID);
  } finally {
    delete process.env.SCENE_TRANSITION_MS;
    restore();
    restoreDb();
  }

  const final = path.join(projectDir(), 'final.mp4');
  assert.ok(fs.existsSync(final), 'the video assembled');
  const scene1 = path.join(projectDir(), 'scene-1.mp4');
  const tr = 0.04;
  // Where the closing shot starts in the delivered file: clip 1's length minus the
  // join overlap the assembler uses.
  const closingStart = probeSeconds(scene1) - tr;
  assert.ok(closingStart > 3, `the closing shot starts after scene 1: ${closingStart}s`);
  // THE PAYOFF SCENE IS A MOTION SCENE, so padVideoToAudio is true and the old
  // `fade=t=in` faded the video's LAST SHOT up from black.
  const firstFrame = meanLuma(greyFrame(final, closingStart + 0.06));
  const steady = meanLuma(greyFrame(final, closingStart + 0.5));
  assert.ok(steady > 150, `sanity — the closing shot's picture is bright once it is up (${steady.toFixed(0)}/255)`);
  assert.ok(firstFrame > 150,
    `THE CLOSING SHOT FADES UP FROM BLACK: its first frames average ${firstFrame.toFixed(0)}/255 while the same shot a moment later is ${steady.toFixed(0)}/255`);
});

// ═══ C3 — concurrent windows must not clobber the cost ledger ═══════════════
test('C3 — two concurrent windows both land on the ledger: two calls, $0.48', async () => {
  const { project, scenes } = facelessProject();
  // A store that YIELDS between the read and the write, so the two windows' read-
  // modify-write cycles genuinely interleave instead of winning a microtask race by
  // luck. Both windows start together (the fixture's two Veo calls resolve together).
  const restoreDb = installDb({ project, scenes }, undefined, { yieldRead: true, yieldWriteMs: 40 });
  const restore = stubProviders({
    veo: (n, call) => {
      call.onOperationCreated?.(`op-${n}`);
      return { success: true, videoPath: TAKE, billedSeconds: 8, operationName: `op-${n}` };
    },
  });
  try {
    await sceneVideoPipelineService.processProject(PROJECT_ID, USER_ID);
  } finally {
    restore();
    restoreDb();
  }

  const meta = projectRow().metadata;
  const cost = meta.motionCost;
  // THE LEDGER MUST NEVER UNDER-REPORT MONEY SPENT (nor over-report it): this render
  // billed two 8-second calls.
  assert.ok(cost, 'the ledger exists');
  assert.deepEqual(Object.keys(cost.perWindow || {}).sort(), ['block0-scene1', 'block0-scene2'],
    `ONE WINDOW'S ENTRY VANISHED FROM THE LEDGER: ${JSON.stringify(cost)}`);
  assert.equal(cost.calls, 2, `the ledger must report BOTH calls: ${JSON.stringify(cost)}`);
  assert.equal(cost.billedSeconds, 16, `both windows' seconds: ${JSON.stringify(cost)}`);
  assert.equal(cost.usd, 0.48, `two 8s calls are $0.48: ${JSON.stringify(cost)}`);
  // The persisted operations are the same read-modify-write of the same object: a
  // lost entry there means a resumed run would re-POST a window already paid for.
  assert.deepEqual(Object.keys(meta.veoJobs || {}).sort(), ['block0-scene1', 'block0-scene2'],
    `ONE WINDOW'S OPERATION VANISHED: ${JSON.stringify(meta.veoJobs)}`);
});
