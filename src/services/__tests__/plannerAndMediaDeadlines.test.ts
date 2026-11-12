/**
 * DEADLINES — the planner call and every media child (audit 11 Nov, defect 5).
 *
 * The defect these pin down: `createProject` awaited a bare `fetch` with no
 * `AbortSignal`, so a stalled LLM connection hung the whole HTTP request — no
 * receipt, no project row, no render, no message — and every ffmpeg/ffprobe
 * child ran unbounded (the synchronous probes blocking the event loop for every
 * user on the box).
 *
 * These fixtures execute the REAL path: `aiRouter.route` in generate mode is the
 * planner `createProject` calls, `runPlanningAttempts` → `classifyPlannerOutcome`
 * → `plannerFailureNotice` is the graph that turns a failed planning call into a
 * client sentence, and `sliceSoraTake` / `probeDuration` are the same execFile /
 * execFileSync wrappers every render step uses. The provider is stubbed at its
 * boundary and the deadlines are shortened through their env overrides, so the
 * proof costs milliseconds and zero paid calls: no network, no image, no voice,
 * no motion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { aiRouter } from '../aiRouter.js';
import { classifyPlannerOutcome, plannerFailureNotice, runPlanningAttempts } from '../plannerOutcome.js';
import { mediaToolTimeoutMs, probeDuration, sliceSoraTake } from '../sceneVideoPipelineService.js';

/** A fetch that NEVER answers, but honours the deadline signal like real fetch:
 *  when the AbortSignal fires it rejects with the same DOMException name undici
 *  raises on a timed-out request. */
function installStalledProvider(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: any, init: any) =>
    new Promise((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      // A real in-flight request holds a socket, which keeps the event loop
      // alive; `AbortSignal.timeout` uses an UNREF'd timer, so without this the
      // loop would drain and the fixture would look like a hang of its own.
      const inFlight = setTimeout(() => {}, 60_000);
      const kill = () => {
        clearTimeout(inFlight);
        const e: any = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        reject(e);
      };
      if (signal?.aborted) return kill();
      signal?.addEventListener('abort', kill);
    })) as any;
  return () => { globalThis.fetch = original; };
}

