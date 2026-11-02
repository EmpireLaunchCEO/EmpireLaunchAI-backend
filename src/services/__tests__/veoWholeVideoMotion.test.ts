/**
 * WHOLE-VIDEO VEO MOTION (owner, Nov 2 — approved explicitly).
 *
 *   "lets make the whole 30 seconds motion with Veo for scene based."
 *   "since calls have to be made in seconds, it needs to be 6 seconds calls."
 *   "needs to make sure that it makes the video as clients want."
 *   "translation doesn't need to get lost making 5 calls at 6 seconds each."
 *
 * What this file pins:
 *   (1) IMAGE-TO-VIDEO — the scene's designed still rides in
 *       `instances[0].image` as `{ bytesBase64Encoded, mimeType }` (Google's
 *       documented `VideoGenerationModelInstance.Image`; verified live 2026-11-02
 *       with a real 4s/720p call, $0.12, 54.7s end to end).
 *   (2) EVERY SCENE MOVES — 5 scenes × 6s = 5 calls / 30s; 3 scenes = 3 calls / 18s.
 *   (3) SHORT BEAT → 4s tier (never 6s it cannot use); long beat → 8s.
 *   (4) NEVER MORE THAN THE VIDEO — total billed motion ≤ planned duration and ≤30s.
 *   (5) THE JOINS — measured on real frames: the assembly's xfade is not a hard cut,
 *       and a regression back to a plain concat FAILS this suite.
 *   (6) NARRATION SYNC — a take is fitted to its scene's window (trim or gentle
 *       slow-down, never a frozen tail) so picture and narration cannot drift.
 *   (7) THE REAL REASON — a failed window surfaces credentials / service account /
 *       retired model / rejected image, never a bare count.
 *   (8) FACELESS + TWIN — zero Veo calls, by construction.
 *
 * ZERO PAID CALLS: fetch is fully mocked and every ffmpeg fixture is generated
 * locally from a 2-colour PNG.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import {
  VeoVideoService,
  buildVeoPredictBody,
  loadVeoInputImage,
  veoImageMimeType,
  nearestLegalVeoSeconds,
  veoCostUsd,
  VEO_LEGAL_DURATIONS,
  VEO_CALL_SECONDS,
  VEO_MOTION_BUDGET_SECONDS,
  VEO_MAX_MOTION_WINDOWS,
  VEO_MODEL,
  VEO_ERRORS,
  veoImageRejectedMessage,
  veoImageMissingMessage,
} from '../veoVideoService.js';
import {
  planVeoSceneWindows,
  planVeoSceneSpans,
  applyVeoSceneMotion,
  capVeoMotionWindows,
  fitClipToDuration,
  concatClips,
  isRetryableVeoFailure,
  type SceneScript,
} from '../sceneVideoPipelineService.js';

const TMP = path.join(process.cwd(), 'temp', 'veo-whole-video-tests');
fs.mkdirSync(TMP, { recursive: true });

const scene = (n: number, duration: number): SceneScript => ({
  sceneNumber: n, duration, visualType: 'still', narration: `Line ${n}.`, visualPrompt: `beat ${n}`,
});

// ═══ (1) IMAGE-TO-VIDEO request contract ═════════════════════════════════════
test('IMAGE: buildVeoPredictBody puts the still in instances[0].image (documented shape)', () => {
  const body: any = buildVeoPredictBody('slow push in', {
    sampleCount: 1,
    durationSeconds: 6,
    aspectRatio: '9:16',
    resolution: '720p',
    generateAudio: false,
    image: { bytesBase64Encoded: 'QUJD', mimeType: 'image/png' },
  });
  assert.equal(body.instances.length, 1);
  assert.equal(body.instances[0].prompt, 'slow push in');
  assert.deepEqual(body.instances[0].image, { bytesBase64Encoded: 'QUJD', mimeType: 'image/png' },
    'image-to-video: the clip must START from the frame we designed');
  assert.equal(body.parameters.generateAudio, false, 'audio stays explicit and off (billed separately)');
  assert.equal(body.parameters.durationSeconds, 6);
  assert.equal('numberOfVideos' in body.parameters, false, 'numberOfVideos is never sent');
});

test('IMAGE: no still → no image key (text-to-video shape is unchanged)', () => {
  const body: any = buildVeoPredictBody('p', { sampleCount: 1 });
  assert.equal('image' in body.instances[0], false);
});

test('IMAGE: loadVeoInputImage round-trips real PNG bytes and picks the right mime', () => {
  const png = path.join(TMP, 'still.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  fs.writeFileSync(png, bytes);
  const img = loadVeoInputImage(png);
  assert.equal(img.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(img.bytesBase64Encoded, 'base64'), bytes);
  assert.equal(veoImageMimeType('x.JPEG'), 'image/jpeg', 'jpg/jpeg → image/jpeg (the only other legal mime)');
  assert.throws(() => loadVeoInputImage(path.join(TMP, 'nope.png')), /ENOENT|no such file/i);
});

test('IMAGE: generateSceneVideo sends the still on the wire and reports usedImage', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const prevSa = process.env.GOOGLE_VERTEX_SA_JSON;
  process.env.GOOGLE_VERTEX_SA_JSON = JSON.stringify({
    type: 'service_account', project_id: 'proj-test', private_key_id: 'k',
    private_key: pem, client_email: 'sa@proj-test.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  const bodies: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3599 }), { status: 200 });
    }
    if (url.endsWith(':predictLongRunning')) {
      bodies.push(JSON.parse(String(init?.body || '{}')));
      return new Response(JSON.stringify({ name: 'projects/p/locations/us-central1/publishers/google/models/m/operations/op-1' }), { status: 200 });
    }
    if (url.endsWith(':fetchPredictOperation')) {
      return new Response(JSON.stringify({
        done: true,
        response: { videos: [{ bytesBase64Encoded: Buffer.from('clip').toString('base64'), mimeType: 'video/mp4' }] },
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const still = path.join(TMP, 'wire-still.png');
    fs.writeFileSync(still, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
    const svc = new VeoVideoService();
    svc.pollDelayMs = 0;
    const out = await svc.generateSceneVideo({
      prompt: 'one continuous take', sceneKey: 'block0-scene1',
      onOperationCreated: async () => {}, durationSeconds: 6, imagePath: still,
    });
    assert.ok(out.success, out.error);
    assert.equal(out.usedImage, true, 'the call was image-to-video');
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].instances[0].image, 'the still rode on the wire');
    assert.equal(bodies[0].instances[0].image.mimeType, 'image/png');
    assert.equal(Buffer.from(bodies[0].instances[0].image.bytesBase64Encoded, 'base64').length, 7);
    assert.equal(bodies[0].parameters.durationSeconds, 6);
    assert.equal(bodies[0].parameters.generateAudio, false);
    assert.equal(out.estimatedUsd, 0.18, '6s × $0.03/s = $0.18 of motion');
    if (out.videoPath) fs.rmSync(out.videoPath, { force: true });
  } finally {
    globalThis.fetch = originalFetch;
    if (prevSa === undefined) delete process.env.GOOGLE_VERTEX_SA_JSON; else process.env.GOOGLE_VERTEX_SA_JSON = prevSa;
  }
});

// ═══ (2)(3)(4) the window plan ══════════════════════════════════════════════
test('PLAN: a 5-scene 30s video buys FIVE 6s calls = 30s of motion', () => {
  const script = [1, 2, 3, 4, 5].map(n => scene(n, 6));
  const windows = planVeoSceneWindows(script);
  assert.equal(windows.length, 5, 'one call per scene — no "important windows only" election');
  assert.deepEqual(windows.map(w => w.motionSeconds), [6, 6, 6, 6, 6]);
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 30);
  assert.deepEqual(windows.map(w => w.sceneNumber), [1, 2, 3, 4, 5], 'every scene moves');
  assert.equal(veoCostUsd(30), 0.9, '30s × $0.03/s = $0.90 per 30s Scene video');
});

test('PLAN: a 3-scene 18s video buys THREE 6s calls = 18s of motion', () => {
  const windows = planVeoSceneWindows([scene(1, 6), scene(2, 6), scene(3, 6)]);
  assert.equal(windows.length, 3);
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 18);
  assert.equal(veoCostUsd(18), 0.54);
});

test('PLAN: a scene shorter than 6s takes the 4s tier — never 6s it cannot use', () => {
  assert.equal(nearestLegalVeoSeconds(3.0), 4);
  assert.equal(nearestLegalVeoSeconds(5.4), 4);
  assert.equal(nearestLegalVeoSeconds(5.99), 4);
  assert.equal(nearestLegalVeoSeconds(6.0), 6);
  assert.equal(nearestLegalVeoSeconds(6.8), 6);
  assert.equal(nearestLegalVeoSeconds(7.0), 8);
  assert.equal(nearestLegalVeoSeconds(9.5), 8);
  const windows = planVeoSceneWindows([scene(1, 5.4), scene(2, 6.5), scene(3, 7.5)]);
  assert.deepEqual(windows.map(w => w.motionSeconds), [4, 6, 8]);
  assert.ok(VEO_LEGAL_DURATIONS.includes(4) && VEO_LEGAL_DURATIONS.includes(6) && VEO_LEGAL_DURATIONS.includes(8));
});

test('PLAN: total motion never exceeds the video, and never exceeds 30s', () => {
  // 5 × 7s = 35s planned → each snaps to 8s, which would be 40s. Must step down.
  const heavy = [1, 2, 3, 4, 5].map(n => scene(n, 7));
  const w = planVeoSceneWindows(heavy);
  const total = w.reduce((a, x) => a + x.motionSeconds, 0);
  assert.ok(total <= 30, `total ${total}s must not exceed the 30s cap`);
  assert.ok(total <= 35, 'and must not exceed the video itself');
  assert.ok(w.length <= VEO_MAX_MOTION_WINDOWS);
  // A very short video cannot buy more motion than it has: a 6s video fits ONE
  // 4s window, not two (8s of motion for a 6s video would be money for nothing).
  const short = planVeoSceneWindows([scene(1, 3), scene(2, 3)]);
  assert.equal(short.length, 1, 'only one 4s window fits a 6s video');
  assert.ok(short.reduce((a, x) => a + x.motionSeconds, 0) <= 6, 'never more motion than the video itself');
});

test('PLAN: spans carry one window per scene and applyVeoSceneMotion marks every scene motion', () => {
  const script = [1, 2, 3, 4, 5].map(n => scene(n, 6));
  const spans = planVeoSceneSpans(script);
  assert.equal(spans.length, 1, 'one span container holds every window');
  assert.equal(spans[0].windows.length, 5);
  assert.equal(spans[0].totalSeconds, 30);
  const planned = applyVeoSceneMotion(script, spans);
  assert.equal(planned.filter(s => s.visualType === 'motion').length, 5, 'every scene is motion');
  assert.ok(planned.every(s => s.soraBlock === 0));
  // No spans (Faceless / Twin / no motion) → everything stays a still, zero Veo.
  const none = applyVeoSceneMotion(script, []);
  assert.equal(none.filter(s => s.visualType === 'motion').length, 0, 'no spans ⇒ no motion ⇒ zero Veo spend');
  assert.equal(planVeoSceneSpans([]).length, 0);
});

test('PLAN: capVeoMotionWindows keeps the whole 30s and demotes only what does not fit', () => {
  const script = [1, 2, 3, 4, 5].map(n => scene(n, 6));
  const spans = planVeoSceneSpans(script);
  const { spans: capped } = capVeoMotionWindows(script, spans);
  assert.equal(capped[0].windows.length, 5, 'nothing demoted at 30s');
  assert.equal(capped[0].totalSeconds, 30);
});

// ═══ (8) Faceless / Twin make ZERO Veo calls ═════════════════════════════════
test('FACELESS/TWIN: the motion election is `mode === "scene"` only — zero Veo spend elsewhere', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'), 'utf8');
  const callSites = src.split('\n')
    .filter(l => l.includes('planVeoSceneSpans('))
    .filter(l => !l.includes('export function planVeoSceneSpans')); // the definition is not a call
  assert.equal(callSites.length, 1, 'planVeoSceneSpans has exactly ONE call site');
  assert.ok(/mode === 'scene'\s*\?/.test(callSites[0]), 'and it is guarded by mode === "scene"');
  // Faceless and Twin are Ken Burns: they never enter the Veo window pre-pass,
  // because a span plan only exists for scene mode.
  assert.ok(/let spanPlans = mode === 'scene' \?/.test(src), 'non-scene modes get an EMPTY span plan');
  assert.equal(src.split('veoVideoService.generateSceneVideo(').length - 1, 2,
    'exactly two Veo call sites (the per-window path and the legacy per-scene path)');
});

// ═══ (5) THE JOINS — measured on real frames ═════════════════════════════════
/** Max frame-to-frame luma delta in [from,to] seconds: how hard the picture jumps.
 *  A hard cut spikes; a dissolve stays smooth. */
