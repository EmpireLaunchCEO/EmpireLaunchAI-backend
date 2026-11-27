/**
 * AUTHENTICATION IS REAL (owner, Nov 27: "fix authentication first").
 *
 * Before this change, identity was whatever a request claimed:
 *   - `mobileAuth` auto-provisioned a user row for any anonymous caller, so
 *     `x-user-id: <any id>` was a login;
 *   - a Bearer token that matched nothing fell through to that same branch;
 *   - `POST /api/auth/login` returned no token at all.
 *
 * This suite drives the REAL middleware and the REAL controllers over the REAL
 * Express stack against a REAL database (an on-disk libsql file created for this
 * run), so every assertion below is a fact about the shipped code path — not a
 * restatement of it. No network, no paid call.
 *
 * The negative controls are the point: each of them PASSES only while
 * authentication is enforced, and would FAIL if the old behaviour came back.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

// ── A private database for this run, set BEFORE the db module is imported ────
const DB_FILE = path.join(os.tmpdir(), `auth-required-${crypto.randomUUID()}.db`);
process.env.DATABASE_URL = `file:${DB_FILE}`;
delete process.env.OWNER_MASTER_KEYS;

const express = (await import('express')).default;
const { sql } = await import('drizzle-orm');
const { db } = await import('../../db/index.js');
const { mobileAuth } = await import('../../middleware/mobileAuth.js');
const { loginUser, masterLogin, logoutUser, registerUser } = await import('../../controllers/authController.js');
const { createSession, hashSessionToken } = await import('../authSessions.js');
const studioRoutes = (await import('../../routes/studioRoutes.js')).default;

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_B = '33333333-3333-4333-8333-333333333333';
const LEGACY_PASSWORD = 'hunter2-legacy';
const LEGACY_SALT = 'empire-launch-salt';

let server: http.Server;
let baseUrl = '';

async function exec(statement: string) {
  await (db as any).run(sql.raw(statement));
}

const pbkdf2 = promisify(crypto.pbkdf2);

/** The OLD hash format: unsalted pbkdf2, 1000 iterations, one shared salt. */
async function legacyHash(password: string): Promise<string> {
  const derived = await pbkdf2(password, LEGACY_SALT, 1000, 64, 'sha512');
  return derived.toString('hex');
}

function request(
  pathName: string,
  opts: { token?: string; userId?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.userId) headers['x-user-id'] = opts.userId;

  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${pathName}`,
      { method: opts.method || 'GET', headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed: any = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch {}
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

before(async () => {
  // The tables this path touches, with every column the drizzle schema selects.
  await exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, stripe_account_id TEXT,
    paypal_merchant_id TEXT, terms_accepted_version INTEGER DEFAULT 0, business_slots INTEGER DEFAULT 1,
    is_locked INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, tier TEXT DEFAULT 'STANDARD_USER',
    access_key TEXT, password_hash TEXT, is_review_mode INTEGER DEFAULT 0,
    mobile_session_token TEXT, mobile_session_expires_at INTEGER)`);
  await exec(`CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, user_agent TEXT)`);
  await exec(`CREATE TABLE video_projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, status TEXT, total_duration INTEGER,
    scene_count INTEGER, script TEXT, final_video_url TEXT, thumbnail_url TEXT, metadata TEXT,
    created_at INTEGER, updated_at INTEGER)`);
  await exec(`CREATE TABLE video_scenes (
    id TEXT PRIMARY KEY, project_id TEXT, scene_number INTEGER, duration INTEGER,
    visual_type TEXT, narration TEXT, visual_prompt TEXT, status TEXT, asset_url TEXT,
    asset_type TEXT, audio_url TEXT, retry_count INTEGER, metadata TEXT,
    created_at INTEGER, updated_at INTEGER)`);

  const now = Date.now();
  await exec(`INSERT INTO users (id, email, created_at, updated_at, tier, password_hash) VALUES
    ('${USER_A}', 'a@example.com', ${now}, ${now}, 'STANDARD_USER', '${await legacyHash(LEGACY_PASSWORD)}'),
    ('${USER_B}', 'b@example.com', ${now}, ${now}, 'STANDARD_USER', NULL)`);
  // User B owns one finished video project. User A must never see it.
  await exec(`INSERT INTO video_projects (id, user_id, title, status, final_video_url, metadata, created_at, updated_at)
    VALUES ('${PROJECT_B}', '${USER_B}', 'B private video', 'completed', NULL, '{}', ${now}, ${now})`);

  const app = express();
  app.use(express.json());
  // The real middleware on a probe that reports what it resolved.
  app.get('/probe', mobileAuth, (req: any, res) => res.json({ userId: req.userId }));
  app.post('/api/auth/login', loginUser);
  app.post('/api/auth/register', registerUser);
  app.post('/api/auth/logout', mobileAuth, logoutUser);
  app.post('/api/auth/master-login', masterLogin);
  // The real Studio router: identity + ownership scoping live there.
  app.use('/api/studio', studioRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as any;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test('NEGATIVE: no credential at all is refused', async () => {
  const res = await request('/probe');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'AUTH_REQUIRED');
});

test('NEGATIVE (today\'s exploit): x-user-id alone is refused, not logged in', async () => {
  const res = await request('/probe', { userId: USER_A });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'AUTH_REQUIRED');
});

test('NEGATIVE: a Bearer token that is really a user id is refused', async () => {
  const res = await request('/probe', { token: USER_A, userId: USER_A });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'AUTH_REQUIRED');
});

