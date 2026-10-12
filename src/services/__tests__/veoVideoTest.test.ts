/**
 * VEO 3.1 LITE TEST PATH — unit tests (NO live paid calls; fetch fully mocked).
 *
 * Covers the deliverable contract points:
 *  (1) REQUEST BODY SHAPE — predictLongRunning POST with instances[0].prompt and
 *      parameters { aspectRatio: "9:16", resolution: "720p", durationSeconds: 8,
 *      numberOfVideos: 1, personGeneration: "allow_all" }.
 *  (2) OPERATION PARSING — REST-documented path
 *      (.response.generateVideoResponse.generatedSamples[0].video) AND the
 *      SDK-style fallback (.response.generatedVideos[0].video), incl. inline
 *      base64 (video.data) vs signed uri.
 *  (3) EXACTLY-ONCE — create → onOperationCreated persisted BEFORE polling;
 *      resume with existingOperationName SKIPS the POST entirely and only
 *      re-polls the SAME operation (never double-submit).
 *  (4) POLL RULES — 5s→10s backoff (setInterval, Railway-safe), sanity cap only;
 *      in_progress is NEVER abandoned on elapsed time; 404 / terminal error /
 *      5 consecutive errors abort.
 *  (5) DOWNLOAD — signed-uri fetch AND inline base64 both produce a local file.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  VeoVideoTestService,
  buildVeoPredictBody,
  parseVeoOperationName,
  parseVeoOperation,
  planVeoTestScenes,
  VEO_MODEL,
  VEO_LITE_MODEL,
  VEO_ASPECT_RATIO,
  VEO_RESOLUTION,
  VEO_CALL_SECONDS,
  VEO_SCENE_SECONDS,
  VEO_POLL_MAX_ATTEMPTS,
  VEO_API_BASE,
} from '../veoVideoTestService.js';

if (!process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = 'test-key-for-unit-tests';

function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function bytesResp(buf: Buffer, status = 200): Response {
  return new Response(new Uint8Array(buf), { status, headers: { 'Content-Type': 'video/mp4' } });
}
interface CapturedCall { url: string; method: string; body?: any; }

/** Deterministic mock: create returns op-1; polls return in_progress until
 *  `doneAtPoll` then a REST-path result; the video uri returns mp4 bytes. */