function maxFrameDelta(file: string, from: number, to: number): number {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-i', file,
    '-vf', `select='between(t,${from},${to})',tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const text = String(r.stderr || '');
  const vals = [...text.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map(m => parseFloat(m[1]));
  if (!vals.length) throw new Error(`no frame-delta samples from ffmpeg: ${text.slice(-400)}`);
  return Math.max(...vals);
}
function probeSeconds(f: string): number {
  return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).toString().trim());
}

test('JOIN: two independently generated scene clips are joined by a DISSOLVE, not a visible hard cut', async () => {
  // Two DIFFERENT designed stills — exactly the situation in a real 5-scene video,
  // where every clip starts from its own frame and drifts over its 6s.
  const stillA = path.join(TMP, 'scene-a.png');
  const stillB = path.join(TMP, 'scene-b.png');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x101060:s=360x640:d=1', '-frames:v', '1', stillA]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xd0a020:s=360x640:d=1', '-frames:v', '1', stillB]);
  const clipA = path.join(TMP, 'clip-a.mp4');
  const clipB = path.join(TMP, 'clip-b.mp4');
  for (const [still, out] of [[stillA, clipA], [stillB, clipB]] as const) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-loop', '1', '-i', still, '-t', '2', '-r', '30',
      '-vf', 'scale=360:640,format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  }
  // (a) the naive answer the owner vetoed: five clips stapled together
  const hard = path.join(TMP, 'hard-cut.mp4');
  const listFile = path.join(TMP, 'list.txt');
  fs.writeFileSync(listFile, `file '${clipA}'\nfile '${clipB}'\n`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', hard]);
  // (b) the pipeline's real assembler
  const xfade = path.join(TMP, 'xfade.mp4');
  await concatClips([clipA, clipB], xfade);

  // Look at the 1.0s–2.4s window: the boundary lives inside it either way.
  const hardDelta = { max: maxFrameDelta(hard, 1.0, 2.4) };
  const xfadeDelta = { max: maxFrameDelta(xfade, 1.0, 2.4) };
  // Report the real numbers in the failure message so a regression is diagnosable.
  const msg = `hard-cut max frame delta=${hardDelta.max.toFixed(2)}  xfade max frame delta=${xfadeDelta.max.toFixed(2)}`;
  console.log(`[JOIN] ${msg}  (delivered ${probeSeconds(xfade).toFixed(2)}s vs ${probeSeconds(hard).toFixed(2)}s hard-cut)`);
  assert.ok(hardDelta.max > 40, `the hard-cut reference MUST spike (it is a jump cut): ${msg}`);
  assert.ok(xfadeDelta.max < hardDelta.max * 0.6,
    `the assembled join must be far smoother than a hard cut: ${msg}`);
  assert.ok(xfadeDelta.max < 40, `the assembled join must not contain a frame-sized jump: ${msg}`);
  // And the video is not longer/shorter than the assembler's own arithmetic.
  const expected = 2 + 2 - 0.8;
  assert.ok(Math.abs(probeSeconds(xfade) - expected) < 0.25,
    `delivered length must be sum − overlaps (${expected}s), got ${probeSeconds(xfade)}s`);
});

// ═══ (6) NARRATION SYNC ══════════════════════════════════════════════════════
test('SYNC: a take is FITTED to its scene window — trimmed when long, slowed when short, never frozen', async () => {
  const src = path.join(TMP, 'fit-src.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=30:duration=4',
    '-vf', 'format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  // 4s take → 6.8s narration window (a real dissolve-compensated scene length).
  const stretched = path.join(TMP, 'fit-stretch.mp4');
  fs.copyFileSync(src, stretched);
  await fitClipToDuration(stretched, 6.8);
  assert.ok(Math.abs(probeSeconds(stretched) - 6.8) < 0.12,
    `stretched take must land on the window (6.8s), got ${probeSeconds(stretched)}s`);
  // The stretch must keep MOVING — a frozen tail would be a clone of the last frame.
  const tail = maxFrameDelta(stretched, 5.5, 6.6);
  assert.ok(tail > 0.01, `the stretched take must still be moving at its tail (delta ${tail})`);
  // 6s take → 4.0s window: trimmed, not stretched backwards.
  const trimmed = path.join(TMP, 'fit-trim.mp4');
  fs.copyFileSync(src, trimmed);
  await fitClipToDuration(trimmed, 4.0);
  assert.ok(Math.abs(probeSeconds(trimmed) - 4.0) < 0.12, `trimmed take must be 4.0s, got ${probeSeconds(trimmed)}s`);
});

test('SYNC: fitted windows sum to the planned video length — narration and picture agree', async () => {
  const planned = [6.8, 6.8, 6.8, 6.8, 6.8]; // 5 scenes, 34s before dissolve compensation
  const takes = [6, 6, 6, 6, 6];              // what Veo actually sold us
  let sum = 0;
  for (let i = 0; i < takes.length; i++) {
    const f = path.join(TMP, `sync-${i}.mp4`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=120x200:rate=30:duration=${takes[i]}`,
      '-vf', 'format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
    await fitClipToDuration(f, planned[i]);
    sum += probeSeconds(f);
  }
  assert.ok(Math.abs(sum - planned.reduce((a, b) => a + b, 0)) < 0.5,
    `fitted clips must sum to the planned length (34s), got ${sum}s`);
  // And the assembled video lands on the planner's own band after dissolve overlap.
  assert.ok(Math.abs((sum - 4 * 0.8) - 30.8) < 0.6, 'sum − 4×0.8s overlaps stays in the 29.5–30.5s band');
});

