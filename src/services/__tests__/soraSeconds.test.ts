/**
 * Unit tests for the Sora 2 `seconds` parameter (official clip-length enum).
 * NO paid renders — fetch is mocked; verifies the POST body contract only.
 *
 * Context: the Scene hybrid pipeline sends ONE Sora call for the ~20s important
 * block. The live Sora 2 API REJECTS a free-form `duration` (400 unknown
 * parameter) and does NOT change length from prose — the prompting guide and
 * video-generation guide confirm `seconds` ("4"|"8"|"12"|"16"|"20", default "4")
 * is the ONLY length control. FFmpeg -stream_loop -1 + -t remains a safety net.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapSoraSeconds, buildSoraCreateBody, soraVideoService, SORA_SCENE_SIZE } from '../soraVideoService.js';

test('snapSoraSeconds maps targets onto the official enum', () => {
  assert.equal(snapSoraSeconds(20), '20');
  assert.equal(snapSoraSeconds(21), '20'); // never exceeds 20s
  assert.equal(snapSoraSeconds(100), '20');
  assert.equal(snapSoraSeconds(18), '16'); // nearest
  assert.equal(snapSoraSeconds(15), '16'); // nearest (round-half-up)
  assert.equal(snapSoraSeconds(10), '8');  // tie 8|12 -> shorter (cost-honest)
  assert.equal(snapSoraSeconds(6), '4');  // tie 4|8 -> shorter (cost-honest)
  assert.equal(snapSoraSeconds(7), '8');  // nearest
  assert.equal(snapSoraSeconds(3), '4');   // clamp
  assert.equal(snapSoraSeconds(0), '4');   // clamp
  assert.equal(snapSoraSeconds(NaN), '4'); // degenerate
});

test('buildSoraCreateBody includes seconds and never duration', () => {
  const body = buildSoraCreateBody('sora-2', 'a hero moment', { seconds: '20' });
  assert.equal(body.seconds, '20');
  assert.equal(body.model, 'sora-2');
  assert.equal('duration' in body, false, 'legacy duration must never be sent');

  // size is set explicitly for the deterministic 9:16 contract.
  const bodyWithSize = buildSoraCreateBody('sora-2', 'x', { seconds: '20', size: SORA_SCENE_SIZE });
  assert.equal(bodyWithSize.size, '720x1280');
  assert.equal('duration' in bodyWithSize, false);

  // No seconds option -> no seconds key (API default "4" applies).
  const body2 = buildSoraCreateBody('sora-2', 'x', {});
  assert.equal('seconds' in body2, false);
  assert.equal('duration' in body2, false);
});

test('generateVideo POSTs seconds:"20" for the important block (mocked fetch)', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  const completedJson = {
    id: 'vid-test-1',
    status: 'completed',
  };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/v1/videos') && !url.includes('vid-test-1')) {
      return new Response(JSON.stringify(completedJson), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // GET /v1/videos/{id} poll -> completed immediately
    return new Response(JSON.stringify({ status: 'completed' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const result = await soraVideoService.generateVideo('hero content', {
      userId: undefined,
      seconds: '20',
      size: SORA_SCENE_SIZE,
      promptHint: 'one continuous take',
    });

    assert.ok(result.success, `should succeed, got error=${result.error}`);
    assert.ok(calls.some((c) => c.url.endsWith('/v1/videos') && !c.url.includes('/content')), 'should POST to /v1/videos');
    const createCall = calls.find((c) => c.url.endsWith('/v1/videos') && !c.url.includes('/content'));
    assert.ok(createCall, 'create call captured');
    assert.equal(createCall!.body.seconds, '20', 'POST body must carry seconds:"20"');
    assert.equal(createCall!.body.size, '720x1280', 'POST body must carry explicit size for the 9:16 contract');
    assert.equal(createCall!.body.model, 'sora-2');
    assert.equal('duration' in createCall!.body, false, 'legacy duration must never be in the POST body');
    assert.ok(String(createCall!.body.prompt).includes('one continuous take'), 'promptHint remains as content steer');
  } finally {
    globalThis.fetch = originalFetch;
  }
});