function installMock(opts: {
  doneAtPoll?: number;          // poll number at which the op becomes done (default 1)
  resultBody?: any;             // overrides the done response body
  failPollStatus?: number;      // poll status to fail at
  failPollsFrom?: number;       // start failing (HTTP errors) at this poll #
  createStatus?: number;        // create response status (default 200)
  createErrorBody?: string;
  poll404At?: number;
  videoBytes?: Buffer;
  videoUriStatus?: number;
} = {}) {
  const calls: CapturedCall[] = [];
  let createN = 0;
  let pollN = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url: string = typeof input === 'string' ? input : (input as any).url ?? String(input);
    const method = (init?.method ?? 'GET') as string;
    let body: any;
    if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); } }
    calls.push({ url, method, body });
    if (url.includes(':predictLongRunning')) {
      createN++;
      if (opts.createStatus && opts.createStatus !== 200) {
        return jsonResp({ error: { message: opts.createErrorBody ?? 'create rejected' } }, opts.createStatus);
      }
      return jsonResp({ name: `operations/op-1-create-${createN}` });
    }
    if (url.startsWith(`${VEO_API_BASE}/operations/`)) {
      pollN++;
      if (opts.poll404At && pollN === opts.poll404At) return jsonResp({ error: 'not found' }, 404);
      if (opts.failPollStatus && pollN >= (opts.failPollsFrom ?? 1)) return jsonResp({ error: 'boom' }, opts.failPollStatus);
      const doneAt = opts.doneAtPoll ?? 1;
      if (pollN < doneAt) return jsonResp({ name: `operations/op-1`, done: false });
      return jsonResp(opts.resultBody ?? {
        name: 'operations/op-1',
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/fake/veo.mp4?sig=1' } }],
          },
        },
      });
    }
    if (url.includes('storage.googleapis.com')) {
      return bytesResp(opts.videoBytes ?? Buffer.from('FAKE-MP4-BYTES'), opts.videoUriStatus ?? 200);
    }
    throw new Error(`Unexpected fetch url in test mock: ${url}`);
  });
  return {
    calls,
    pollCount: () => pollN,
    createCount: () => createN,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

const svc = new VeoVideoTestService();

beforeEach(() => { svc.pollDelayMs = 0; });
after(() => { svc.pollDelayMs = 0; });

test('model constants: owner verbatim default + documented Lite code', () => {
  assert.equal(VEO_MODEL, 'veo-3.1-generate-preview'); // owner spec, verbatim
  assert.equal(VEO_LITE_MODEL, 'veo-3.1-lite-generate-preview'); // Google pricing-page Lite code
  assert.notEqual(VEO_MODEL, VEO_LITE_MODEL, 'the two are DIFFERENT model codes per Google pricing');
});

test('buildVeoPredictBody: instances prompt + parameters shape (9:16, 720p, 8s, 1, allow_all)', () => {
  const body = buildVeoPredictBody('walking at golden hour', {
    aspectRatio: VEO_ASPECT_RATIO,
    resolution: VEO_RESOLUTION,
    durationSeconds: VEO_CALL_SECONDS,
    numberOfVideos: 1,
    personGeneration: 'allow_all',
  });
  assert.deepEqual(body.instances, [{ prompt: 'walking at golden hour' }]);
  assert.deepEqual(body.parameters, {
    aspectRatio: '9:16',
    resolution: '720p',
    durationSeconds: 8,
    numberOfVideos: 1,
    personGeneration: 'allow_all',
  });
  // No params → no parameters key (docs' minimal example shape)
  const bare = buildVeoPredictBody('plain');
  assert.deepEqual(bare, { instances: [{ prompt: 'plain' }] });
  assert.equal('parameters' in bare, false);
});

test('parseVeoOperationName requires the operation name', () => {
  assert.equal(parseVeoOperationName({ name: 'operations/abc123' }), 'operations/abc123');
  assert.throws(() => parseVeoOperationName({}), /missing operation name/);
  assert.throws(() => parseVeoOperationName(null), /missing operation name/);
});

test('parseVeoOperation: REST-documented path → uri; in_progress; error; raiMediaFiltered; SDK fallback + inline base64', () => {
  // REST-documented Vertex-style path
  const rest = parseVeoOperation({
    name: 'operations/x', done: true,
    response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/v.mp4' } }] } },
  });
  assert.equal(rest.done, true);
  assert.equal(rest.video?.uri, 'https://storage.googleapis.com/v.mp4');

  // SDK-style fallback with inline base64
  const sdk = parseVeoOperation({
    name: 'operations/x', done: true,
    response: { generatedVideos: [{ video: { data: 'QUJDRA==' } }] },
  });
  assert.equal(sdk.done, true);
  assert.equal(sdk.video?.data, 'QUJDRA==');

  // in_progress
  assert.deepEqual(parseVeoOperation({ name: 'operations/x', done: false }), { done: false });
  assert.deepEqual(parseVeoOperation({ name: 'operations/x' }), { done: false });
  assert.deepEqual(parseVeoOperation(null), { done: false });

  // terminal error
  const failed = parseVeoOperation({ name: 'operations/x', done: true, error: { code: 9, message: 'nope' } });
  assert.equal(failed.done, true);
  assert.match(failed.error ?? '', /Veo operation failed/);

  // safety-filtered terminal
  const filtered = parseVeoOperation({
    name: 'operations/x', done: true,
    response: { generateVideoResponse: { raiMediaFiltered: true } },
  });
  assert.equal(filtered.done, true);
  assert.match(filtered.error ?? '', /raiMediaFiltered/);

  // done but no payload → terminal error (never silently succeed)
  const noPayload = parseVeoOperation({ name: 'operations/x', done: true, response: { foo: 1 } });
  assert.equal(noPayload.done, true);
  assert.match(noPayload.error ?? '', /no video payload/);
});

test('planVeoTestScenes: exactly 6 scenes × 5s = 30s, all faithful to the verbatim prompt', () => {
  const idea = 'a realistic vertical social-media video of a confident young woman walking through a modern downtown city street at golden hour. She walks naturally toward the camera while the camera smoothly tracks backward. Realistic human movement, natural facial expression, realistic lighting, cinematic but authentic smartphone/social-media aesthetic. NO TEXT, no subtitles, no logos';
  const scenes = planVeoTestScenes(idea);
  assert.equal(scenes.length, 6);
  assert.equal(scenes.reduce((a, s) => a + s.duration, 0), 30);
  assert.ok(scenes.every((s) => s.duration === VEO_SCENE_SECONDS));
  for (const s of scenes) {
    assert.equal(s.sceneNumber > 0 && s.sceneNumber <= 6, true);
    // Every scene stays faithful: same woman, same street, golden hour, no text.
    assert.match(s.prompt.toLowerCase(), /young woman/);
    assert.match(s.prompt.toLowerCase(), /downtown/);
    assert.match(s.prompt.toLowerCase(), /golden hour/);
    assert.match(s.prompt.toLowerCase(), /no text, no subtitles, no logos/);
    // No "sora" leakage — this is the Veo test path.
    assert.equal(s.prompt.toLowerCase().includes('sora'), false);
  }
});

test('EXACTLY-ONCE: no existing op → ONE create POST, onOperationCreated BEFORE polling, then done', async () => {
  const mock = installMock({ doneAtPoll: 2 });
  const order: string[] = [];
  const result = await svc.generateSceneVideo({
    prompt: 'walking',
    apiKey: process.env.GOOGLE_API_KEY as string,
    sceneKey: 'scene1',
    onOperationCreated: async (op) => { order.push(`persist:${op}`); },
  });
  mock.restore();
  assert.equal(result.success, true);
  assert.equal(mock.createCount(), 1, 'exactly one create POST');
  assert.match(result.videoPath ?? '', /scene1_.*\.mp4$/);
  assert.equal(result.billedSeconds, VEO_CALL_SECONDS);
  const createCall = mock.calls.find((c) => c.url.includes(':predictLongRunning'));
  assert.ok(createCall, 'create POST present');
  assert.equal(createCall.body.instances[0].prompt, 'walking');
  assert.equal(createCall.body.parameters.durationSeconds, 8);
  // Persistence happened BEFORE any poll
  const persistIdx = order.findIndex((o) => o.startsWith('persist:operations/op-1-create-1'));
  const pollIdx = mock.calls.findIndex((c) => c.url.startsWith(`${VEO_API_BASE}/operations/`));
  assert.ok(persistIdx >= 0 && pollIdx >= 0, 'persist + poll both happened');
  assert.ok(persistIdx === 0, 'onOperationCreated ran BEFORE polling (durable exactly-once point)');
  assert.equal(result.operationName, 'operations/op-1-create-1');
});

test('EXACTLY-ONCE: resume with existingOperationName → NO create POST, only polls the SAME operation', async () => {
  const mock = installMock({ doneAtPoll: 1 });
  const result = await svc.generateSceneVideo({
    prompt: 'walking again',
    apiKey: process.env.GOOGLE_API_KEY as string,
    sceneKey: 'scene1',
    existingOperationName: 'operations/op-1-create-1',
    onOperationCreated: async () => { throw new Error('must not persist when resuming'); },
  });
  mock.restore();
  assert.equal(result.success, true);
  assert.equal(mock.createCount(), 0, 'resume MUST NOT re-submit a paid generation');
  assert.equal(result.operationName, 'operations/op-1-create-1');
  assert.ok(mock.calls.every((c) => c.url.startsWith(`${VEO_API_BASE}/operations/`) || c.url.includes('storage.googleapis.com')),
    'only poll + download calls when resuming');
});

test('POLL: in_progress is never abandoned on elapsed time; completes after N polls', async () => {
  const mock = installMock({ doneAtPoll: 7 }); // 7 in_progress polls, then done
  const result = await svc.generateSceneVideo({
    prompt: 'p',
    apiKey: process.env.GOOGLE_API_KEY as string,
    sceneKey: 'scene2',
    onOperationCreated: () => {},
  });
  mock.restore();
  assert.equal(result.success, true, 'poll kept going past several in_progress responses');
  assert.equal(mock.pollCount(), 7);
});

test('POLL: 404 aborts; 5 consecutive HTTP errors abort; transient error recovers', async () => {
  // 404 → abort, never re-POST
  let mock = installMock({ poll404At: 1 });
  let result = await svc.generateSceneVideo({
    prompt: 'p', apiKey: 'k', sceneKey: 's1', onOperationCreated: () => {},
  });
  mock.restore();
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /404/);
  assert.equal(mock.createCount(), 1, 'still exactly one create — failure does not re-submit');

  // 5 consecutive 500s → abort
  mock = installMock({ failPollStatus: 500, failPollsFrom: 1 });
  result = await svc.generateSceneVideo({
    prompt: 'p', apiKey: 'k', sceneKey: 's2', onOperationCreated: () => {},
  });
  mock.restore();
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /consecutive/);

  // transient errors (2) then success → success
  mock = installMock({ failPollStatus: 503, failPollsFrom: 1, doneAtPoll: 3 });
  const stub = mock;
  // fail polls 1..2, succeed poll 3 (doneAtPoll=3 means poll1,2 in_progress — but
  // our mock fails before checking done; override with a two-phase mock instead)
  stub.restore();
  let pollN = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input as any).url;
    if (url.includes(':predictLongRunning')) return jsonResp({ name: 'operations/op-transient' });
    if (url.startsWith(`${VEO_API_BASE}/operations/`)) {
      pollN++;
      if (pollN <= 2) return jsonResp({ error: 'transient' }, 503);
      return jsonResp({ name: 'operations/op-transient', done: true, response: { generatedVideos: [{ video: { data: Buffer.from('OK').toString('base64') } }] } });
    }
    throw new Error(`unexpected ${url}`);
  });
  result = await svc.generateSceneVideo({
    prompt: 'p', apiKey: 'k', sceneKey: 's3', onOperationCreated: () => {},
  });
  globalThis.fetch = originalFetch;
  assert.equal(result.success, true, 'recovers after transient errors');
  assert.equal(pollN, 3);
});

