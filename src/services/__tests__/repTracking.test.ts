/**
 * SALES-REP TRACKING (spec: /home/team/shared/REP-TRACKING-SPEC.md).
 *
 * Every assertion below drives the SHIPPED code — the real controllers, the real
 * middleware and the real routers over a real Express stack — against a real
 * database (an on-disk libsql file created for this run). Nothing is restated:
 * the attribution test goes through `POST /api/auth/register`, the accrual test
 * calls the same function both payment paths call, and the role gates are
 * answered by `requireOwner` and the session middleware themselves.
 *
 * The negative controls are the point: the duplicate-attribution test, the
 * replayed-payment test, the 403s and the demo refusal all FAIL if the rule they
 * protect is removed. No network, no provider call, no paid render.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

// ── A private database for this run, set BEFORE the db module is imported ────
const DB_FILE = path.join(os.tmpdir(), `rep-tracking-${crypto.randomUUID()}.db`);
process.env.DATABASE_URL = `file:${DB_FILE}`;
delete process.env.OWNER_MASTER_KEYS;

const express = (await import('express')).default;
const { sql } = await import('drizzle-orm');
const { db } = await import('../../db/index.js');
const { createSession } = await import('../authSessions.js');
const { registerUser } = await import('../../controllers/authController.js');
const repRoutes = (await import('../../routes/repRoutes.js')).default;
const approvalRoutes = (await import('../../routes/approvalRoutes.js')).default;
const { DEMO_REFUSAL_MESSAGE } = await import('../../middleware/demoRefusal.js');
const {
  accrueCommissionForPayment,
  attributeSignupReferral,
  commissionPeriod,
  createReferralCode,
  normalizeReferralCode,
} = await import('../repTracking.js');

const OWNER = 'a0000000-0000-4000-8000-000000000001';
const REP = 'a0000000-0000-4000-8000-000000000002';
const CLIENT = 'a0000000-0000-4000-8000-000000000003';
const DEMO = 'a0000000-0000-4000-8000-000000000004';
const PROMOTABLE = 'a0000000-0000-4000-8000-000000000005';
const EMAILREP = 'a0000000-0000-4000-8000-000000000006';

let server: http.Server;
let baseUrl = '';
let ownerToken = '';
let repToken = '';
let clientToken = '';
let demoToken = '';
let signupClientId = '';
const JANUARY = new Date('2026-01-14T12:00:00Z');
const FEBRUARY = new Date('2026-02-14T12:00:00Z');

async function exec(statement: string) {
  await (db as any).run(sql.raw(statement));
}

async function count(statement: string): Promise<number> {
  const result: any = await (db as any).run(sql.raw(statement));
  const rows = result?.rows ?? result ?? [];
  const first = Array.isArray(rows) ? rows[0] : rows;
  return Number(first?.n ?? first?.count ?? 0);
}

function request(
  pathName: string,
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

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
  await exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, stripe_account_id TEXT,
    paypal_merchant_id TEXT, terms_accepted_version INTEGER DEFAULT 0, business_slots INTEGER DEFAULT 1,
    is_locked INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, tier TEXT DEFAULT 'STANDARD_USER',
    role TEXT NOT NULL DEFAULT 'client',
    access_key TEXT, password_hash TEXT, is_review_mode INTEGER DEFAULT 0,
    mobile_session_token TEXT, mobile_session_expires_at INTEGER)`);
  await exec(`CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, user_agent TEXT)`);
  await exec(`CREATE TABLE user_settings (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, business_angle TEXT, business_niche TEXT,
    theme TEXT NOT NULL DEFAULT 'light', language TEXT NOT NULL DEFAULT 'en',
    currency TEXT NOT NULL DEFAULT 'USD', ai_mode TEXT NOT NULL DEFAULT 'co-pilot',
    auto_send_retention INTEGER NOT NULL DEFAULT 0, onboarding_complete INTEGER NOT NULL DEFAULT 0,
    linking_complete INTEGER NOT NULL DEFAULT 0, notification_modal_dismissed INTEGER NOT NULL DEFAULT 0,
    platform_permissions TEXT, connected_platforms TEXT, notification_settings TEXT,
    protocol_accepted INTEGER NOT NULL DEFAULT 0, is_paid INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  await exec(`CREATE TABLE referrals (
    id TEXT PRIMARY KEY, client_user_id TEXT NOT NULL, salesperson_name TEXT NOT NULL,
    rep_user_id TEXT, source TEXT NOT NULL DEFAULT 'payment', created_at INTEGER NOT NULL)`);
  await exec(`CREATE TABLE referral_codes (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, rep_user_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`);
  await exec(`CREATE TABLE commission_events (
    id TEXT PRIMARY KEY, rep_user_id TEXT NOT NULL, client_user_id TEXT NOT NULL,
    period TEXT NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 100, source_subscription_id TEXT,
    created_at INTEGER NOT NULL, paid_out_at INTEGER)`);
  await exec(`CREATE UNIQUE INDEX commission_events_rep_client_period_idx
    ON commission_events (rep_user_id, client_user_id, period)`);
  await exec(`CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'subscription',
    stripe_session_id TEXT, amount INTEGER, paid_at INTEGER, stripe_subscription_id TEXT,
    canceled_at INTEGER, customer_name TEXT, created_at INTEGER NOT NULL)`);

  const now = Date.now();
  await exec(`INSERT INTO users (id, email, name, created_at, updated_at, tier, role) VALUES
    ('${OWNER}', 'owner@example.com', 'Staci', ${now}, ${now}, 'OWNER_MASTER', 'client'),
    ('${REP}', 'marcy@example.com', 'Marcy Lane', ${now}, ${now}, 'STANDARD_USER', 'sales_rep'),
    ('${CLIENT}', 'client@example.com', 'Plain Client', ${now}, ${now}, 'STANDARD_USER', 'client'),
    ('${DEMO}', 'demo@example.com', 'Demo Account', ${now}, ${now}, 'STANDARD_USER', 'demo'),
    ('${PROMOTABLE}', 'newrep@example.com', 'New Rep', ${now}, ${now}, 'STANDARD_USER', 'client'),
    ('${EMAILREP}', 'byemail@example.com', 'Ada Email', ${now}, ${now}, 'STANDARD_USER', 'client')`);

  ownerToken = (await createSession(OWNER)).token;
  repToken = (await createSession(REP)).token;
  clientToken = (await createSession(CLIENT)).token;
  demoToken = (await createSession(DEMO)).token;

  // The rep's link, derived from her own name.
  await createReferralCode({ repUserId: REP });

  const app = express();
  app.use(express.json());
  app.post('/api/auth/register', registerUser);
  app.use('/api/rep', repRoutes);
  app.use('/api/approval', approvalRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test('the code is the rep\'s own name, uppercased and URL-safe', async () => {
  // A typed code and a code read off the link must agree.
  assert.equal(normalizeReferralCode(' marcy '), 'MARCY');
  assert.equal(normalizeReferralCode('marc-y!'), 'MARCY');

  const me = await request('/api/rep/me', { token: repToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.code, 'MARCY');
  assert.match(me.body.link, /\/join\/MARCY$/);
});

test('signup attribution: a code on register creates exactly one referral row', async () => {
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'brought-by-marcy@example.com', password: 'correct-horse-battery', referralCode: 'marcy' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'registration still issues a real session');
  signupClientId = res.body.userId;

  const rows: any = await (db as any).run(sql.raw(
    `SELECT * FROM referrals WHERE client_user_id = '${signupClientId}'`,
  ));
  const referral = (rows?.rows ?? rows)[0];
  assert.ok(referral, 'the client is attributed');
  assert.equal(referral.rep_user_id, REP);
  assert.equal(referral.source, 'signup');
  assert.equal(referral.salesperson_name, 'Marcy Lane');
});

test('NEGATIVE: a second attribution for the same client writes nothing', async () => {
  const rowsBefore = await count('SELECT COUNT(*) AS n FROM referrals');
  await attributeSignupReferral({ clientUserId: signupClientId, code: 'MARCY' });
  await attributeSignupReferral({ clientUserId: signupClientId, code: 'marcy' });
  assert.equal(await count('SELECT COUNT(*) AS n FROM referrals'), rowsBefore);
});

test('NEGATIVE: an unknown or inactive code attributes nothing', async () => {
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'nobody-referred-them@example.com', password: 'correct-horse-battery', referralCode: 'NOSUCHREP' },
  });
  assert.equal(res.status, 200, 'a bad code never fails a signup');
  const rows: any = await (db as any).run(sql.raw(
    `SELECT COUNT(*) AS n FROM referrals WHERE client_user_id = '${res.body.userId}'`,
  ));
  assert.equal(Number((rows?.rows ?? rows)[0].n), 0);
});

test('accrual: one row per paid month, and a replayed payment adds nothing', async () => {
  await accrueCommissionForPayment({ clientUserId: signupClientId, paidAt: JANUARY });
  await accrueCommissionForPayment({ clientUserId: signupClientId, paidAt: FEBRUARY });
  assert.equal(await count(
    `SELECT COUNT(*) AS n FROM commission_events WHERE client_user_id = '${signupClientId}'`,
  ), 2, 'two months paid → two commission rows');

  // The same January payment replayed (a Stripe retry, a second verify call).
  await accrueCommissionForPayment({ clientUserId: signupClientId, paidAt: JANUARY });
  assert.equal(await count(
    `SELECT COUNT(*) AS n FROM commission_events WHERE client_user_id = '${signupClientId}'`,
  ), 2, 'the replay inserted nothing new');
  assert.equal(await count(
    `SELECT COUNT(*) AS n FROM commission_events WHERE client_user_id = '${signupClientId}'
       AND period = '${commissionPeriod(JANUARY)}'`,
  ), 1);
  assert.equal(commissionPeriod(JANUARY), '2026-01');
});

test('NEGATIVE: a client with no attribution accrues nothing', async () => {
  const rowsBefore = await count('SELECT COUNT(*) AS n FROM commission_events');
  const accrued = await accrueCommissionForPayment({ clientUserId: CLIENT, paidAt: JANUARY });
  assert.equal(accrued, null);
  assert.equal(await count('SELECT COUNT(*) AS n FROM commission_events'), rowsBefore);
});

test('GET /api/rep/me: the rep sees her own numbers, a client gets 403', async () => {
  const me = await request('/api/rep/me', { token: repToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.signups, 1);
  assert.equal(me.body.payingClients, 1);
  assert.equal(me.body.owedCents, 200, '$1 per client per month, two months');
  assert.equal(me.body.paidCents, 0);

  const asClient = await request('/api/rep/me', { token: clientToken });
  assert.equal(asClient.status, 403);

  const anonymous = await request('/api/rep/me');
  assert.equal(anonymous.status, 401);
});

test('GET /api/rep/summary: owner only', async () => {
  const asRep = await request('/api/rep/summary', { token: repToken });
  assert.equal(asRep.status, 403, 'a rep never sees other reps');
  const asClient = await request('/api/rep/summary', { token: clientToken });
  assert.equal(asClient.status, 403);

  const asOwner = await request('/api/rep/summary', { token: ownerToken });
  assert.equal(asOwner.status, 200);
  const marcy = asOwner.body.reps.find((row: any) => row.repUserId === REP);
  assert.ok(marcy, 'the rep appears in the owner view');
  assert.equal(marcy.owedCents, 200);
  assert.equal(asOwner.body.totals.owedCents, 200);
});

test('mark-paid clears the unpaid balance for that period — and only that one', async () => {
  const paid = await request('/api/rep/mark-paid', {
    method: 'POST',
    token: ownerToken,
    body: { repUserId: REP, period: '2026-01' },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.updated, 1);
  assert.equal(paid.body.amountCents, 100);

  const me = await request('/api/rep/me', { token: repToken });
  assert.equal(me.body.owedCents, 100, 'February is still owed');
  assert.equal(me.body.paidCents, 100);

  // A rep cannot clear her own commission.
  const byRep = await request('/api/rep/mark-paid', {
    method: 'POST',
    token: repToken,
    body: { repUserId: REP, upToPeriod: '2026-12' },
  });
  assert.equal(byRep.status, 403);
  const stillOwed = await request('/api/rep/me', { token: repToken });
  assert.equal(stillOwed.body.owedCents, 100);
});

test('the owner creates a code and sets a role; a bad role is refused', async () => {
  const code = await request('/api/rep/codes', {
    method: 'POST',
    token: ownerToken,
    body: { repUserId: PROMOTABLE },
  });
  assert.equal(code.status, 200);
  assert.match(code.body.link, /\/join\/NEW$/);

  const role = await request('/api/rep/assign-role', {
    method: 'POST',
    token: ownerToken,
    body: { userId: PROMOTABLE, role: 'sales_rep' },
  });
  assert.equal(role.status, 200);
  assert.equal(role.body.role, 'sales_rep');

  const bad = await request('/api/rep/assign-role', {
    method: 'POST',
    token: ownerToken,
    body: { userId: PROMOTABLE, role: 'OWNER_MASTER' },
  });
  assert.equal(bad.status, 400, 'a role is never a way to become the owner');

  const byRep = await request('/api/rep/assign-role', {
    method: 'POST',
    token: repToken,
    body: { userId: PROMOTABLE, role: 'client' },
  });
  assert.equal(byRep.status, 403);
});

test('assign-role by email: the owner promotes an existing sign-up and gets its code', async () => {
  const byEmail = await request('/api/rep/assign-role', {
    method: 'POST',
    token: ownerToken,
    body: { email: '  ByEmail@Example.com ', role: 'sales_rep' },
  });
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.userId, EMAILREP, 'the typed address resolves to the real account');
  assert.equal(byEmail.body.email, 'byemail@example.com');
  assert.equal(byEmail.body.role, 'sales_rep');
  assert.equal(byEmail.body.code, 'ADA', 'a rep with no code is given one, from her own name');
  assert.match(byEmail.body.link, /\/join\/ADA$/);

  // Assigning again hands back the same code — a code is never reissued.
  const again = await request('/api/rep/assign-role', {
    method: 'POST',
    token: ownerToken,
    body: { email: 'byemail@example.com', role: 'sales_rep' },
  });
  assert.equal(again.body.code, 'ADA');
  assert.equal(
    await count(`SELECT COUNT(*) AS n FROM referral_codes WHERE rep_user_id = '${EMAILREP}'`),
    1,
  );

  // The owner's summary shows each rep's email and code.
  const summary = await request('/api/rep/summary', { token: ownerToken });
  const row = summary.body.reps.find((entry: any) => entry.repUserId === EMAILREP);
  assert.ok(row, 'the promoted account appears in the summary');
  assert.equal(row.email, 'byemail@example.com');
  assert.equal(row.code, 'ADA');

  // An address nobody signed up with is a 404, not a silent no-op.
  const unknown = await request('/api/rep/assign-role', {
    method: 'POST',
    token: ownerToken,
    body: { email: 'nobody-signed-up@example.com', role: 'sales_rep' },
  });
  assert.equal(unknown.status, 404);

  // Only the owner can promote, whether she names an id or an address.
  const byRep = await request('/api/rep/assign-role', {
    method: 'POST',
    token: repToken,
    body: { email: 'byemail@example.com', role: 'demo' },
  });
  assert.equal(byRep.status, 403);
});

test('a demo account cannot create a render — refused before any provider', async () => {
  const asDemo = await request('/api/approval/create', {
    method: 'POST',
    token: demoToken,
    body: { type: 'faceless' },
  });
  assert.equal(asDemo.status, 403);
  assert.equal(asDemo.body.code, 'DEMO_ACCOUNT');
  assert.equal(asDemo.body.error, DEMO_REFUSAL_MESSAGE);
  assert.doesNotMatch(DEMO_REFUSAL_MESSAGE, /\$|cost|charge|price|refund|pay/i);

  // The same body from a client is NOT refused by the demo gate: it falls
  // through to the controller's own validation. That is what proves the 403
  // above came from the role, not from a malformed request.
  const asClient = await request('/api/approval/create', {
    method: 'POST',
    token: clientToken,
    body: { type: 'faceless' },
  });
  assert.equal(asClient.status, 400);
});
