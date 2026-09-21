/**
 * VEO 3.1 LITE PRODUCTION tests (owner Sep 18 scope — Scene-only Veo, Twin-Veo
 * dropped → Twin/Faceless stay zero-video-API). Ported from the PR #87
 * owner-directed mocked-fetch suite to the PRODUCTION call sites:
 * `veoVideoService.generateSceneVideo` + the Scene planner's window budget
 * (`capVeoMotionWindows`). NO paid renders — fetch fully mocked, pollDelayMs=0.
 *
 * Contract under test (verified LIVE Sep 15–17, recorded in PR #87):
 *   (1) BODY SHAPE  — instances[0].prompt; parameters carry aspectRatio 9:16 /
 *       resolution 720p / durationSeconds / personGeneration; numberOfVideos is
 *       NEVER sent (verified zero-cost 400 — the API returns ONE sample).
 *   (2) EXACTLY-ONCE — the operation name is persisted (onOperationCreated)
 *       BEFORE the first poll; existingOperationName resumes the SAME op and
 *       NEVER re-POSTs a paid create.
 *   (3) BOTH RESULT PATHS — REST-documented Vertex-style
 *       (.response.generateVideoResponse.generatedSamples[].video) AND the
 *       SDK-style fallback (.response.generatedVideos[].video, data base64).
 *   (4) POLL RULES — 5s→10s backoff (0 in tests), sanity cap 120 (resume-safe,
 *       never abandons in_progress on elapsed time), terminal error / 404 /
 *       5 consecutive HTTP errors abort; raiMediaFiltered is a hard error.
 *   (5) DOWNLOADS — signed https uri (fetched with x-goog-api-key) OR inline
 *       base64; a raw gs:// uri is a HARD error (never silently saved).
 *   (6) SCENE BUDGET — capVeoMotionWindows keeps ≤2 windows per project
 *       (VEO_MOTION_BUDGET_SECONDS 12 = 2×6s ≈ $0.60) and deterministically
 *       demotes over-budget motion scenes back to stills so plan + spans agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  VeoVideoService,
  buildVeoPredictBody,
  parseVeoOperationName,
  parseVeoOperation,
  extractVeoVideoPayload,
  buildVeoCreateUrl,
  buildVeoPollUrl,
  VEO_MODEL,
  VEO_PROVIDER_TAG,
  VEO_CALL_SECONDS,
  VEO_MOTION_BUDGET_SECONDS,
  VEO_ASPECT_RATIO,
  VEO_RESOLUTION,
  VEO_PERSON_GENERATION,
  VEO_POLL_MAX_ATTEMPTS,
} from '../veoVideoService.js';
import { capVeoMotionWindows, planMotionWindows, type SceneScript, type SoraSpan, type MotionWindow } from '../sceneVideoPipelineService.js';

function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

interface CapturedCall { url: string; method: string; body?: any; headers?: any; }
interface MockOpts {
  inProgressPolls?: number;       // poll returns done=false this many times, then done=true
  pollShape?: 'rest' | 'sdk' | 'error' | 'rai' | 'no-payload'; // result shape once done
  failPollOp?: string;            // this op returns a terminal done.error
  errorStatus?: number;           // every poll returns this HTTP status (consecutive-error test)
  alwaysInProgress?: boolean;     // sanity-cap test: never done
  trace?: (event: string) => void; // order-observability: 'poll' fired on every poll fetch
}
function installMock(opts: MockOpts = {}) {
  const calls: CapturedCall[] = [];
  const pollCounts: Record<string, number> = {};
  let createN = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const headers = init?.headers || {};
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body, headers });
    // CREATE: POST .../models/{model}:predictLongRunning
    if (method === 'POST' && url.endsWith(':predictLongRunning')) {
      createN += 1;
      return jsonResp({ name: `operations/veo-${createN}` });
    }
    // POLL: GET .../v1beta/operations/{name}
    if (method === 'GET' && url.includes('/operations/')) {
      if (opts.trace) opts.trace('poll');
      const op = url.split('/operations/')[1];
      if (opts.alwaysInProgress) return jsonResp({ name: `operations/${op}`, done: false });
      if (op === opts.failPollOp) return jsonResp({ name: `operations/${op}`, done: true, error: { code: 13, message: 'INTERNAL failure' } });
      if (opts.errorStatus) return new Response('upstream blown', { status: opts.errorStatus });
      const n = (pollCounts[op] || 0) + 1;
      pollCounts[op] = n;
      if (n <= (opts.inProgressPolls || 0)) return jsonResp({ name: `operations/${op}`, done: false });
      const shape = opts.pollShape || 'rest';
      if (shape === 'rest') {
        return jsonResp({ name: `operations/${op}`, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/veo-signed/abc.mp4?X-Goog-Signature=t' } }] } } });
      }
      if (shape === 'sdk') {
        return jsonResp({ name: `operations/${op}`, done: true, response: { generatedVideos: [{ video: { data: Buffer.from('hello-veo').toString('base64') } }] } });
      }
      if (shape === 'error') return jsonResp({ name: `operations/${op}`, done: true, error: { code: 13, message: 'internal' } });
      if (shape === 'rai') return jsonResp({ name: `operations/${op}`, done: true, response: { generateVideoResponse: { raiMediaFiltered: true } } });
      return jsonResp({ name: `operations/${op}`, done: true, response: {} }); // 'no-payload'
    }
    // DOWNLOAD: signed https storage uri
    if (url.startsWith('https://storage.googleapis.com/')) {
      return new Response(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34]), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    createCount: () => calls.filter(c => c.method === 'POST' && c.url.endsWith(':predictLongRunning')).length,
    pollCount: () => calls.filter(c => c.method === 'GET' && c.url.includes('/operations/')).length,
    createBody: () => calls.find(c => c.method === 'POST' && c.url.endsWith(':predictLongRunning'))?.body,
    createHeaders: () => calls.find(c => c.method === 'POST' && c.url.endsWith(':predictLongRunning'))?.headers,
    downloadCalls: () => calls.filter(c => c.url.startsWith('https://storage.googleapis.com/')),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

/** Fresh service with 0ms poll cadence — tests never touch the real API. */
function svc(): VeoVideoService {
  const s = new VeoVideoService();
  s.pollDelayMs = 0;
  return s;
}