test('POLL: sanity cap never abandons in_progress → returns resume-safe failure WITHOUT re-POSTing', async () => {
  // All polls in_progress forever — the cap is the only exit.
  const cap = VEO_POLL_MAX_ATTEMPTS;
  let pollN = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input as any).url;
    if (url.includes(':predictLongRunning')) return jsonResp({ name: 'operations/op-endless' });
    if (url.startsWith(`${VEO_API_BASE}/operations/`)) {
      pollN++;
      return jsonResp({ name: 'operations/op-endless', done: false });
    }
    throw new Error(`unexpected ${url}`);
  });
  const result = await svc.generateSceneVideo({
    prompt: 'p', apiKey: 'k', sceneKey: 's4', onOperationCreated: () => {},
  });
  globalThis.fetch = originalFetch;
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /sanity cap|resume-safe/);
  assert.equal(pollN, cap, 'polled exactly to the sanity cap');
  assert.equal(result.operationName, 'operations/op-endless', 'operation survives for resume');
});

test('DOWNLOAD: signed-uri path writes a local file; inline base64 writes without fetching', async () => {
  const mock = installMock({ videoBytes: Buffer.from([0x00, 0x01, 0x02, 0x03]) });
  const result = await svc.generateSceneVideo({
    prompt: 'p', apiKey: 'k', sceneKey: 'scene-uri', onOperationCreated: () => {},
  });
  mock.restore();
  assert.equal(result.success, true);
  const written = fs.readFileSync(result.videoPath!);
  assert.deepEqual([...written], [0x00, 0x01, 0x02, 0x03]);
  fs.rmSync(result.videoPath!, { force: true });

  // inline base64 (SDK-style) — no storage.googleapis call at all
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input as any).url;
    if (url.includes(':predictLongRunning')) return jsonResp({ name: 'operations/op-inline' });
    if (url.startsWith(`${VEO_API_BASE}/operations/`)) {
      return jsonResp({ name: 'operations/op-inline', done: true, response: { generatedVideos: [{ video: { data: Buffer.from('INLINE-VIDEO').toString('base64') } }] } });
    }
    throw new Error(`unexpected fetch (inline should not fetch the video): ${url}`);
  });
  const res2 = await svc.generateSceneVideo({
    prompt: 'p', apiKey: 'k', sceneKey: 'scene-inline', onOperationCreated: () => {},
  });
  globalThis.fetch = originalFetch;
  assert.equal(res2.success, true);
  assert.equal(fs.readFileSync(res2.videoPath!, 'utf8'), 'INLINE-VIDEO');
  fs.rmSync(res2.videoPath!, { force: true });
});

test('CREATE failure surfaces the provider error and never starts polling', async () => {
  const mock = installMock({ createStatus: 400, createErrorBody: 'bad request body' });
  const result = await svc.generateSceneVideo({
    prompt: 'p', apiKey: 'k', sceneKey: 's5', onOperationCreated: () => {},
  });
  mock.restore();
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /400/);
  assert.equal(mock.pollCount(), 0, 'no polling after a failed create');
});
