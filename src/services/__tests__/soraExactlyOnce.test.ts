/**
 * SORA 2 OWNER-RATIFIED SPEC unit tests — NO paid renders (fetch fully mocked).
 *
 * CORE-ONLY (lead split directive 2026-09-13): the extensions API surface is
 * parked behind the owner's Sora-retention decision (openai-node deprecates the
 * whole /v1/videos resource, shutdown 2026-09-24). This suite covers the three
 * transferable, live-safe contract points:
 *  (1) 16|20 GATE — the create POST body's `seconds` is NEVER a short enum tier:
 *      snapSora16or20(needSeconds) → "16" when the block needs ≤16s, else "20";
 *      explicit short tiers THROW (fail-fast); absent defaults to "20" (never
 *      the API default "4", which would silently bill a shorter length).
 *  (2) EXPLICIT SIZE — every create body carries size:'720x1280' regardless of
 *      options (no reliance on the API default).
 *  (3) EXACTLY-ONCE CREATE — generateVideo(existingVideoId) SKIPS the create POST
 *      and polls that id to terminal; a failed/timed-out poll returns `videoId`
 *      so callers can persist it and resume — never re-POST the same block.
 *      onVideoCreated fires with the id BEFORE polling (durable persistence).
 * Also covers the ~12-min poll window (120 sanity-cap @ 10s→20s backoff, no
 * elapsed-time abandonment of in_progress jobs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  SoraVideoService,
  snapSora16or20,
  sanitizeNeedSeconds,
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
  assert.equal(sanitizeNeedSeconds(130), 130, 'core clamp is floor-only (no extension cap in core)');
  assert.equal(sanitizeNeedSeconds(undefined), 20, 'default need = 20s single take');
  assert.equal(sanitizeNeedSeconds(12), 12);
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
    assert.equal(mock.extCount(), 0, '12s block never touches the extensions endpoint');
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

// ─── (2) EXPLICIT SIZE ────────────────────────────────────────────────────────
test('SIZE: every create body is explicit 720x1280 — never API-default-dependent', async () => {
  const mock = installMock();
  try {
    const result = await svc().generateVideo('size contract', {});
    assert.ok(result.success, result.error);
    const create = mock.calls.find(c => /\/v1\/videos$/.test(c.url) && c.method === 'POST');
    assert.ok(create, 'create POST captured');
    assert.equal(create!.body.size, '720x1280', 'explicit size with zero options');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

// ─── (3) EXACTLY-ONCE CREATE ──────────────────────────────────────────────────
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

test('EXACTLY-ONCE: onVideoCreated fires with the id BEFORE polling (durable persistence point)', async () => {
  const mock = installMock();
  const seen: string[] = [];
  const pollUrlsAfterCreate: string[] = [];
  try {
    const result = await svc().generateVideo('continuity block', {
      needSeconds: 20,
      onVideoCreated: (id) => { seen.push(id); },
    });
    assert.ok(result.success, result.error);
    assert.deepEqual(seen, ['vid-create-1'], 'exactly one id reported, before any poll/download');
    assert.equal(result.videoId, 'vid-create-1');
    const polls = mock.calls.filter(c => c.method === 'GET' && c.url.includes('/v1/videos/') && !c.url.endsWith('/content'));
    assert.ok(polls.length >= 1, 'initial id polled after the callback');
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

// ─── POLL WINDOW (~12-min, no elapsed abandonment) ────────────────────────────
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

test('POLL: an in_progress job is polled repeatedly and completes (mocked)', async () => {
  const mock = installMock({ inProgressPolls: 3 });
  try {
    const result = await svc().generateVideo('slow job', {});
    assert.ok(result.success, result.error);
    const polls = mock.calls.filter(c => c.method === 'GET' && c.url.includes('/v1/videos/') && !c.url.endsWith('/content'));
    assert.ok(polls.length >= 4, `kept polling while in_progress (${polls.length} polls)`);
    cleanup([result.videoPath]);
  } finally { mock.restore(); }
});

const dir = path.join(process.cwd(), 'public', 'assets', 'cinema', 'sora');
try {
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('sora_')) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
  }
} catch { /* ignore */ }