function cleanup(paths: Array<string | undefined>) {
  for (const p of paths) {
    if (p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
}

// ─── (1) BODY SHAPE ───────────────────────────────────────────────────────────
test('BODY: instances[0].prompt + parameters 9:16/720p/6s/allow_all — numberOfVideos NEVER sent', () => {
  const body = buildVeoPredictBody('a hero transformation', {
    aspectRatio: VEO_ASPECT_RATIO,
    resolution: VEO_RESOLUTION,
    durationSeconds: VEO_CALL_SECONDS,
    personGeneration: VEO_PERSON_GENERATION,
  }) as any;
  assert.equal(body.instances[0].prompt, 'a hero transformation');
  assert.equal(body.parameters.aspectRatio, '9:16');
  assert.equal(body.parameters.resolution, '720p');
  assert.equal(body.parameters.durationSeconds, 6);
  assert.equal(body.parameters.personGeneration, 'allow_all');
  assert.equal('numberOfVideos' in body, false, 'numberOfVideos omitted (verified zero-cost 400)');
  assert.equal('numberOfVideos' in (body.parameters ?? {}), false);
});

test('BODY: no options → no parameters key at all (lean default body)', () => {
  const body = buildVeoPredictBody('plain') as any;
  assert.equal(body.instances[0].prompt, 'plain');
  assert.equal('parameters' in body, false);
});

test('BODY: create POST hits the LITE model with x-goog-api-key', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'test-key', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    assert.ok(String(mock.calls[0].url).endsWith(`models/${VEO_MODEL}:predictLongRunning`), 'LITE model only ($0.05/s)');
    assert.equal(mock.createHeaders()['x-goog-api-key'], 'test-key');
    assert.equal(mock.createHeaders()['Content-Type'], 'application/json');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

// ─── operation-name parsing ───────────────────────────────────────────────────
test('parseVeoOperationName: valid name accepted, missing name throws', () => {
  assert.equal(parseVeoOperationName({ name: 'operations/veo-9' }), 'operations/veo-9');
  assert.throws(() => parseVeoOperationName({}), /missing operation name/i);
  assert.throws(() => parseVeoOperationName({ name: '' }), /missing operation name/i);
});

// ─── (3) BOTH RESULT PATHS ────────────────────────────────────────────────────
test('RESULT PATH (REST): .response.generateVideoResponse.generatedSamples[].video.uri', () => {
  const r = parseVeoOperation({
    done: true,
    response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://signed/1.mp4' } }] } },
  });
  assert.equal(r.done, true);
  assert.deepEqual(r.video, { uri: 'https://signed/1.mp4' });
});

test('RESULT PATH (SDK fallback): .response.generatedVideos[].video.data (inline base64)', () => {
  const r = parseVeoOperation({ done: true, response: { generatedVideos: [{ video: { data: 'aGVsbG8=' } }] } });
  assert.equal(r.done, true);
  assert.deepEqual(r.video, { data: 'aGVsbG8=' });
});

test('parseVeoOperation: in_progress → done:false; terminal error → done:true+error; raiMediaFiltered → error; done with no payload → error', () => {
  assert.deepEqual(parseVeoOperation({ done: false }), { done: false });
  assert.deepEqual(parseVeoOperation(null), { done: false });
  const err = parseVeoOperation({ done: true, error: { code: 13, message: 'boom' } });
  assert.equal(err.done, true); assert.ok(String(err.error).includes('boom'));
  const rai = parseVeoOperation({ done: true, response: { generateVideoResponse: { raiMediaFiltered: true } } });
  assert.equal(rai.done, true); assert.ok(String(rai.error).includes('raiMediaFiltered'));
  const nop = parseVeoOperation({ done: true, response: {} });
  assert.equal(nop.done, true); assert.ok(String(nop.error).includes('no video payload'));
});

test('extractVeoVideoPayload: uri, data, videoBytes, inlineData.data all normalized', () => {
  assert.deepEqual(extractVeoVideoPayload({ uri: 'u' }), { uri: 'u' });
  assert.deepEqual(extractVeoVideoPayload({ data: 'x' }), { data: 'x' });
  assert.deepEqual(extractVeoVideoPayload({ videoBytes: 'y' }), { data: 'y' });
  assert.deepEqual(extractVeoVideoPayload({ inlineData: { data: 'z' } }), { data: 'z' });
  assert.equal(extractVeoVideoPayload({}), undefined);
  assert.equal(extractVeoVideoPayload(undefined), undefined);
});

// ─── (2) EXACTLY-ONCE ─────────────────────────────────────────────────────────
test('EXACTLY-ONCE: onOperationCreated fires BEFORE the first poll (order persisted → resume-safe)', async () => {
  const timeline: string[] = [];
  const mock = installMock({ inProgressPolls: 1, trace: (e) => timeline.push(e) });
  try {
    const result = await svc().generateSceneVideo({
      prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k',
      onOperationCreated: async (op) => { timeline.push(`created:${op}`); },
    });
    assert.ok(result.success, result.error);
    assert.equal(result.operationName, 'operations/veo-1');
    const createdIdx = timeline.findIndex(t => t === 'created:operations/veo-1');
    const pollIdx = timeline.findIndex(t => t === 'poll');
    assert.ok(createdIdx >= 0, 'onOperationCreated called');
    assert.ok(pollIdx >= 0, 'poll observed');
    assert.ok(createdIdx < pollIdx, 'operation name persisted BEFORE any polling');
    assert.equal(mock.createCount(), 1);
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('EXACTLY-ONCE resume: existingOperationName → ZERO create POSTs, polls resume the SAME op', async () => {
  const mock = installMock();
  const created: string[] = [];
  try {
    const result = await svc().generateSceneVideo({
      prompt: 'resume me', sceneKey: 'block0-scene1', apiKey: 'k',
      existingOperationName: 'operations/veo-77',
      onOperationCreated: async (op) => { created.push(op); },
    });
    assert.ok(result.success, result.error);
    assert.equal(mock.createCount(), 0, 'no re-POST when an operation is already known — never duplicate billing');
    assert.equal(result.operationName, 'operations/veo-77', 'result carries the resumed op');
    const polls = mock.calls.filter(c => c.method === 'GET' && c.url.includes('/operations/'));
    assert.ok(polls.length >= 1);
    assert.ok(polls.every(c => c.url.includes('/operations/veo-77')), 'every poll targets the persisted op');
    assert.equal(created.length, 0, 'resume path does NOT re-report a created op');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('EXACTLY-ONCE: sanity cap while in_progress returns failure WITH the op name (caller persists + resumes, never gives up)', async () => {
  const mock = installMock({ alwaysInProgress: true });
  try {
    const result = await svc().generateSceneVideo({
      prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k',
      onOperationCreated: async () => {},
    });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('sanity cap exceeded'), `error=${result.error}`);
    assert.equal(result.operationName, 'operations/veo-1', 'op returned so the caller can persist + resume exactly-once');
    assert.equal(mock.createCount(), 1, 'exactly one paid create');
    assert.equal(mock.pollCount(), VEO_POLL_MAX_ATTEMPTS, 'polled the full sanity cap, never abandoned on elapsed time');
  } finally { mock.restore(); }
});

// ─── (4) POLL RULES ───────────────────────────────────────────────────────────
test('POLL: in_progress → done transition polls exactly inProgressPolls+1 times', async () => {
  const mock = installMock({ inProgressPolls: 2 });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    assert.equal(mock.pollCount(), 3, '2 in_progress polls + 1 done poll');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('POLL: terminal error aborts with the op error surfaced', async () => {
  const mock = installMock({ failPollOp: 'veo-1' });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('INTERNAL'), result.error);
    assert.equal(result.operationName, 'operations/veo-1');
  } finally { mock.restore(); }
});

test('POLL: 404 aborts immediately — operation not found', async () => {
  const originalFetch = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({ url: String(input), method: (init?.method || 'GET').toUpperCase() });
    if (String(input).endsWith(':predictLongRunning')) return jsonResp({ name: 'operations/veo-404' });
    return new Response('gone', { status: 404 });
  }) as typeof fetch;
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('404'), result.error);
    assert.equal(calls.filter(c => c.method === 'GET').length, 1, 'aborts on the FIRST 404 — no more polling');
  } finally { globalThis.fetch = originalFetch; }
});

test('POLL: 5 consecutive HTTP errors abort (never infinite)', async () => {
  const mock = installMock({ errorStatus: 500 });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('5 consecutive HTTP errors'), result.error);
    assert.equal(mock.pollCount(), 5);
  } finally { mock.restore(); }
});

// ─── create failure ───────────────────────────────────────────────────────────
test('CREATE: HTTP 400 surfaces the body snippet and never polls', async () => {
  const originalFetch = globalThis.fetch;
  const polls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).endsWith(':predictLongRunning')) return new Response('numberOfVideos not allowed', { status: 400 });
    polls.push(String(input));
    return jsonResp({});
  }) as typeof fetch;
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('400'), result.error);
    assert.ok(String(result.error).includes('numberOfVideos'), 'the 0-cost 400 trap is loud, not silent');
    assert.equal(polls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('MISSING KEY: no env, no apiKey → error BEFORE any fetch', async () => {
  const prevA = process.env.GOOGLE_API_KEY, prevB = process.env.GOOGLE_STUDIO_API_KEY;
  delete process.env.GOOGLE_API_KEY; delete process.env.GOOGLE_STUDIO_API_KEY;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; return jsonResp({}); }) as typeof fetch;
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('not configured'), result.error);
    assert.equal(fetchCalls, 0);
  } finally {
    if (prevA !== undefined) process.env.GOOGLE_API_KEY = prevA;
    if (prevB !== undefined) process.env.GOOGLE_STUDIO_API_KEY = prevB;
    else { delete process.env.GOOGLE_API_KEY; delete process.env.GOOGLE_STUDIO_API_KEY; }
    globalThis.fetch = originalFetch;
  }
});

