/**
 * SORA 2 OWNER-RATIFIED SPEC unit tests — NO paid renders (fetch fully mocked).
 *
 * Covers the four ratified contract points:
 *  (1) 16|20 GATE — the create POST body's `seconds` is NEVER a short enum tier:
 *      snapSora16or20(needSeconds) → "16" when the block needs ≤16s, else "20".
 *  (2) EXACTLY-ONCE CREATE — generateVideo(existingVideoId) SKIPS the create POST
 *      and polls that id to terminal; a failed/timed-out poll returns `videoId`
 *      so callers can persist it and resume — never re-POST the same block.
 *  (3) EXTENSIONS — needSeconds > 20 → POST /v1/videos/{id}/extensions (+20s per
 *      call, ≤ SORA_MAX_EXTENSIONS, hard cap SORA_MAX_TOTAL_SECONDS=120s); the
 *      final content is downloaded from the LAST successful extension id.
 *  (4) EXPLICIT SIZE — every create body carries size:'720x1280' regardless of
 *      options (no reliance on the API default).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  SoraVideoService,
  snapSora16or20,
  sanitizeNeedSeconds,
  buildSoraExtensionBody,
  SORA_MAX_EXTENSIONS,
  SORA_MAX_TOTAL_SECONDS,
  SORA_EXTENSION_SECONDS,
  SORA_SCENE_SIZE,
  SORA_POLL_MAX_ATTEMPTS,
  resolveGateSeconds,
} from '../soraVideoService.js';

// Hermetic: keep a (fake) key set for the WHOLE test process — node:test loads
// this module fully before running callbacks, so a bottom-of-file restore would
// unset it before the first mocked test ran. Never clobber a real dev key.
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';

function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

interface CapturedCall { url: string; method: string; body?: any; }

function installMock(opts: { failPollId?: string; inProgressPolls?: number } = {}) {
  const calls: CapturedCall[] = [];
  const pollCounts: Record<string, number> = {};
  let createN = 0;
  let extN = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    // CREATE: POST https://api.openai.com/v1/videos
    if (method === 'POST' && /\/v1\/videos$/.test(url)) {
      createN += 1;
      return jsonResp({ id: `vid-create-${createN}`, status: 'queued' });
    }
    // EXTENSION: POST https://api.openai.com/v1/videos/{id}/extensions
    if (method === 'POST' && url.includes('/extensions')) {
      extN += 1;
      return jsonResp({ id: `vid-ext-${extN}`, status: 'queued' });
    }
    // CONTENT download (must be checked BEFORE the generic poll branch below)
    if (url.endsWith('/content')) {
      return new Response(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34]), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });
    }
    // POLL: GET https://api.openai.com/v1/videos/{id}
    if (url.includes('/v1/videos/')) {
      const id = url.split('/v1/videos/')[1].split('/')[0];
      const done = (pollCounts[id] || 0) + 1;
      pollCounts[id] = done;
      if (done <= (opts.inProgressPolls || 0)) return jsonResp({ id, status: 'in_progress' });
      if (id === opts.failPollId) return jsonResp({ id, status: 'failed' });
      return jsonResp({ id, status: 'completed' });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    createCount: () => calls.filter(c => c.method === 'POST' && /\/v1\/videos$/.test(c.url)).length,
    extCount: () => calls.filter(c => c.method === 'POST' && c.url.includes('/extensions')).length,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

/** Fresh service with 0ms poll cadence (tests never touch the real API). */
function svc(): SoraVideoService { return new SoraVideoService(0); }