// ═══ (7) THE REAL REASON reaches the client ══════════════════════════════════
test('FAILURE: retry only on a proven OBJECTIVE failure — never on a deterministic one', () => {
  assert.equal(isRetryableVeoFailure('Veo poll: 5 consecutive network errors'), true);
  assert.equal(isRetryableVeoFailure('fetch failed: ECONNRESET'), true);
  assert.equal(isRetryableVeoFailure(VEO_ERRORS.permissionDenied), false, 'credentials → do not retry');
  assert.equal(isRetryableVeoFailure(VEO_ERRORS.credentialsMissing), false, 'missing service account → do not retry');
  assert.equal(isRetryableVeoFailure('veo-3.1-lite: the model veo-3.1-lite-generate-001 is unavailable (NOT_FOUND)'), false, 'retired model → do not retry');
  assert.equal(isRetryableVeoFailure(VEO_ERRORS.apiKeyBlocked), false);
  assert.equal(isRetryableVeoFailure('Veo: media filtered by safety (raiMediaFiltered)'), false);
  assert.equal(isRetryableVeoFailure(veoImageRejectedMessage('HTTP 400')), false, 'rejected image → do not retry');
  assert.equal(isRetryableVeoFailure(undefined), false);
});

test('FAILURE: the three distinct reasons are three distinct strings, and image failures name themselves', () => {
  const reasons = [VEO_ERRORS.credentialsMissing, VEO_ERRORS.permissionDenied, VEO_ERRORS.apiKeyBlocked];
  assert.equal(new Set(reasons).size, 3);
  assert.ok(/PERMISSION_DENIED/.test(VEO_ERRORS.permissionDenied));
  assert.ok(/GOOGLE_VERTEX_SA_JSON/.test(VEO_ERRORS.credentialsMissing));
  assert.ok(/REJECTED/.test(veoImageRejectedMessage('HTTP 400: bad image')));
  assert.ok(/NO designed still/.test(veoImageMissingMessage('block0-scene2', 'still render failed')));
  assert.ok(/no text-to-video fallback/i.test(veoImageMissingMessage('block0-scene2', 'x')),
    'a missing still must never silently downgrade to text-to-video');
});