// ─── (5) DOWNLOADS ────────────────────────────────────────────────────────────
test('DOWNLOAD: signed https uri fetched with x-goog-api-key, bytes written to temp/veo', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'download-key', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    const dl = mock.downloadCalls();
    assert.equal(dl.length, 1);
    assert.equal(dl[0].headers['x-goog-api-key'], 'download-key', 'signed URI still needs the API key header');
    assert.ok(result.videoPath && result.videoPath.includes(path.join('temp', 'veo')), result.videoPath);
    assert.ok(fs.existsSync(result.videoPath!), 'local file exists');
    assert.equal(result.billedSeconds, 6, 'default billed = one 6s enum call');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('DOWNLOAD: inline base64 (SDK path) written without any video fetch', async () => {
  const mock = installMock({ pollShape: 'sdk' });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    assert.equal(mock.downloadCalls().length, 0, 'no network download for inline data');
    const bytes = fs.readFileSync(result.videoPath!);
    assert.equal(bytes.toString(), 'hello-veo', 'file content == decoded base64');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('DOWNLOAD: raw gs:// uri is a HARD error (never a silent zero-byte file)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith(':predictLongRunning')) return jsonResp({ name: 'operations/veo-gs' });
    if (url.includes('/operations/')) return jsonResp({ name: 'operations/veo-gs', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'gs://bucket/clip.mp4' } }] } } });
    return jsonResp({});
  }) as typeof fetch;
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('gs://'), result.error);
  } finally { globalThis.fetch = originalFetch; }
});

