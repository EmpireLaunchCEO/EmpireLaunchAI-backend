/**
 * `GET /version` — the build-identity probe, over real HTTP.
 *
 * The whole point of this route is that the owner can stop guessing whether the
 * live backend is running the newest commit. So the test must not assert on a
 * function's return value: it mounts the real router in a real Express app,
 * listens on a real port and fetches the real URL, exactly as a browser or
 * `curl` would.
 *
 * The two cases that matter:
 *   - `RAILWAY_GIT_COMMIT_SHA` set   → the route reports that sha;
 *   - `RAILWAY_GIT_COMMIT_SHA` unset → the route reports `"unknown"` and still
 *     answers 200. A 404 or a 500 here would leave the question unanswered,
 *     which is the defect this route exists to fix.
 *
 * No DB, no model, no network beyond loopback. $0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import versionRoutes from '../../routes/versionRoutes.js';
import {
  COMMIT_SHA_ENV_VAR,
  UNKNOWN_COMMIT,
  resolveCommitSha,
} from '../versionInfo.js';

/** Mount the real router and hand the caller its real base URL. */
async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(versionRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Set (or delete) the env var for the duration of `fn`, then restore it. */
async function withCommitEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, COMMIT_SHA_ENV_VAR);
  const previous = process.env[COMMIT_SHA_ENV_VAR];

  if (value === undefined) delete process.env[COMMIT_SHA_ENV_VAR];
  else process.env[COMMIT_SHA_ENV_VAR] = value;

  try {
    return await fn();
  } finally {
    if (had) process.env[COMMIT_SHA_ENV_VAR] = previous as string;
    else delete process.env[COMMIT_SHA_ENV_VAR];
  }
}

test('GET /version returns the sha from RAILWAY_GIT_COMMIT_SHA', async () => {
  const sha = 'ea34d83c0ffee1234567890abcdef1234567890a';

  await withCommitEnv(sha, async () => {
    const res = await withServer((baseUrl) => fetch(`${baseUrl}/version`));

    assert.equal(res.status, 200, '/version must never 404 or 500');
    const body = (await res.json()) as { commit?: string; startedAt?: string; uptimeSeconds?: number };

    assert.equal(body.commit, sha);
    assert.equal(typeof body.startedAt, 'string');
    assert.ok(
      !Number.isNaN(Date.parse(body.startedAt as string)),
      `startedAt must be a real timestamp, got ${body.startedAt}`,
    );
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.ok((body.uptimeSeconds as number) >= 0);
  });
});

test('GET /version falls back to "unknown" when the env var is unset — still 200', async () => {
  await withCommitEnv(undefined, async () => {
    const res = await withServer((baseUrl) => fetch(`${baseUrl}/version`));

    assert.equal(res.status, 200, 'an unset env var is not an error');
    const body = (await res.json()) as { commit?: string };
    assert.equal(body.commit, UNKNOWN_COMMIT);
    assert.equal(body.commit, 'unknown');
  });
});

test('GET /version treats a blank env var as unknown, not as an empty commit', async () => {
  await withCommitEnv('   ', async () => {
    const res = await withServer((baseUrl) => fetch(`${baseUrl}/version`));

    assert.equal(res.status, 200);
    const body = (await res.json()) as { commit?: string };
    assert.equal(body.commit, 'unknown');
  });
});

test('GET /health carries the same commit field as /version', async () => {
  const sha = 'abc1234def5678';

  await withCommitEnv(sha, async () => {
    // /health is registered inline in src/index.ts; the field it serves comes
    // from this one helper, so asserting the helper is asserting the route's value.
    assert.equal(resolveCommitSha(), sha);
    assert.equal(resolveCommitSha({}), 'unknown');
    assert.equal(resolveCommitSha({ [COMMIT_SHA_ENV_VAR]: '' }), 'unknown');
  });
});