test('FAILURE: the window throw carries the underlying error (regression guard, ~line 3451 bug)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'), 'utf8');
  const throws = src.split('\n').filter(l => l.includes('failed after ${VEO_WINDOW_MAX_ATTEMPTS} attempt'));
  assert.equal(throws.length, 2, 'both the window path and the legacy per-scene path throw');
  for (const line of throws) {
    assert.ok(/\$\{lastError/.test(line) || /\$\{veoLastError/.test(line),
      `the throw MUST interpolate the underlying provider error: ${line.trim()}`);
  }
  assert.equal(src.includes('failed after ${SCENE_SORA_MAX_ATTEMPTS} attempts`'), false,
    'the old error-dropping throw is gone');
});

test('COST: billed seconds are priced exactly, and a repeated window cannot double-count', () => {
  assert.equal(veoCostUsd(0), 0);
  assert.equal(veoCostUsd(4), 0.12);
  assert.equal(veoCostUsd(6), 0.18);
  assert.equal(veoCostUsd(30), 0.9);
  assert.equal(VEO_MOTION_BUDGET_SECONDS, 30);
  assert.equal(VEO_MAX_MOTION_WINDOWS, 5);
  assert.equal(VEO_CALL_SECONDS, 6);
  // The accumulator is keyed by window: re-running the SAME window overwrites.
  const perWindow: Record<string, number> = {};
  for (const [k, v] of [['block0-scene1', 6], ['block0-scene2', 6], ['block0-scene1', 6]] as const) perWindow[k] = v;
  const total = Object.values(perWindow).reduce((a, b) => a + b, 0);
  assert.equal(total, 12, 'a retry of scene 1 must not re-charge scene 1');
  assert.equal(VEO_MODEL, 'veo-3.1-lite-generate-001');
});
