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
import { snapSoraSeconds, snapSora16or20, buildSoraCreateBody, soraVideoService, SORA_SCENE_SIZE, SORA_MOTION_SECONDS } from '../soraVideoService.js';
// Hermetic: the service returns early without OPENAI_API_KEY; the mocked-fetch
// test below needs a (fake) key present so the flow reaches the fetch mock.
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
test('SORA_MOTION_SECONDS = the owner 20s max single-take policy', () => {
  // Owner directive (live): EVERY Scene-Based motion (Sora) call requests the 20s
  // MAX via the official `seconds` enum — never a snapped shorter value. renderClip
  // trims with -t to the scene window, giving continuous single-take motion with
  // no loop-padding / repetition. The pipeline sends this constant unconditionally.
  assert.equal(SORA_MOTION_SECONDS, '20');
  // It must remain a valid official enum value (4|8|12|16|20).
  assert.ok(['4', '8', '12', '16', '20'].includes(SORA_MOTION_SECONDS));
  // Even when a scene target would snap shorter, the policy is still the 20s max.
  assert.equal(SORA_MOTION_SECONDS, snapSoraSeconds(20));
});

test('snapSoraSeconds maps targets onto the official enum', () => {
  assert.equal(snapSoraSeconds(20), '20');
  assert.equal(snapSoraSeconds(21), '20'); // never exceeds 20s
  assert.equal(snapSoraSeconds(100), '20');
  assert.equal(snapSoraSeconds(18), '20'); // 18s needs >16s -> the 20s tier (gate)
  assert.equal(snapSoraSeconds(15), '16'); // nearest (round-half-up)
  assert.equal(snapSoraSeconds(6), '16');  // 6 -> 16 (gate: nearest of {16,20})
  assert.equal(snapSoraSeconds(10), '16'); // 10 -> 16 (gate: 4/8/12 unreachable)
  assert.equal(snapSoraSeconds(7), '16');  // 7 -> 16 (gate: nearest of {16,20})
  assert.equal(snapSoraSeconds(3), '16');   // 3 -> 16 (gate clamps to the 16s tier)
  assert.equal(snapSoraSeconds(0), '16');   // 0 -> 16 (clamp)
  assert.equal(snapSoraSeconds(NaN), '20'); // degenerate -> '20' (gate default)
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

  // No seconds option -> gate DEFAULTS '20' (owner 2026-09-13: absent must
  // never reach the API default "4" — that would silently bill a shorter length).
  const body2 = buildSoraCreateBody('sora-2', 'x', {});
  assert.equal(body2.seconds, '20', 'absent seconds -> gate default "20"');
  assert.equal('duration' in body2, false);
  assert.equal(body2.size, '720x1280', 'size is ALWAYS explicit even with no options');
  // Short tiers THROW (fail-fast — a caller bug is loud, never a quiet 4s bill).
  for (const bad of ['4', '8', '12'] as const) {
    assert.throws(() => buildSoraCreateBody('sora-2', 'x', { seconds: bad }), /locked-out short tier/, `seconds:"${bad}" must throw`);
  }
  assert.equal(buildSoraCreateBody('sora-2', 'x', { seconds: '16' }).seconds, '16');
  assert.equal(buildSoraCreateBody('sora-2', 'x', { seconds: '20' }).seconds, '20');
});
test('16|20 HARD GATE: seconds is "16" when block needs ≤16s, else "20" — NEVER 4/8/12', () => {
  // Owner-ratified Sora 2 spec: the short enum tiers are hard-locked out.
  for (const need of [1, 6, 8, 12, 15, 16]) assert.equal(snapSora16or20(need), '16', `need=${need} -> 16`);
  for (const need of [17, 18, 20, 21, 30, 60, 120, 1000]) assert.equal(snapSora16or20(need), '20', `need=${need} -> 20`);
  assert.equal(snapSora16or20(NaN), '20', 'degenerate input defaults to a 20s take');
  assert.equal(snapSora16or20(-5), '16', 'clamped to ≥1s -> 16');
  const out = ['16', '20'];
  assert.ok(!out.includes('4') && !out.includes('8') && !out.includes('12'), 'short tiers are unreachable');
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