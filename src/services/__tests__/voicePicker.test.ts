/**
 * THE VOICE PICKER — backend half (owner, 23 Nov).
 *
 * What must be true before the Studio can offer it:
 *   1. every catalogue voice is offered under exactly ONE gender, none missing,
 *      none in both (the split is the measured-f0 split, not a guess);
 *   2. an explicit voice WINS over the tone;
 *   3. with no voice chosen, `resolveVoice` is byte-for-byte today's answer (the
 *      regression guard — every existing caller and the launch gate must not move);
 *   4. an unknown voice is a 400 and buys NOTHING;
 *   5. an unknown tone is a 400 and buys NOTHING;
 *   6. the sample route returns audio/mpeg and sends the SAME voice id and the SAME
 *      tone instruction the narration call would send — asserted on the request body
 *      a stubbed provider receives, not on our own arguments;
 *   7. the second request for the same `voice-tone` makes no second provider call.
 *
 * Everything here is $0: the only provider is a stubbed `fetch`, and the real
 * `fetch` still carries the test's own HTTP to the loopback server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import voiceRoutes from '../../routes/voiceRoutes.js';
import {
  GPT_AUDIO_VOICES,
  VOICE_CATALOGUE,
  VOICE_TONES,
  resolveVoice,
  voiceCataloguePayload,
} from '../voiceOptions.js';
import {
  VOICE_SAMPLE_TEXT,
  __clearVoiceSampleCache,
  voiceSampleInstruction,
} from '../voiceSampleService.js';
import { __paidCallAttempts, __resetPaidCallAttempts, __resetPaidFailures } from '../paidCallGate.js';
import { ttsReadAloudInstruction } from '../creativeTransformation.js';

/** A tiny stand-in for a real mp3 — the route must hand back exactly these bytes. */
const FAKE_MP3 = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000-fake-mp3-payload', 'binary');

/** Mount the REAL router in a REAL Express app, exactly as the API mounts it. */
async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use('/api/voices', voiceRoutes);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Replace the provider with a stub that records the request body it was given.
 * Anything NOT addressed to OpenAI is passed to the real fetch, so the test's own
 * HTTP to the loopback server still works.
 */