test('NEGATIVE: a forged token and an expired session are both refused', async () => {
  const forged = await request('/probe', { token: crypto.randomUUID() });
  assert.equal(forged.status, 401);

  // A real row, correct hash, but past its expiry.
  const rawToken = 'expired-token-for-this-test';
  // drizzle's sqlite `timestamp` mode stores SECONDS, so the fixture must too.
  const seconds = Math.floor(Date.now() / 1000);
  await exec(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES ('${crypto.randomUUID()}', '${USER_A}', '${hashSessionToken(rawToken)}', ${seconds - 60}, ${seconds})`);
  const expired = await request('/probe', { token: rawToken });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error, 'AUTH_REQUIRED');
});

test('a valid session token authenticates, and req.userId is that user', async () => {
  const { token } = await createSession(USER_A, 'authRequired.test');
  const res = await request('/probe', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.userId, USER_A);
});

test('login issues a token, and the token authenticates as that user', async () => {
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'a@example.com', password: LEGACY_PASSWORD },
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token, 'login must return a real session token');
  assert.equal(login.body.userId, USER_A);

  const probe = await request('/probe', { token: login.body.token });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.userId, USER_A);
});

test('an old-format password hash logs in ONCE and is upgraded in the row', async () => {
  const rows: any = await (db as any).all(sql.raw(`SELECT password_hash FROM users WHERE id = '${USER_A}'`));
  const stored = rows?.[0]?.password_hash;
  assert.equal(typeof stored, 'string');
  assert.match(stored, /^scrypt\$\d+\$[0-9a-f]+\$[0-9a-f]+$/, 'the row must now hold the scrypt format');
  assert.notEqual(stored.length, 128, 'the legacy 128-hex-char hash must be gone');
});

test('CROSS-TENANT: user A cannot reach user B\'s video project', async () => {
  const { token } = await createSession(USER_A, 'authRequired.test');

  // The stream route answers the SAME 404 as an unknown id — never the bytes.
  const stream = await request(`/api/studio/video/${PROJECT_B}/stream`, { token });
  assert.equal(stream.status, 404);
  assert.equal(JSON.stringify(stream.body).includes('B private video'), false);

  // The list route returns only the caller's own projects.
  const list = await request('/api/studio/video-projects', { token });
  assert.equal(list.status, 200);
  assert.equal(JSON.stringify(list.body).includes(PROJECT_B), false);

  // …and B's own token DOES see it, so the check above is not passing by accident.
  const bToken = (await createSession(USER_B, 'authRequired.test')).token;
  const bList = await request('/api/studio/video-projects', { token: bToken });
  assert.equal(bList.status, 200);
  assert.equal(JSON.stringify(bList.body).includes(PROJECT_B), true);
});

test('CROSS-TENANT: the Studio routes refuse an unauthenticated caller', async () => {
  const noToken = await request(`/api/studio/video/${PROJECT_B}/stream`, { userId: USER_B });
  assert.equal(noToken.status, 401);
  const list = await request('/api/studio/video-projects', { userId: USER_B });
  assert.equal(list.status, 401);
});

test('CROSS-TENANT: ?userId= is not identity — a session cannot borrow another user id', async () => {
  const { token } = await createSession(USER_A, 'authRequired.test');

  // A's real session token, but B's user id in the query. The id is ignored, so
  // B's project is simply not A's and answers the same 404 as an unknown id.
  const borrowed = await request(`/api/studio/video/${PROJECT_B}/stream?userId=${USER_B}`, { token });
  assert.equal(borrowed.status, 404);
  assert.equal(JSON.stringify(borrowed.body).includes('B private video'), false);

  // …and the same query with no session at all is refused outright.
  const noToken = await request(`/api/studio/video/${PROJECT_B}/stream?userId=${USER_B}`);
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.error, 'AUTH_REQUIRED');
});

test('the <video> door: ?token= is the session, a user id in ?token= is not', async () => {
  const { token } = await createSession(USER_B, 'authRequired.test');

  // A browser <video src> cannot send a header, so the token rides in the query.
  // Reaching the project at all (not 401) is the proof the token authenticated.
  const viaQuery = await request(`/api/studio/video/${PROJECT_B}/stream?token=${token}`);
  assert.notEqual(viaQuery.status, 401, 'a real session token in ?token= must authenticate');
  assert.equal(viaQuery.body?.error, 'This video did not finish rendering, so there is no file to play.');

  // B's user id pasted into ?token= is not a session — it is just a typed id.
  const typedId = await request(`/api/studio/video/${PROJECT_B}/stream?token=${USER_B}`);
  assert.equal(typedId.status, 401);
  assert.equal(typedId.body.error, 'AUTH_REQUIRED');
});

test('master login is REFUSED when OWNER_MASTER_KEYS is unset', async () => {
  const saved = process.env.OWNER_MASTER_KEYS;
  delete process.env.OWNER_MASTER_KEYS;
  try {
    const res = await request('/api/auth/master-login', {
      method: 'POST',
      body: { email: 'a@example.com', key: 'ANY-KEY-AT-ALL' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.token, undefined);
  } finally {
    if (saved !== undefined) process.env.OWNER_MASTER_KEYS = saved;
  }
});

test('logout revokes the session it was called with', async () => {
  const { token } = await createSession(USER_A, 'authRequired.test');
  assert.equal((await request('/probe', { token })).status, 200);

  const out = await request('/api/auth/logout', { method: 'POST', token });
  assert.equal(out.status, 200);

  assert.equal((await request('/probe', { token })).status, 401);
});