test('durationSeconds override flows into the body AND billedSeconds', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', apiKey: 'k', durationSeconds: 4, onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    assert.equal(mock.createBody().parameters.durationSeconds, 4, '4s enum honored in the POST body');
    assert.equal(result.billedSeconds, 4);
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

// ─── constants lock the owner-approved cost model ────────────────────────────
test('CONSTANTS: lite model ($0.05/s), 6s enum, 12s Scene motion budget ≈ $0.60', () => {
  assert.equal(VEO_MODEL, 'veo-3.1-lite-generate-preview', 'the TRUE Lite code — never the $0.40 standard tier');
  assert.equal(VEO_PROVIDER_TAG, 'veo-3.1-lite');
  assert.equal(VEO_CALL_SECONDS, 6, 'enum 4|6|8 — production uses one 6s take per window');
  assert.equal(VEO_MOTION_BUDGET_SECONDS, 12, '2×6s = 12s motion ≈ $0.60 for a 30s Scene video');
  assert.equal(VEO_ASPECT_RATIO, '9:16');
  assert.equal(VEO_RESOLUTION, '720p');
  assert.equal(VEO_PERSON_GENERATION, 'allow_all');
  assert.equal(VEO_POLL_MAX_ATTEMPTS, 120, 'sanity cap only — never an elapsed-time abandon');
});

// ─── (6) Scene planner call site: capVeoMotionWindows ────────────────────────
const motion = (n: number, prompt: string, duration = 6): SceneScript => ({
  sceneNumber: n, duration, visualType: 'motion', narration: `N ${n}.`, visualPrompt: prompt, soraBlock: 0,
});

function threeWindowSpans(): SoraSpan[] {
  const script = [motion(2, 'hook'), motion(3, 'about'), motion(4, 'CTA')];
  const windows = planMotionWindows(script);
  return [{ soraBlock: 0, sceneNumbers: [2, 3, 4], totalSeconds: windows.reduce((a, w) => a + w.motionSeconds, 0), windows, prompt: 'one take' }];
}

test('CAP: 3 motion windows capped to 2 kept (12s budget) — 3rd scene demoted to still, soraBlock cleared', () => {
  const script = [motion(2, 'hook'), motion(3, 'about'), motion(4, 'CTA')];
  const spans = threeWindowSpans();
  const { script: s2, spans: sp2 } = capVeoMotionWindows(script, spans);
  assert.equal(sp2.length, 1, 'span survives (still has kept windows)');
  assert.equal(sp2[0].windows.length, 2, 'windows capped to 2 (2×6s = 12s = $0.60)');
  assert.deepEqual(sp2[0].sceneNumbers, [2, 3], 'front windows kept — END of the run demoted first');
  assert.equal(sp2[0].totalSeconds, sp2[0].windows.reduce((a, w) => a + w.motionSeconds, 0), 'totalSeconds recomputed to the kept windows');
  assert.equal(s2.filter(s => s.visualType === 'motion').length, 2);
  const demoted = s2.find(s => s.sceneNumber === 4)!;
  assert.equal(demoted.visualType, 'still', 'over-budget scene demoted to still');
  assert.equal(demoted.soraBlock, undefined, 'demoted scene no longer claims a Veo block');
  assert.equal(s2.reduce((a, s) => a + s.duration, 0), 18, 'time budget preserved');
});

test('CAP: empty spans → untouched; determinism (same input → same output twice)', () => {
  const script = [motion(1, 'hook'), motion(2, 'about'), motion(3, 'CTA')];
  const untouched = capVeoMotionWindows(script, []);
  assert.deepEqual(untouched.script, script);
  assert.deepEqual(untouched.spans, []);
  const spans = [{ soraBlock: 0, sceneNumbers: [1, 2, 3], totalSeconds: 15, windows: [ { sceneNumber: 1, motionStartSeconds: 0, motionSeconds: 5 }, { sceneNumber: 2, motionStartSeconds: 5, motionSeconds: 5 }, { sceneNumber: 3, motionStartSeconds: 10, motionSeconds: 5 } ] as MotionWindow[], prompt: 't' }];
  const a = capVeoMotionWindows(script, spans, 1);
  const b = capVeoMotionWindows(script, spans, 1);
  assert.equal(a.spans[0].windows.length, 1);
  assert.equal(b.spans[0].windows.length, 1);
  assert.deepEqual(a.script.map(s => s.visualType), b.script.map(s => s.visualType), 'deterministic demotion');
  assert.deepEqual(a.script.map(s => s.visualType), ['motion', 'still', 'still'], 'explicit maxWindows=1 keeps the front window only');
});

// Clean any local Veo test take files written by this suite (temp/veo).
const veoTmpDir = path.join(process.cwd(), 'temp', 'veo');
try {
  for (const f of fs.readdirSync(veoTmpDir)) {
    if (f.endsWith('.mp4') && /^block0-scene/.test(f)) { try { fs.unlinkSync(path.join(veoTmpDir, f)); } catch { /* ignore */ } }
  }
} catch { /* ignore */ }