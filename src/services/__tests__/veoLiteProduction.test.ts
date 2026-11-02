/**
 * VEO 3.1 LITE — VERTEX TRANSPORT tests.
 *
 * HISTORY (why this file exists in this shape): the service used to talk to the
 * Gemini AI Studio key endpoint (`generativelanguage.googleapis.com/v1beta`,
 * header `x-goog-api-key`, model `veo-3.1-lite-generate-preview`). Google retired
 * Veo 3.1 from that endpoint, so every motion call 404'd and a client's video
 * silently lost its motion. The transport is now Vertex AI (service-account
 * OAuth, `predictLongRunning` + `fetchPredictOperation`). These tests pin the
 * Vertex door so a regression back to the retired one FAILS THE SUITE.
 *
 * NO PAID RENDERS: fetch is fully mocked (token endpoint included), pollDelayMs=0,
 * and the RSA key used to sign the OAuth assertion is generated in-process.
 *
 * Contract under test:
 *   (1) AUTH     — GOOGLE_VERTEX_SA_JSON → RS256 JWT → token endpoint →
 *                  cached token, refreshed ~60s before expiry. Missing/invalid
 *                  credential fails IMMEDIATELY with no fetch and no fallback.
 *   (2) CREATE   — POST us-central1-aiplatform.googleapis.com /v1/projects/{p}
 *                  /locations/us-central1/publishers/google/models/{model}
 *                  :predictLongRunning with a Bearer token; body carries
 *                  instances[0].prompt + parameters (sampleCount 1, 9:16, 720p,
 *                  durationSeconds, generateAudio false); numberOfVideos NEVER.
 *   (3) POLL     — POST :fetchPredictOperation {operationName}; a GET on the
 *                  operation path is NEVER issued (it returns Google's HTML 404).
 *   (4) ERRORS   — PERMISSION_DENIED / API_KEY_SERVICE_BLOCKED / NOT_FOUND map to
 *                  three DIFFERENT messages; never a bare HTTP code.
 *   (5) ONCE     — operation persisted BEFORE polling; resume never re-POSTs.
 *   (6) BUDGET   — whole-video motion: ≤5 windows AND ≤30s of billed motion
 *                  per video (owner Nov 2 — every scene moves).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  VeoVideoService,
  VertexTokenProvider,
  VeoCredentialError,
  buildVeoPredictBody,
  parseVeoOperationName,
  parseVeoOperation,
  extractVeoVideoPayload,
  buildVeoCreateUrl,
  buildVeoPollUrl,
  parseVertexServiceAccount,
  buildVertexJwt,
  classifyVeoHttpError,
  VEO_ERRORS,
  veoModelUnavailableMessage,
  VEO_MODEL,
  VEO_PROVIDER_TAG,
  VEO_CALL_SECONDS,
  VEO_MOTION_BUDGET_SECONDS,
  VEO_MAX_MOTION_WINDOWS,
  VEO_ASPECT_RATIO,
  VEO_RESOLUTION,
  VEO_VERTEX_HOST,
  VEO_VERTEX_LOCATION,
  VEO_POLL_MAX_ATTEMPTS,
  VEO_VERTEX_SA_ENV,
} from '../veoVideoService.js';
import { capVeoMotionWindows, planMotionWindows, type SceneScript, type SoraSpan, type MotionWindow } from '../sceneVideoPipelineService.js';

// ─── a throwaway service account (generated in-process — no secret in the repo)
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TEST_PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const TEST_PROJECT = 'gen-lang-client-0828252838';
const TEST_EMAIL = 'empirelaunchai@gen-lang-client-0828252838.iam.gserviceaccount.com';
const TEST_TOKEN_URI = 'https://oauth2.googleapis.com/token';
function testSaJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: TEST_PROJECT,
    private_key_id: 'test-key-id',
    private_key: TEST_PEM,
    client_email: TEST_EMAIL,
    token_uri: TEST_TOKEN_URI,
    ...overrides,
  });
}
const PREV_SA = process.env[VEO_VERTEX_SA_ENV];
function setSa(raw: string | undefined) {
  if (raw === undefined) delete process.env[VEO_VERTEX_SA_ENV];
  else process.env[VEO_VERTEX_SA_ENV] = raw;
}
function restoreSa() {
  if (PREV_SA === undefined) delete process.env[VEO_VERTEX_SA_ENV];
  else process.env[VEO_VERTEX_SA_ENV] = PREV_SA;
}

function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

interface CapturedCall { url: string; method: string; body?: any; rawBody?: string; headers?: any; }
interface MockOpts {
  inProgressPolls?: number;                     // poll returns done=false this many times, then done=true
  pollShape?: 'vertex' | 'legacy-rest' | 'sdk' | 'error' | 'rai' | 'no-payload';
  alwaysInProgress?: boolean;                   // sanity-cap test: never done
  pollStatus?: number;                          // every poll returns this HTTP status
  pollBody?: string;                            // body text for a failing poll
  tokenStatus?: number;                         // token endpoint failure
  createStatus?: number;                        // create failure
  createBody?: string;                          // body text for a failing create
  trace?: (event: string) => void;              // 'poll' fired on every poll fetch
}
const VERTEX_CLIP_B64 = Buffer.from('vertex-veo-clip').toString('base64');

function installMock(opts: MockOpts = {}) {
  const calls: CapturedCall[] = [];
  const pollCounts: Record<string, number> = {};
  let createN = 0;
  let retiredDoorHits = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const headers = init?.headers || {};
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    let body: any;
    try { body = rawBody ? JSON.parse(rawBody) : undefined; } catch { body = undefined; }
    calls.push({ url, method, body, rawBody, headers });

    // THE RETIRED DOOR — any request here is a regression, not a retry.
    if (url.includes('generativelanguage.googleapis.com')) {
      retiredDoorHits += 1;
      throw new Error(`RETIRED TRANSPORT: request to ${url} — the AI Studio key endpoint is dead`);
    }
    // (1) AUTH: token endpoint
    if (url === TEST_TOKEN_URI) {
      if (opts.tokenStatus) return new Response('{"error":"invalid_grant"}', { status: opts.tokenStatus });
      return jsonResp({ access_token: 'ya29.TEST_TOKEN', expires_in: 3599, token_type: 'Bearer' });
    }
    // (2) CREATE
    if (method === 'POST' && url.endsWith(':predictLongRunning')) {
      if (opts.createStatus) return new Response(opts.createBody ?? 'nope', { status: opts.createStatus });
      createN += 1;
      return jsonResp({ name: `projects/${TEST_PROJECT}/locations/us-central1/publishers/google/models/${VEO_MODEL}/operations/op-${createN}` });
    }
    // (3) POLL — fetchPredictOperation ONLY
    if (method === 'POST' && url.endsWith(':fetchPredictOperation')) {
      if (opts.trace) opts.trace('poll');
      const op = String(body?.operationName || '').split('/').pop() || '';
      if (opts.pollStatus) return new Response(opts.pollBody ?? 'upstream blown', { status: opts.pollStatus });
      if (opts.alwaysInProgress) return jsonResp({ name: body?.operationName, done: false });
      const n = (pollCounts[op] || 0) + 1;
      pollCounts[op] = n;
      if (n <= (opts.inProgressPolls || 0)) return jsonResp({ name: body?.operationName, done: false });
      const shape = opts.pollShape || 'vertex';
      if (shape === 'vertex') {
        return jsonResp({
          name: body?.operationName,
          done: true,
          response: {
            '@type': 'type.googleapis.com/cloud.aiplatform.videogeneration.GenerateVideoResponse',
            raiMediaFilteredCount: '0',
            videos: [{ bytesBase64Encoded: VERTEX_CLIP_B64, mimeType: 'video/mp4' }],
          },
        });
      }
      if (shape === 'legacy-rest') {
        return jsonResp({ name: body?.operationName, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/veo-signed/abc.mp4?X-Goog-Signature=t' } }] } } });
      }
      if (shape === 'sdk') {
        return jsonResp({ name: body?.operationName, done: true, response: { generatedVideos: [{ video: { data: Buffer.from('hello-veo').toString('base64') } }] } });
      }
      if (shape === 'error') return jsonResp({ name: body?.operationName, done: true, error: { code: 13, message: 'internal' } });
      if (shape === 'rai') return jsonResp({ name: body?.operationName, done: true, response: { raiMediaFilteredCount: '1', videos: [] } });
      return jsonResp({ name: body?.operationName, done: true, response: {} }); // 'no-payload'
    }
    // (4) DOWNLOAD: signed https storage uri
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
    tokenCalls: () => calls.filter(c => c.url === TEST_TOKEN_URI),
    createCalls: () => calls.filter(c => c.method === 'POST' && c.url.endsWith(':predictLongRunning')),
    pollCalls: () => calls.filter(c => c.method === 'POST' && c.url.endsWith(':fetchPredictOperation')),
    downloadCalls: () => calls.filter(c => c.url.startsWith('https://storage.googleapis.com/')),
    createCount: () => calls.filter(c => c.method === 'POST' && c.url.endsWith(':predictLongRunning')).length,
    pollCount: () => calls.filter(c => c.method === 'POST' && c.url.endsWith(':fetchPredictOperation')).length,
    createBody: () => calls.find(c => c.method === 'POST' && c.url.endsWith(':predictLongRunning'))?.body,
    createHeaders: () => calls.find(c => c.method === 'POST' && c.url.endsWith(':predictLongRunning'))?.headers,
    retiredDoorHits: () => retiredDoorHits,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

/** Fresh service, fresh token cache, 0ms poll cadence — never the real API. */
function svc(): VeoVideoService {
  const s = new VeoVideoService();
  s.pollDelayMs = 0;
  s.tokens = new VertexTokenProvider();
  return s;
}
function cleanup(paths: Array<string | undefined>) {
  for (const p of paths) {
    if (p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
}

// ═══ (1) AUTH — service-account credential ═══════════════════════════════════
test('AUTH: parseVertexServiceAccount reads project/email/key and normalizes escaped newlines', () => {
  const sa = parseVertexServiceAccount(testSaJson({ private_key: TEST_PEM.replace(/\n/g, '\\n') }));
  assert.equal(sa.project_id, TEST_PROJECT);
  assert.equal(sa.client_email, TEST_EMAIL);
  assert.equal(sa.token_uri, TEST_TOKEN_URI);
  assert.equal(sa.private_key_id, 'test-key-id');
  assert.ok(sa.private_key.includes('BEGIN PRIVATE KEY'), 'PEM survives the escaped-newline form');
  assert.ok(!sa.private_key.includes('\\n'));
});

test('AUTH: missing / unparseable / incomplete GOOGLE_VERTEX_SA_JSON throws VeoCredentialError naming the env var', () => {
  for (const raw of [undefined, '', '   ', 'not json', '{}', JSON.stringify({ project_id: TEST_PROJECT, client_email: TEST_EMAIL })]) {
    assert.throws(
      () => parseVertexServiceAccount(raw as any),
      (err: any) => err instanceof VeoCredentialError
        && String(err.message).includes(VEO_VERTEX_SA_ENV)
        && String(err.message).includes('no API-key fallback'),
      `raw=${String(raw).slice(0, 40)}`,
    );
  }
});

test('AUTH: JWT is RS256 with kid + iss/scope/aud/iat/exp, and its signature verifies', () => {
  const sa = parseVertexServiceAccount(testSaJson());
  const now = 1_700_000_000;
  const jwt = buildVertexJwt(sa, now);
  const [h, c, s] = jwt.split('.');
  assert.equal(jwt.split('.').length, 3);
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
  assert.equal(header.kid, 'test-key-id');
  assert.equal(claims.iss, TEST_EMAIL);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
  assert.equal(claims.aud, TEST_TOKEN_URI);
  assert.equal(claims.iat, now);
  assert.equal(claims.exp - claims.iat, 3600);
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(TEST_PUBLIC_PEM, Buffer.from(s, 'base64url'));
  assert.equal(ok, true, 'assertion is really signed by the service-account key');
});

test('AUTH: token request is a jwt-bearer grant POST to token_uri with the assertion', async () => {
  setSa(testSaJson());
  const mock = installMock();
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    const token = mock.tokenCalls()[0];
    assert.ok(token, 'token endpoint called');
    assert.equal(token.method, 'POST');
    assert.equal(token.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const params = new URLSearchParams(String(token.rawBody));
    assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(String(params.get('assertion')).split('.').length, 3, 'assertion is a JWT');
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('AUTH: the token is CACHED — a second scene reuses it (one mint, not one per call)', async () => {
  setSa(testSaJson());
  const mock = installMock();
  const s = svc();
  try {
    const a = await s.generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    const b = await s.generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene2', onOperationCreated: async () => {} });
    assert.ok(a.success && b.success, a.error || b.error);
    assert.equal(mock.tokenCalls().length, 1, 'ONE token mint for two scenes');
    // every create/poll still carries the cached Bearer token
    for (const call of [...mock.createCalls(), ...mock.pollCalls()]) {
      assert.equal(call.headers?.Authorization, 'Bearer ya29.TEST_TOKEN', `${call.url} uses the cached token`);
    }
    cleanup([a.videoPath, b.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('AUTH: token is refreshed before expiry (advance the injected clock → second mint)', async () => {
  setSa(testSaJson());
  const mock = installMock();
  const s = svc();
  let now = 1_700_000_000_000;
  s.tokens.now = () => now;
  try {
    const a = await s.generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(a.success, a.error);
    assert.equal(mock.tokenCalls().length, 1);
    // 10 minutes in — still inside the 1h token: no new mint.
    now += 10 * 60 * 1000;
    const b = await s.generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene2', onOperationCreated: async () => {} });
    assert.ok(b.success, b.error);
    assert.equal(mock.tokenCalls().length, 1, 'cached token reused well before expiry');
    // past expiry minus the refresh margin → mint again.
    now += 60 * 60 * 1000;
    const c = await s.generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene3', onOperationCreated: async () => {} });
    assert.ok(c.success, c.error);
    assert.equal(mock.tokenCalls().length, 2, 'expired token is refreshed, never reused');
    cleanup([a.videoPath, b.videoPath, c.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('AUTH: missing credential fails IMMEDIATELY — no fetch, no fallback, no text-to-image', async () => {
  setSa(undefined);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; return jsonResp({}); }) as typeof fetch;
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes(VEO_VERTEX_SA_ENV), result.error);
    assert.equal(fetchCalls, 0, 'no network call without a credential');
    assert.equal(result.videoPath, undefined);
  } finally { globalThis.fetch = originalFetch; restoreSa(); }
});

test('AUTH: unparseable credential fails immediately with the same loud error', async () => {
  setSa('{"client_email":"x@y"}');
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; return jsonResp({}); }) as typeof fetch;
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes(VEO_VERTEX_SA_ENV), result.error);
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = originalFetch; restoreSa(); }
});

test('AUTH: a rejected assertion (token endpoint 400) is a CREDENTIALS error, not a retired model', async () => {
  setSa(testSaJson());
  const mock = installMock({ tokenStatus: 400 });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(/credential|assertion|invalid/i.test(String(result.error)), result.error);
    assert.ok(!/retired/i.test(String(result.error)), 'never misreported as a retired model');
    assert.equal(mock.createCount(), 0, 'no paid create without a token');
  } finally { mock.restore(); restoreSa(); }
});

// ═══ (2) CREATE — Vertex predictLongRunning ══════════════════════════════════
test('CREATE: URL is the Vertex model path (project + location), Bearer auth, no API key header', async () => {
  setSa(testSaJson());
  const mock = installMock();
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    const url = String(mock.createCalls()[0].url);
    assert.equal(
      url,
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${TEST_PROJECT}/locations/us-central1/publishers/google/models/${VEO_MODEL}:predictLongRunning`,
    );
    assert.ok(url.endsWith(':predictLongRunning'));
    assert.ok(url.startsWith(VEO_VERTEX_HOST), 'Vertex host');
    assert.ok(url.includes(`/locations/${VEO_VERTEX_LOCATION}/`));
    assert.equal(mock.createHeaders()['Authorization'], 'Bearer ya29.TEST_TOKEN');
    assert.equal(mock.createHeaders()['Content-Type'], 'application/json');
    assert.equal('x-goog-api-key' in mock.createHeaders(), false, 'API keys cannot call Vertex prediction');
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('CREATE: body carries prompt + sampleCount/9:16/720p/6s/generateAudio:false — numberOfVideos NEVER sent', async () => {
  setSa(testSaJson());
  const mock = installMock();
  try {
    const result = await svc().generateSceneVideo({ prompt: 'a hero transformation', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    const body = mock.createBody();
    assert.equal(body.instances[0].prompt, 'a hero transformation');
    assert.equal(body.parameters.sampleCount, 1);
    assert.equal(body.parameters.aspectRatio, '9:16');
    assert.equal(body.parameters.resolution, '720p');
    assert.equal(body.parameters.durationSeconds, 6);
    assert.equal(body.parameters.generateAudio, false, 'video-only — audio is billed separately and narrated by GPT Audio');
    assert.equal('numberOfVideos' in body, false, 'numberOfVideos is a zero-cost 400');
    assert.equal('numberOfVideos' in (body.parameters ?? {}), false);
    assert.equal('personGeneration' in (body.parameters ?? {}), false, 'unverified parameter — the proven Vertex body omits it');
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('BODY: buildVeoPredictBody with no options sends no parameters key at all', () => {
  const body = buildVeoPredictBody('plain') as any;
  assert.equal(body.instances[0].prompt, 'plain');
  assert.equal('parameters' in body, false);
});

test('CREATE: durationSeconds override flows into the body AND billedSeconds', async () => {
  setSa(testSaJson());
  const mock = installMock();
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', durationSeconds: 4, onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    assert.equal(mock.createBody().parameters.durationSeconds, 4, '4s enum honored');
    assert.equal(result.billedSeconds, 4);
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

// ═══ (3) POLL — fetchPredictOperation ONLY ═══════════════════════════════════
test('POLL: POST :fetchPredictOperation with {operationName} — never a GET on the operation path', async () => {
  setSa(testSaJson());
  const mock = installMock({ inProgressPolls: 1 });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    const polls = mock.pollCalls();
    assert.equal(polls.length, 2);
    const expectedOp = `projects/${TEST_PROJECT}/locations/us-central1/publishers/google/models/${VEO_MODEL}/operations/op-1`;
    for (const p of polls) {
      assert.equal(p.method, 'POST');
      assert.ok(String(p.url).endsWith(':fetchPredictOperation'), `poll url=${p.url}`);
      assert.equal(p.body.operationName, expectedOp, 'the full operation name is echoed back');
      assert.equal(p.headers.Authorization, 'Bearer ya29.TEST_TOKEN');
    }
    const getCalls = mock.calls.filter(c => c.method === 'GET');
    assert.equal(getCalls.length, 0, 'NO GET anywhere — a plain GET on the operation path is Google HTML 404');
    assert.equal(result.operationName, expectedOp);
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('POLL: in_progress → done transition polls exactly inProgressPolls+1 times', async () => {
  setSa(testSaJson());
  const mock = installMock({ inProgressPolls: 2 });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    assert.equal(mock.pollCount(), 3, '2 in_progress polls + 1 done poll');
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('POLL: sanity cap while in_progress returns failure WITH the op name (resume-safe, never abandons on elapsed time)', async () => {
  setSa(testSaJson());
  const mock = installMock({ alwaysInProgress: true });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('sanity cap exceeded'), `error=${result.error}`);
    assert.ok(result.operationName, 'op returned so the caller can persist + resume exactly-once');
    assert.equal(mock.createCount(), 1, 'exactly one paid create');
    assert.equal(mock.pollCount(), VEO_POLL_MAX_ATTEMPTS, 'polled the full sanity cap, never abandoned on elapsed time');
  } finally { mock.restore(); restoreSa(); }
});

test('POLL: 404 aborts on the FIRST poll — operation-not-found message, never a bare code', async () => {
  setSa(testSaJson());
  const mock = installMock({ pollStatus: 404, pollBody: 'Operation not found' });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('404'), result.error);
    assert.ok(/operation not found/i.test(String(result.error)), result.error);
    assert.equal(mock.pollCount(), 1, 'aborts on the FIRST 404 — no more polling');
  } finally { mock.restore(); restoreSa(); }
});

test('POLL: 5 consecutive HTTP errors abort (never infinite)', async () => {
  setSa(testSaJson());
  const mock = installMock({ pollStatus: 500 });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('5 consecutive HTTP errors'), result.error);
    assert.equal(mock.pollCount(), 5);
  } finally { mock.restore(); restoreSa(); }
});

// ═══ (4) THREE DISTINCT FAILURES, THREE DISTINCT MESSAGES ════════════════════
test('ERRORS: PERMISSION_DENIED → "our credentials/role", NOT a retired model', async () => {
  setSa(testSaJson());
  const body = JSON.stringify({ error: { code: 403, message: "Permission 'aiplatform.endpoints.predict' denied on resource", status: 'PERMISSION_DENIED' } });
  const mock = installMock({ createStatus: 403, createBody: body });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    const err = String(result.error);
    assert.ok(/PERMISSION_DENIED/.test(err), err);
    assert.ok(/credential|role/i.test(err), `must name OUR credentials/role: ${err}`);
    assert.ok(/not a retired model/i.test(err), `must explicitly rule out retirement: ${err}`);
    assert.equal(mock.pollCount(), 0, 'a create failure never polls');
  } finally { mock.restore(); restoreSa(); }
});

test('ERRORS: API_KEY_SERVICE_BLOCKED → "a service account is required"', async () => {
  setSa(testSaJson());
  const body = JSON.stringify({ error: { code: 403, message: 'API keys are not supported by this API. API_KEY_SERVICE_BLOCKED', status: 'PERMISSION_DENIED' } });
  const mock = installMock({ createStatus: 403, createBody: body });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    const err = String(result.error);
    assert.ok(/API_KEY_SERVICE_BLOCKED/.test(err), err);
    assert.ok(/service account/i.test(err), err);
    assert.ok(!/retired model/i.test(err), 'an API-key block is not a retired model');
  } finally { mock.restore(); restoreSa(); }
});

test('ERRORS: NOT_FOUND / retired → "the model is unavailable"', async () => {
  setSa(testSaJson());
  const body = JSON.stringify({ error: { code: 404, message: `Publisher Model \`projects/x/locations/us-central1/publishers/google/models/${VEO_MODEL}\` was not found or your project does not have access to it.`, status: 'NOT_FOUND' } });
  const mock = installMock({ createStatus: 404, createBody: body });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    const err = String(result.error);
    assert.ok(/unavailable/i.test(err), err);
    assert.ok(err.includes(VEO_MODEL), 'names the model');
    assert.ok(/NOT_FOUND/.test(err), err);
    assert.ok(!/role/i.test(err), 'a retired model is not a role problem');
  } finally { mock.restore(); restoreSa(); }
});

test('ERRORS: the three mappings are pairwise DIFFERENT strings and none is a bare HTTP code', () => {
  const perm = classifyVeoHttpError(403, '{"error":{"status":"PERMISSION_DENIED","message":"Permission denied"}}', 'create');
  const key = classifyVeoHttpError(403, '{"error":{"message":"API_KEY_SERVICE_BLOCKED"}}', 'create');
  const gone = classifyVeoHttpError(404, '{"error":{"status":"NOT_FOUND","message":"no longer available"}}', 'create');
  assert.notEqual(perm, key);
  assert.notEqual(perm, gone);
  assert.notEqual(key, gone);
  for (const msg of [perm, key, gone]) {
    assert.ok(msg.length > 40, `message is explanatory, not a code: ${msg}`);
    assert.ok(/[a-z]{4}/i.test(msg), `has words: ${msg}`);
  }
  assert.equal(classifyVeoHttpError(403, '{"error":{"message":"API_KEY_SERVICE_BLOCKED"}}', 'create'), VEO_ERRORS.apiKeyBlocked);
  assert.equal(classifyVeoHttpError(404, '{"error":{"status":"NOT_FOUND"}}', 'create'), veoModelUnavailableMessage());
  const generic = classifyVeoHttpError(500, 'boom', 'create');
  assert.ok(generic.includes('HTTP 500') && generic.includes('boom'), 'a generic failure still carries context, not just a code');
});

test('ERRORS: a failed OPERATION (done:true + error) also maps auth/retired distinctly', () => {
  const perm = parseVeoOperation({ done: true, error: { code: 7, message: 'PERMISSION_DENIED' } });
  assert.equal(perm.done, true);
  assert.equal(perm.error, VEO_ERRORS.permissionDenied);
  const gone = parseVeoOperation({ done: true, error: { code: 5, message: 'NOT_FOUND' } });
  assert.equal(gone.error, veoModelUnavailableMessage());
  const other = parseVeoOperation({ done: true, error: { code: 13, message: 'boom' } });
  assert.ok(String(other.error).includes('boom'));
});

// ═══ (5) EXACTLY-ONCE ════════════════════════════════════════════════════════
test('EXACTLY-ONCE: onOperationCreated fires BEFORE the first poll (persisted → resume-safe)', async () => {
  setSa(testSaJson());
  const timeline: string[] = [];
  const mock = installMock({ inProgressPolls: 1, trace: (e) => timeline.push(e) });
  try {
    const result = await svc().generateSceneVideo({
      prompt: 'p', sceneKey: 'block0-scene1',
      onOperationCreated: async (op) => { timeline.push(`created:${op}`); },
    });
    assert.ok(result.success, result.error);
    const createdIdx = timeline.findIndex(t => t.startsWith('created:'));
    const pollIdx = timeline.findIndex(t => t === 'poll');
    assert.ok(createdIdx >= 0, 'onOperationCreated called');
    assert.ok(pollIdx >= 0, 'poll observed');
    assert.ok(createdIdx < pollIdx, 'operation name persisted BEFORE any polling');
    assert.equal(mock.createCount(), 1);
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('EXACTLY-ONCE resume: existingOperationName → ZERO create POSTs, polls resume the SAME op', async () => {
  setSa(testSaJson());
  const mock = installMock();
  const created: string[] = [];
  const resumeOp = `projects/${TEST_PROJECT}/locations/us-central1/publishers/google/models/${VEO_MODEL}/operations/op-resume`;
  try {
    const result = await svc().generateSceneVideo({
      prompt: 'resume me', sceneKey: 'block0-scene1',
      existingOperationName: resumeOp,
      onOperationCreated: async (op) => { created.push(op); },
    });
    assert.ok(result.success, result.error);
    assert.equal(mock.createCount(), 0, 'no re-POST when an operation is already known — never duplicate billing');
    assert.equal(result.operationName, resumeOp);
    const polls = mock.pollCalls();
    assert.ok(polls.length >= 1);
    assert.ok(polls.every(c => c.body.operationName === resumeOp), 'every poll targets the persisted op');
    assert.equal(created.length, 0, 'resume path does NOT re-report a created op');
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

// ═══ result parsing / saving ═════════════════════════════════════════════════
test('RESULT (Vertex): response.videos[].bytesBase64Encoded is the documented path', () => {
  const r = parseVeoOperation({ done: true, response: { raiMediaFilteredCount: '0', videos: [{ bytesBase64Encoded: 'aGVsbG8=', mimeType: 'video/mp4' }] } });
  assert.equal(r.done, true);
  assert.deepEqual(r.video, { data: 'aGVsbG8=' });
});

test('RESULT (tolerated legacy shapes): generatedSamples[].video.uri and generatedVideos[].video.data', () => {
  const rest = parseVeoOperation({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://signed/1.mp4' } }] } } });
  assert.deepEqual(rest.video, { uri: 'https://signed/1.mp4' });
  const sdk = parseVeoOperation({ done: true, response: { generatedVideos: [{ video: { data: 'aGVsbG8=' } }] } });
  assert.deepEqual(sdk.video, { data: 'aGVsbG8=' });
});

test('parseVeoOperation: in_progress → done:false; raiMediaFilteredCount>0 → error; done with no payload → error', () => {
  assert.deepEqual(parseVeoOperation({ done: false }), { done: false });
  assert.deepEqual(parseVeoOperation(null), { done: false });
  const rai = parseVeoOperation({ done: true, response: { raiMediaFilteredCount: '1', videos: [] } });
  assert.equal(rai.done, true);
  assert.ok(String(rai.error).includes('raiMediaFiltered'));
  const nop = parseVeoOperation({ done: true, response: {} });
  assert.ok(String(nop.error).includes('no video payload'));
});

test('extractVeoVideoPayload: uri, data, videoBytes, bytesBase64Encoded, inlineData.data all normalized', () => {
  assert.deepEqual(extractVeoVideoPayload({ uri: 'u' }), { uri: 'u' });
  assert.deepEqual(extractVeoVideoPayload({ data: 'x' }), { data: 'x' });
  assert.deepEqual(extractVeoVideoPayload({ videoBytes: 'y' }), { data: 'y' });
  assert.deepEqual(extractVeoVideoPayload({ bytesBase64Encoded: 'b' }), { data: 'b' });
  assert.deepEqual(extractVeoVideoPayload({ inlineData: { data: 'z' } }), { data: 'z' });
  assert.equal(extractVeoVideoPayload({}), undefined);
  assert.equal(extractVeoVideoPayload(undefined), undefined);
});

test('parseVeoOperationName: valid name accepted, missing name throws', () => {
  assert.equal(parseVeoOperationName({ name: 'projects/p/operations/x' }), 'projects/p/operations/x');
  assert.throws(() => parseVeoOperationName({}), /missing operation name/i);
  assert.throws(() => parseVeoOperationName({ name: '' }), /missing operation name/i);
});

test('SAVE: inline base64 written to temp/veo with NO download fetch', async () => {
  setSa(testSaJson());
  const mock = installMock();
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    assert.equal(mock.downloadCalls().length, 0, 'Vertex returns the bytes inline — nothing to download');
    assert.equal(fs.readFileSync(result.videoPath!).toString(), 'vertex-veo-clip');
    assert.ok(result.videoPath!.includes(path.join('temp', 'veo')));
    assert.equal(result.billedSeconds, 6, 'default billed = one 6s enum call');
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('SAVE: a signed https uri is fetched with the Bearer token', async () => {
  setSa(testSaJson());
  const mock = installMock({ pollShape: 'legacy-rest' });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    const dl = mock.downloadCalls();
    assert.equal(dl.length, 1);
    assert.equal(dl[0].headers.Authorization, 'Bearer ya29.TEST_TOKEN');
    assert.equal(fs.statSync(result.videoPath!).size > 0, true);
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('SAVE: a raw gs:// uri is a HARD error (never a silent zero-byte file)', async () => {
  setSa(testSaJson());
  const originalFetch = globalThis.fetch;
  const mockBase = installMock();
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url === TEST_TOKEN_URI) return jsonResp({ access_token: 'ya29.TEST_TOKEN', expires_in: 3599 });
    if (url.endsWith(':predictLongRunning')) return jsonResp({ name: 'projects/p/operations/op-gs' });
    if (url.endsWith(':fetchPredictOperation')) return jsonResp({ done: true, response: { videos: [{ uri: 'gs://bucket/clip.mp4' }] } });
    return jsonResp({});
  }) as typeof fetch;
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.equal(result.success, false);
    assert.ok(String(result.error).includes('gs://'), result.error);
  } finally { globalThis.fetch = originalFetch; mockBase.restore(); restoreSa(); }
});

// ═══ (6) THE DEAD DOOR MUST NOT BE REACHABLE FROM CODE ═══════════════════════
test('REGRESSION GUARD: the service source contains no AI Studio endpoint and no API-key transport', () => {
  // Scan the CODE, not the commentary: the header documents what was retired
  // (and why), which is exactly the knowledge a future edit needs.
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'veoVideoService.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/generativelanguage\.googleapis\.com/.test(source), false, 'the retired AI Studio host is GONE from the source');
  assert.equal(/x-goog-api-key/.test(source), false, 'the API-key header is GONE from the source');
  assert.equal(/GOOGLE_STUDIO_API_KEY|GOOGLE_API_KEY/.test(source), false, 'no API-key env fallback exists');
  assert.equal(/veo-3\.1-lite-generate-preview/.test(source), false, 'the retired -preview model id is GONE');
  assert.ok(source.includes('veo-3.1-lite-generate-001'), 'the Vertex model id is present');
  assert.ok(source.includes(':fetchPredictOperation'), 'the only poll door is fetchPredictOperation');
  assert.ok(source.includes('GOOGLE_VERTEX_SA_JSON'), 'service-account credential is the only auth');
});

test('REGRESSION GUARD: a full happy path never touches the retired host', async () => {
  setSa(testSaJson());
  const mock = installMock({ inProgressPolls: 1 });
  try {
    const result = await svc().generateSceneVideo({ prompt: 'p', sceneKey: 'block0-scene1', onOperationCreated: async () => {} });
    assert.ok(result.success, result.error);
    assert.equal(mock.retiredDoorHits(), 0);
    assert.ok(mock.calls.every(c => !c.url.includes('generativelanguage')), 'every call went to Vertex');
    cleanup([result.videoPath]);
  } finally { mock.restore(); restoreSa(); }
});

test('CONSTANTS: Vertex model id, lite tag, 6s enum, 12s motion budget, 9:16/720p, poll cap 120', () => {
  assert.equal(VEO_MODEL, 'veo-3.1-lite-generate-001', 'the Vertex Lite model — never the retired -preview id');
  assert.equal(VEO_PROVIDER_TAG, 'veo-3.1-lite');
  assert.equal(VEO_CALL_SECONDS, 6, 'enum 4|6|8 — production uses one 6s take per window');
  assert.equal(VEO_MOTION_BUDGET_SECONDS, 30, 'the WHOLE video is the motion budget (owner Nov 2)');
  assert.equal(VEO_MAX_MOTION_WINDOWS, 5, '30s / 6s = at most 5 paid calls per video');
  assert.equal(VEO_ASPECT_RATIO, '9:16');
  assert.equal(VEO_RESOLUTION, '720p');
  assert.equal(VEO_POLL_MAX_ATTEMPTS, 120, 'sanity cap only — never an elapsed-time abandon');
  assert.equal(VEO_VERTEX_LOCATION, 'us-central1');
  assert.equal(buildVeoCreateUrl('proj').endsWith(`models/${VEO_MODEL}:predictLongRunning`), true);
  assert.equal(buildVeoPollUrl('proj').endsWith(`models/${VEO_MODEL}:fetchPredictOperation`), true);
  assert.ok(buildVeoPollUrl('proj').includes('/projects/proj/locations/us-central1/'));
});

// ═══ (7) Scene planner call site: capVeoMotionWindows ════════════════════════
const motion = (n: number, prompt: string, duration = 6): SceneScript => ({
  sceneNumber: n, duration, visualType: 'motion', narration: `N ${n}.`, visualPrompt: prompt, soraBlock: 0,
});

function threeWindowSpans(): SoraSpan[] {
  const script = [motion(2, 'hook'), motion(3, 'about'), motion(4, 'CTA')];
  const windows = planMotionWindows(script);
  return [{ soraBlock: 0, sceneNumbers: [2, 3, 4], totalSeconds: windows.reduce((a, w) => a + w.motionSeconds, 0), windows, prompt: 'one take' }];
}

test('CAP: all 3 windows of an 18s video are KEPT — no "important windows only" election', () => {
  const script = [motion(2, 'hook'), motion(3, 'about'), motion(4, 'CTA')];
  const spans = threeWindowSpans();
  const { script: s2, spans: sp2 } = capVeoMotionWindows(script, spans);
  assert.equal(sp2.length, 1, 'span survives');
  assert.equal(sp2[0].windows.length, 3, 'every scene moves (18s ≤ 30s budget)');
  assert.deepEqual(sp2[0].sceneNumbers, [2, 3, 4], 'nothing demoted');
  assert.equal(sp2[0].totalSeconds, sp2[0].windows.reduce((a, w) => a + w.motionSeconds, 0), 'totalSeconds recomputed');
  assert.equal(s2.filter(s => s.visualType === 'motion').length, 3, 'all three scenes stay motion');
  assert.equal(s2.reduce((a, s) => a + s.duration, 0), 18, 'time budget preserved');
});

test('CAP: 6 windows (36s) are capped to 5 windows / 30s — the tail scene is demoted to a still', () => {
  const script = Array.from({ length: 6 }, (_, i) => motion(i + 1, `beat ${i + 1}`));
  const windows: MotionWindow[] = script.map((s, i) => ({ sceneNumber: s.sceneNumber, motionStartSeconds: i * 6, motionSeconds: 6 }));
  const spans: SoraSpan[] = [{ soraBlock: 0, sceneNumbers: script.map(s => s.sceneNumber), totalSeconds: 36, windows, prompt: 't' }];
  const { script: s2, spans: sp2 } = capVeoMotionWindows(script, spans);
  assert.equal(sp2[0].windows.length, 5, 'never more than 5 paid calls');
  assert.equal(sp2[0].totalSeconds, 30, 'never more than 30 billed seconds');
  assert.equal(s2.filter(s => s.visualType === 'motion').length, 5);
  const demoted = s2.find(s => s.sceneNumber === 6)!;
  assert.equal(demoted.visualType, 'still', 'the 6th scene falls back to a still');
  assert.equal(demoted.soraBlock, undefined, 'demoted scene no longer claims a Veo block');
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
