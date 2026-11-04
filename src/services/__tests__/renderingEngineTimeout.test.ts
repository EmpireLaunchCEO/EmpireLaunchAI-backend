/**
 * TIMEOUT HARDENING (task 285c9027 — owner-authorized Oct 19 after the fidelity
 * fix landed): deterministic tests for the gpt-image-2 still-gen fetch wrapper.
 *   (1) RETRY EXACTLY ONCE when the first attempt dies to AbortSignal.timeout
 *       (TimeoutError) — the retry runs with a FRESH, non-aborted signal.
 *   (2) NO retry when the first attempt succeeds — completed work is never
 *       duplicated (exactly-once still semantics).
 *   (3) NO retry on API errors (content-policy/400/429/5xx…) — they propagate.
 *   (4) AbortError (external abort) also retries exactly once.
 *   (5) isAbortLikeError classifies timeout/abort vs everything else.
 *   (6) SOURCE CONTRACT: renderingEngine.ts must wrap BOTH still-gen call sites
 *       (generations + edits) with fetchWithRetryOnTimeout, keep the 300s
 *       window constant, and never regress to a 180s AbortSignal.timeout.
 * ZERO paid API calls — a fake fetchImpl drives every path deterministically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GPT_IMAGE_STILL_TIMEOUT_MS,
  isAbortLikeError,
  fetchWithRetryOnTimeout,
} from '../renderingEngine.js';

const FAKE_ENDPOINT = 'https://api.openai.com/v1/images/generations';

function namedError(name: string, message = `boom: ${name}`): Error {
  const err = new Error(message);
  Object.defineProperty(err, 'name', { value: name });
  return err;
}

test('retries EXACTLY once when the first attempt times out (TimeoutError)', async () => {
  let calls = 0;
  const okResponse = { ok: true, status: 200 } as unknown as Response;
  const impl = async (): Promise<Response> => {
    calls++;
    if (calls === 1) throw namedError('TimeoutError', 'signal timed out');
    return okResponse;
  };
  const out = await fetchWithRetryOnTimeout(impl as typeof fetch, FAKE_ENDPOINT, {});
  assert.equal(calls, 2, 'timeout must retry exactly once');
  assert.equal(out, okResponse);
});

test('NO retry when the first attempt succeeds — completed work is never duplicated', async () => {
  let calls = 0;
  const impl = async (): Promise<Response> => {
    calls++;
    return { ok: true, status: 200 } as unknown as Response;
  };
  const out = await fetchWithRetryOnTimeout(impl as typeof fetch, FAKE_ENDPOINT, {});
  assert.equal(calls, 1, 'success must never trigger a second call');
  assert.equal(out.ok, true);
});

test('NO retry on API errors — error propagates untouched, single attempt', async () => {
  let calls = 0;
  const apiErr = namedError('Error', 'gpt-image-2 API error (400): content policy');
  const impl = async (): Promise<Response> => {
    calls++;
    throw apiErr;
  };
  await assert.rejects(
    () => fetchWithRetryOnTimeout(impl as typeof fetch, FAKE_ENDPOINT, {}),
    (caught: unknown) => caught === apiErr,
  );
  assert.equal(calls, 1, 'API errors must not be retried');
});

test('AbortError also retries exactly once and the retry uses a fresh non-aborted signal', async () => {
  const signals: Array<AbortSignal | undefined | null> = [];
  let calls = 0;
  const impl = async (_url: string, init?: RequestInit): Promise<Response> => {
    calls++;
    signals.push(init?.signal);
    if (calls === 1) throw namedError('AbortError', 'The operation was aborted');
    return { ok: true, status: 200 } as unknown as Response;
  };
  const out = await fetchWithRetryOnTimeout(impl as typeof fetch, FAKE_ENDPOINT, {});
  assert.equal(calls, 2, 'abort must retry exactly once');
  assert.notEqual(signals[0], signals[1], 'retry must get a fresh AbortSignal');
  assert.equal(signals[1]?.aborted, false, 'retry signal must start non-aborted');
  assert.equal(out.ok, true);
});

test('isAbortLikeError classifies timeout/abort vs everything else', () => {
  assert.equal(isAbortLikeError(namedError('TimeoutError')), true);
  assert.equal(isAbortLikeError(namedError('AbortError')), true);
  assert.equal(isAbortLikeError(new Error('gpt-image-2 API error (500)')), false);
  assert.equal(isAbortLikeError(null), false);
  assert.equal(isAbortLikeError(undefined), false);
  assert.equal(isAbortLikeError('timeout'), false);
});

test('SOURCE CONTRACT: both still-gen call sites use the 300s wrapper — no 180s AbortSignal remains', () => {
  const src = readFileSync(new URL('../renderingEngine.ts', import.meta.url), 'utf8');
  const wrappedCalls = src.match(/fetchWithRetryOnTimeout\(/g) ?? [];
  assert.ok(
    wrappedCalls.length >= 2,
    `expected BOTH still-gen call sites wrapped, got ${wrappedCalls.length}`,
  );
  assert.ok(
    src.includes('GPT_IMAGE_STILL_TIMEOUT_MS = 300_000'),
    '300s window constant must be defined',
  );
  assert.ok(
    !/AbortSignal\.timeout\(180000\)/.test(src),
    '180s AbortSignal.timeout must be gone from renderingEngine.ts',
  );
  assert.equal(GPT_IMAGE_STILL_TIMEOUT_MS, 300_000);
});