async function withStubbedAudioProvider<T>(
  fn: (ctx: { calls: any[]; bodies: string[] }) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  const calls: any[] = [];
  const bodies: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url.includes('api.openai.com')) {
      bodies.push(String(init?.body ?? ''));
      calls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(
        JSON.stringify({ choices: [{ message: { audio: { data: FAKE_MP3.toString('base64') } } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    return await fn({ calls, bodies });
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** A fresh, empty sample cache dir per test, so "cached" means THIS test's cache. */
function withFreshCacheDir(): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-sample-test-'));
  const previous = process.env.VOICE_SAMPLE_CACHE_DIR;
  process.env.VOICE_SAMPLE_CACHE_DIR = dir;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-a-real-credential';
  __clearVoiceSampleCache();
  __resetPaidCallAttempts();
  __resetPaidFailures();
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.VOICE_SAMPLE_CACHE_DIR;
      else process.env.VOICE_SAMPLE_CACHE_DIR = previous;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      __clearVoiceSampleCache();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── 1. the catalogue ────────────────────────────────────────────────────────
test('catalogue: every voice is under exactly one gender, none missing, none in both', () => {
  const payload = voiceCataloguePayload();
  const seen = new Map<string, string[]>();
  for (const gender of payload.genders) {
    for (const v of gender.voices) {
      seen.set(v.id, [...(seen.get(v.id) || []), gender.id]);
    }
  }
  // No voice missing, none invented.
  assert.deepEqual([...seen.keys()].sort(), [...GPT_AUDIO_VOICES].sort());
  // Exactly one gender each.
  for (const [id, genders] of seen) {
    assert.equal(genders.length, 1, `voice '${id}' is offered under ${genders.length} genders: ${genders.join(', ')}`);
  }
  // The measured split (never move a voice across).
  const female = payload.genders.find((g) => g.id === 'female')!.voices.map((v) => v.id).sort();
  const male = payload.genders.find((g) => g.id === 'male')!.voices.map((v) => v.id).sort();
  assert.deepEqual(female, ['ballad', 'coral', 'nova', 'sage', 'shimmer']);
  assert.deepEqual(male, ['alloy', 'ash', 'echo', 'fable', 'onyx', 'verse']);
  // Every card can be played, and every tone is offered.
  for (const gender of payload.genders) {
    for (const v of gender.voices) assert.equal(v.sampleUrl, `/api/voices/${v.id}/sample`);
  }
  assert.deepEqual(payload.tones.map((t) => t.id), [...VOICE_TONES]);
  assert.equal(payload.defaultVoice, 'auto');
  // The character line is two or three honest words, never empty.
  for (const v of VOICE_CATALOGUE) {
    assert.ok(v.character.trim().split(/\s+/).length >= 1, `voice '${v.id}' has no character words`);
    assert.ok(v.character.trim().split(/\s+/).length <= 3, `voice '${v.id}' has more than three words`);
  }
});

// ── 2 & 3. resolveVoice ─────────────────────────────────────────────────────
test('an explicit voice wins over the tone', () => {
  assert.equal(resolveVoice('female', 'calm', 'shimmer'), 'shimmer');
  assert.equal(resolveVoice('female', 'enthusiastic', 'ballad'), 'ballad');
  assert.equal(resolveVoice('male', 'serious', 'verse'), 'verse');
});

test('no voice chosen → exactly today’s gender+tone answers (regression guard)', () => {
  assert.equal(resolveVoice('female', 'calm'), 'sage');
  assert.equal(resolveVoice('female', 'calm', undefined), 'sage');
  assert.equal(resolveVoice('female', 'calm', 'auto'), 'sage');
  assert.equal(resolveVoice('female', 'auto'), 'nova');
  assert.equal(resolveVoice('male', 'auto'), 'echo');
  assert.equal(resolveVoice('female', 'enthusiastic'), 'nova');
  assert.equal(resolveVoice('male', 'serious'), 'onyx');
  assert.equal(resolveVoice(undefined, undefined), 'nova');
});

// ── 4 & 5. the route refuses, and buys nothing ──────────────────────────────
test('an unknown voice is a 400 and no provider is touched', async () => {
  const cache = withFreshCacheDir();
  try {
    await withStubbedAudioProvider(async ({ calls }) => {
      await withServer(async (base) => {
        const r = await fetch(`${base}/api/voices/not-a-voice/sample?tone=calm`);
        assert.equal(r.status, 400);
        const body: any = await r.json();
        assert.match(body.error, /Unknown voice/);
        assert.equal(calls.length, 0, 'no provider call may be made for an unknown voice');
        assert.equal(__paidCallAttempts().audio, 0, 'an unknown voice must not even reach the paid-call gate');
      });
    });
  } finally {
    cache.restore();
  }
});

test('an unknown tone is a 400 and no provider is touched', async () => {
  const cache = withFreshCacheDir();
  try {
    await withStubbedAudioProvider(async ({ calls }) => {
      await withServer(async (base) => {
        const r = await fetch(`${base}/api/voices/nova/sample?tone=shouty`);
        assert.equal(r.status, 400);
        const body: any = await r.json();
        assert.match(body.error, /Unknown tone/);
        assert.equal(calls.length, 0);
        assert.equal(__paidCallAttempts().audio, 0);
      });
    });
  } finally {
    cache.restore();
  }
});

// ── 6 & 7. the sample is the pipeline's own call, generated once ────────────
test('the sample is audio/mpeg and sends the pipeline’s own voice id and tone instruction', async () => {
  const cache = withFreshCacheDir();
  try {
    await withStubbedAudioProvider(async ({ calls }) => {
      await withServer(async (base) => {
        const r = await fetch(`${base}/api/voices/shimmer/sample?tone=calm`);
        assert.equal(r.status, 200);
        assert.match(String(r.headers.get('content-type')), /^audio\/mpeg/);
        const bytes = Buffer.from(await r.arrayBuffer());
        assert.deepEqual(bytes, FAKE_MP3, 'the route must return the provider’s bytes untouched');

        assert.equal(calls.length, 1);
        const body = calls[0];
        // SAME path as the pipeline's narration call.
        assert.equal(body.model, 'gpt-audio');
        assert.deepEqual(body.modalities, ['text', 'audio']);
        assert.equal(body.audio.format, 'mp3');
        assert.equal(body.audio.voice, 'shimmer', 'the sample must be the voice she picked');
        // SAME instruction the pipeline sends for this tone.
        assert.equal(body.messages[0].role, 'system');
        assert.equal(body.messages[0].content, ttsReadAloudInstruction('calm'));
        assert.equal(body.messages[0].content, voiceSampleInstruction('calm'));
        assert.equal(body.messages[1].role, 'user');
        assert.equal(body.messages[1].content, VOICE_SAMPLE_TEXT);
        // And it went through the one paid-call choke point.
        assert.equal(__paidCallAttempts().audio, 1);
      });
    });
  } finally {
    cache.restore();
  }
});

test('the second request for the same voice-tone makes no second provider call', async () => {
  const cache = withFreshCacheDir();
  try {
    await withStubbedAudioProvider(async ({ calls }) => {
      await withServer(async (base) => {
        const first = await fetch(`${base}/api/voices/coral/sample?tone=warm`);
        assert.equal(first.status, 200);
        assert.equal(calls.length, 1);
        const second = await fetch(`${base}/api/voices/coral/sample?tone=warm`);
        assert.equal(second.status, 200);
        assert.deepEqual(Buffer.from(await second.arrayBuffer()), FAKE_MP3);
        assert.equal(calls.length, 1, 'the cached clip must be served without buying it again');
        // A different tone is a different clip, so it does buy once.
        const third = await fetch(`${base}/api/voices/coral/sample?tone=serious`);
        assert.equal(third.status, 200);
        assert.equal(calls.length, 2);
      });
    });
  } finally {
    cache.restore();
  }
});

test('a cache miss after a restart is served from the disk cache, not bought again', async () => {
  const cache = withFreshCacheDir();
  try {
    await withStubbedAudioProvider(async ({ calls }) => {
      await withServer(async (base) => {
        const first = await fetch(`${base}/api/voices/onyx/sample?tone=auto`);
        assert.equal(first.status, 200);
        assert.equal(calls.length, 1);
        // Railway's disk survives between requests but not a deploy; the in-process
        // copy is what a restart loses. Forget it and prove the file answers.
        __clearVoiceSampleCache();
        const second = await fetch(`${base}/api/voices/onyx/sample?tone=auto`);
        assert.equal(second.status, 200);
        assert.deepEqual(Buffer.from(await second.arrayBuffer()), FAKE_MP3);
        assert.equal(calls.length, 1);
        assert.ok(fs.existsSync(path.join(cache.dir, 'onyx-auto.mp3')));
      });
    });
  } finally {
    cache.restore();
  }
});