function cleanup(paths: Array<string | undefined>) {
  for (const p of paths) {
    if (p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
}

// ─── (1) 16|20 GATE ───────────────────────────────────────────────────────────
test('GATE: seconds:"16" when block needs ≤16s, "20" otherwise — never 4/8/12', () => {
  for (const need of [1, 6, 10, 12, 16]) assert.equal(snapSora16or20(need), '16');
  for (const need of [17, 20, 30, 60, 120, 500]) assert.equal(snapSora16or20(need), '20');
  for (const need of [0, -3, NaN]) assert.ok(['16', '20'].includes(snapSora16or20(need)));
  assert.equal(sanitizeNeedSeconds(130), SORA_MAX_TOTAL_SECONDS, 'needSeconds clamps to 120');
  assert.equal(sanitizeNeedSeconds(undefined), 20, 'default need = 20s single take');
});

test('generateVideo with needSeconds=12 POSTs seconds:"16" + explicit size (mocked)', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateVideo('short block', { needSeconds: 12 });
    assert.ok(result.success, result.error);
    const create = mock.calls.find(c => /\/v1\/videos$/.test(c.url) && c.method === 'POST');
    assert.ok(create, 'create POST captured');
    assert.equal(create!.body.seconds, '16', 'gate: 12s block → seconds:"16"');
    assert.equal(create.body.size, SORA_SCENE_SIZE, 'explicit size always');
    assert.equal('duration' in create.body, false, 'legacy duration never sent');
    assert.equal(mock.extCount(), 0, '12s block never extends');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('defaults: no options → seconds:"20" (gate) + explicit size — never API default "4"', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateVideo('plain call');
    assert.ok(result.success, result.error);
    const create = mock.calls.find(c => /\/v1\/videos$/.test(c.url) && c.method === 'POST');
    assert.ok(create, 'create POST captured (defaults)');
    assert.equal(create!.body.seconds, '20', 'default need=20 → seconds:"20" (short tiers locked out)');
    assert.equal(create.body.size, SORA_SCENE_SIZE, 'explicit size always');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

// ─── (2) EXACTLY-ONCE CREATE ──────────────────────────────────────────────────
test('EXACTLY-ONCE: existingVideoId skips the create POST entirely (mocked)', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateVideo('resume me', { existingVideoId: 'vid-known' });
    assert.ok(result.success, result.error);
    assert.equal(mock.createCount(), 0, 'no re-POST when an id is already known');
    assert.equal(mock.extCount(), 0);
    const polls = mock.calls.filter(c => c.method === 'GET' && c.url.includes('/v1/videos/') && !c.url.endsWith('/content'));
    assert.ok(polls.length >= 1, 'resumes by polling GET /v1/videos/vid-known');
    assert.ok(polls.every(c => c.url.includes('/vid-known')), 'poll targets the persisted id');
    assert.equal(result.videoId, 'vid-known', 'result carries the resumed id');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('EXACTLY-ONCE: failed poll still returns videoId so callers can persist + resume (mocked)', async () => {
  const mock = installMock({ failPollId: 'vid-create-1' });
  try {
    const result = await svc().generateVideo('will fail', {});
    assert.equal(result.success, false, 'poll failed → failure');
    assert.equal(result.videoId, 'vid-create-1', 'FAILURE carries the id that must be persisted (never re-POST)');
    assert.equal(mock.createCount(), 1, 'exactly one create POST');
  } finally { mock.restore(); }
});

// ─── (3) EXTENSIONS for continuity >20s ──────────────────────────────────────
test('EXTENSIONS: 30s block → 1 create (20s) + exactly 1 extension, download from last id', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateVideo('long continuous block', { needSeconds: 30 });
    assert.ok(result.success, result.error);
    assert.equal(mock.createCount(), 1, 'one initial create only');
    assert.equal(mock.extCount(), 1, 'one extension to reach 30s');
    const ext = mock.calls.find(c => c.method === 'POST' && c.url.includes('/extensions'));
    assert.ok(ext, 'extension POST captured');
    assert.ok(String(ext.url).endsWith('/v1/videos/extensions'), 'POST /v1/videos/extensions — NOT /v1/videos/{id}/extensions');
    assert.equal(ext.body.video, 'vid-create-1', 'source video id goes in the BODY');
    assert.equal(ext.body.seconds, '20', 'extension requests the +20s gate-allowed tier');
    assert.ok(ext.body?.prompt && String(ext.body.prompt).length > 20, 'extension carries a continuity prompt');
    assert.equal(result.videoId, 'vid-ext-1', 'final id owns the extended content');
    const content = mock.calls.find(c => c.url.endsWith('/content'));
    assert.ok(content && content.url.includes('/vid-ext-1/content'), 'download from the LAST (extended) id');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('EXTENSIONS cap: needSeconds=130 → 5 extensions (20+5×20=120 max), 6th NEVER sent', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateVideo('absurdly long', { needSeconds: 130 });
    assert.ok(result.success, result.error);
    assert.equal(mock.createCount(), 1);
    assert.equal(mock.extCount(), 5, `${SORA_MAX_EXTENSIONS}-call budget but 120s hard cap wins: 20+6×20=140 > 120 → 5`);
    assert.equal(result.videoId, 'vid-ext-5');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('EXTENSIONS: needSeconds ≤ 20 never triggers an extension (16s gate included)', async () => {
  for (const need of [16, 18, 20]) {
    const mock = installMock();
    try {
      const result = await svc().generateVideo(`block ${need}s`, { needSeconds: need });
      assert.ok(result.success, `need=${need}: ${result.error}`);
      assert.equal(mock.extCount(), 0, `need=${need}: no extensions`);
      const create = mock.calls.find(c => /\/v1\/videos$/.test(c.url) && c.method === 'POST');
      assert.ok(create, `create POST captured (need=${need})`);
      assert.equal(create!.body.seconds, need <= 16 ? '16' : '20');
      cleanup([result.videoPath]);
    } finally { mock.restore(); }
  }
});

// ─── onVideoCreated durable-persistence callback ──────────────────────────────
test('onVideoCreated fires in order with ids BEFORE polling (initial + each extension)', async () => {
  const mock = installMock();
  const seen: string[] = [];
  const stages: string[] = [];
  try {
    const result = await svc().generateVideo('continuity block', {
      needSeconds: 50,
      onVideoCreated: (id, meta) => { seen.push(id); stages.push(`${meta.stage}:${meta.index}`); },
    });
    assert.ok(result.success, result.error);
    assert.deepEqual(stages, ['initial:0', 'extension:1', 'extension:2'], 'order: initial then extensions');
    assert.deepEqual(seen, ['vid-create-1', 'vid-ext-1', 'vid-ext-2'], 'every created id reported for durable persistence');
    assert.ok(mock.calls.find(c => c.url.includes('/vid-create-1') && !c.url.endsWith('/content')), 'initial id polled');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('buildSoraExtensionBody ships the SDK shape { prompt, seconds, video } for POST /v1/videos/extensions', () => {
  const body = buildSoraExtensionBody('keep the same camera move', 'vid-src-1');
  assert.ok(String(body.prompt).includes('Seamlessly continue'));
  assert.ok(String(body.prompt).includes('keep the same camera move'));
  assert.equal(body.seconds, '20', 'extension always requests the +20s gate-allowed tier');
  assert.equal(body.video, 'vid-src-1', 'source video id in the body (VideoExtendParams contract)');
  assert.equal('size' in body, false);
  assert.equal('duration' in body, false);
});

// ─── output-dir hygiene ───────────────────────────────────────────────────────
test('SORA_MAX_EXTENSIONS/TOTAL constants match the owner spec', () => {
  assert.equal(SORA_MAX_EXTENSIONS, 6);
  assert.equal(SORA_EXTENSION_SECONDS, 20);
  assert.equal(SORA_MAX_TOTAL_SECONDS, 120);
  assert.equal(SORA_SCENE_SIZE, '720x1280');
  assert.equal(SORA_POLL_MAX_ATTEMPTS, 120, 'sanity cap only — never the old 5-min abandon');
});

test('EXTENSIONS: 60s block → 2 extensions (20+2×20), download from last id', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateVideo('60s continuous block', { needSeconds: 60 });
    assert.ok(result.success, result.error);
    assert.equal(mock.createCount(), 1, 'one create only');
    assert.equal(mock.extCount(), 2, 'two extensions for 60s');
    assert.equal(result.videoId, 'vid-ext-2', 'download from last extended id');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

test('POLL: no elapsed-time abandonment — the ONLY abort is a terminal state', async () => {
  // Lead 2026-09-13: never give up on in_progress because time elapsed (Sora
  // legitimately takes 6–10+ min). The sanity cap is the exported constant
  // (120 polls @ 10s→20s backoff ≈ a 20–40min window); the old 5-min/58-poll
  // abandon is gone. A poll whose video terminal-fails still returns the id
  // so the caller can resume exactly-once (covered by the failed-poll test).
  assert.equal(SORA_POLL_MAX_ATTEMPTS, 120);
  assert.equal(snapSora16or20(6), '16');
  assert.equal(snapSora16or20(20), '20');
});

test('GATE: resolveGateSeconds default 20, 16|20 pass, short tiers never reach the API', () => {
  assert.equal(resolveGateSeconds(undefined), '20');
  assert.equal(resolveGateSeconds('16'), '16');
  assert.equal(resolveGateSeconds('20'), '20');
  for (const bad of ['4', '8', '12'] as const) assert.throws(() => resolveGateSeconds(bad), /locked-out/);
  assert.equal(snapSora16or20(6), '16');
  assert.equal(snapSora16or20(12), '16');
  assert.equal(snapSora16or20(18), '20');
  assert.equal(snapSora16or20(20), '20');
});

const dir = path.join(process.cwd(), 'public', 'assets', 'cinema', 'sora');
try {
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('sora_')) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
  }
} catch { /* ignore */ }