function withPlannerKeys(fn: () => Promise<void>) {
  const saved = {
    openai: process.env.OPENAI_API_KEY,
    gs: process.env.GOOGLE_STUDIO_API_KEY,
    g: process.env.GOOGLE_API_KEY,
    budget: process.env.PLANNER_TIMEOUT_MS,
  };
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  delete process.env.GOOGLE_STUDIO_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  process.env.PLANNER_TIMEOUT_MS = '150';
  return fn().finally(() => {
    for (const [key, value] of [
      ['OPENAI_API_KEY', saved.openai],
      ['GOOGLE_STUDIO_API_KEY', saved.gs],
      ['GOOGLE_API_KEY', saved.g],
      ['PLANNER_TIMEOUT_MS', saved.budget],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('a stalled planner returns a readable timeout instead of hanging the request', async () => {
  const restore = installStalledProvider();
  try {
    await withPlannerKeys(async () => {
      const started = Date.now();
      let caught: any = null;
      try {
        // The REAL planner entry point the pipeline calls in generate mode.
        await aiRouter.route({ userId: 'deadline-fixture', request: 'make me a 30 second product video', mode: 'generate' });
      } catch (err) {
        caught = err;
      }
      const elapsed = Date.now() - started;

      assert.ok(caught, 'a stalled provider must not be answered as if the model had replied');
      assert.equal(caught.code, 'PLANNER_TIMEOUT');
      assert.match(String(caught.message), /TIMED OUT after 150ms/);
      assert.match(String(caught.message), /nothing was planned and nothing was spent|no motion was purchased/i);
      assert.ok(elapsed < 3_000, `the deadline must fire promptly, took ${elapsed}ms`);
    });
  } finally {
    restore();
  }
});

test('a stalled planner becomes the client-facing "we did not make this video" answer', async () => {
  const restore = installStalledProvider();
  try {
    await withPlannerKeys(async () => {
      // Exactly what createProject does with a planner that throws: record the
      // call as failed, classify it, and turn it into the sentence the client reads.
      let detail = '';
      try {
        await runPlanningAttempts({
          sceneCount: 5,
          call: () => aiRouter.route({ userId: 'deadline-fixture', request: 'make me a video', mode: 'generate' }),
        });
      } catch (err: any) {
        detail = `planner call failed: ${err?.message || err}`;
      }
      assert.match(detail, /TIMED OUT/);

      const outcome = classifyPlannerOutcome({ payload: undefined, attempts: 1, detail, sceneCount: 5 });
      assert.equal(outcome.reason, 'planner-call-failed');
      assert.equal(outcome.planned, false);

      const notice = plannerFailureNotice(outcome);
      assert.equal(notice.code, 'PLANNING_FAILED');
      assert.match(notice.message, /We didn't make this video/);
      assert.match(notice.message, /could not be reached/);
      assert.match(notice.message, /no motion was purchased/);
      // The client sentence never leaks internal vocabulary.
      assert.doesNotMatch(notice.message, /planner|Gemini|GPT|timeout|template/i);
    });
  } finally {
    restore();
  }
});

test('consult mode still answers when the provider stalls — a chat is not a plan', async () => {
  const restore = installStalledProvider();
  try {
    await withPlannerKeys(async () => {
      const decision = await aiRouter.route({ userId: 'deadline-fixture', request: 'hello there', mode: 'consult' });
      assert.equal(typeof decision.classification, 'string');
      assert.ok(decision.response, 'consult keeps degrading to a conversational reply');
    });
  } finally {
    restore();
  }
});

/** A stand-in `ffmpeg`/`ffprobe` that never finishes, so the deadline is the
 *  only thing that can end the call. */
function installHangingTools(): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hang-tools-'));
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const p = path.join(dir, tool);
    fs.writeFileSync(p, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  }
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
  return {
    dir,
    restore: () => {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a hung ffmpeg is killed at its deadline and the step fails with a readable reason', async () => {
  const tools = installHangingTools();
  const savedBudget = process.env.FFMPEG_TIMEOUT_MS;
  process.env.FFMPEG_TIMEOUT_MS = '250';
  try {
    const started = Date.now();
    let caught: any = null;
    try {
      await sliceSoraTake('/tmp/never-read.mp4', '/tmp/never-written.mp4', 0, 3);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;

    assert.ok(caught, 'a hung ffmpeg must reject, not resolve and not hang');
    assert.match(String(caught.message), /ffmpeg TIMED OUT after 250ms and was killed/);
    assert.match(String(caught.message), /sliceSoraTake/);
    assert.ok(elapsed < 5_000, `the deadline must fire promptly, took ${elapsed}ms`);
  } finally {
    if (savedBudget === undefined) delete process.env.FFMPEG_TIMEOUT_MS;
    else process.env.FFMPEG_TIMEOUT_MS = savedBudget;
    tools.restore();
  }
});

test('a hung ffprobe cannot block the synchronous probe forever', async () => {
  const tools = installHangingTools();
  const savedBudget = process.env.FFPROBE_TIMEOUT_MS;
  process.env.FFPROBE_TIMEOUT_MS = '250';
  try {
    const started = Date.now();
    // probeDuration is the synchronous probe every render step calls; a wedged
    // ffprobe used to freeze the event loop for every user on the box.
    const seconds = probeDuration('/tmp/never-read.mp4');
    const elapsed = Date.now() - started;

    assert.equal(seconds, 0, 'an unmeasurable probe reports 0 (the caller keeps its planned window)');
    assert.ok(elapsed < 5_000, `the deadline must fire promptly, took ${elapsed}ms`);
  } finally {
    if (savedBudget === undefined) delete process.env.FFPROBE_TIMEOUT_MS;
    else process.env.FFPROBE_TIMEOUT_MS = savedBudget;
    tools.restore();
  }
});

test('the deadlines are bounded by default and overridable', () => {
  const saved = { ffmpeg: process.env.FFMPEG_TIMEOUT_MS, ffprobe: process.env.FFPROBE_TIMEOUT_MS };
  delete process.env.FFMPEG_TIMEOUT_MS;
  delete process.env.FFPROBE_TIMEOUT_MS;
  try {
    assert.equal(mediaToolTimeoutMs('ffmpeg'), 180_000);
    assert.equal(mediaToolTimeoutMs('ffprobe'), 30_000);
    process.env.FFMPEG_TIMEOUT_MS = '1000';
    process.env.FFPROBE_TIMEOUT_MS = '500';
    assert.equal(mediaToolTimeoutMs('ffmpeg'), 1000);
    assert.equal(mediaToolTimeoutMs('ffprobe'), 500);
  } finally {
    for (const [key, value] of [['FFMPEG_TIMEOUT_MS', saved.ffmpeg], ['FFPROBE_TIMEOUT_MS', saved.ffprobe]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
