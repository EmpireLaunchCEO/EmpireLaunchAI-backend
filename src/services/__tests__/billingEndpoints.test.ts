/**
 * BILLING HTTP SURFACE — what the app actually returns, with NO live Stripe.
 *
 * Two endpoints and one extension:
 *   GET  /api/billing/me      (controllers/billingController.getMyBilling)
 *   POST /api/billing/cancel  (controllers/billingController.cancelMyBilling)
 *   GET  /api/admin/client-stats  (controllers/adminController.getClientStats —
 *        now carries per-brand paying clients + the cancellations count, while
 *        `activeSubscribers` / `totalClients` keep working for the Home Base card)
 *
 * The Stripe client is injected (services/stripeSubscriptions.setStripeApi) and
 * the DB reads are stubbed, so nothing here can charge, cancel or query anything
 * real. The one defect this suite exists to prevent: a client pressing Cancel,
 * getting a swallowed 404, believing they cancelled while Stripe keeps billing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, schema } from '../../db/index.js';
import { getClientStats } from '../../controllers/adminController.js';
import { cancelMyBilling, getMyBilling } from '../../controllers/billingController.js';
import { clearBillingCache, setStripeApi, type StripeBillingApi } from '../stripeSubscriptions.js';
import { OWNER_USER_ID } from '../ownerIdentity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(SRC_ROOT, rel), 'utf8');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';
const CLIENT_C = '33333333-3333-4333-8333-333333333333';
const PRICE_BASE = 'price_1TvpWDDrblkzsiVM1103uTqb';
const PRICE_BRAND2 = 'price_1TwkaIDrblkzsiVMtsEP18TB';
const PERIOD_END = 1_769_904_000;

function makeSub(o: {
  id: string;
  ref?: string | null;
  email?: string;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  priceId?: string;
  productId?: string;
  productName?: string;
}) {
  return {
    id: o.id,
    status: o.status ?? 'active',
    customer: { id: `cus_${o.id}`, email: o.email ?? 'client@example.com' },
    metadata: o.ref ? { client_reference_id: o.ref } : {},
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    created: 1_767_225_600,
    currency: 'usd',
    items: {
      data: [
        {
          current_period_start: 1_767_225_600,
          current_period_end: PERIOD_END,
          price: {
            id: o.priceId ?? PRICE_BASE,
            unit_amount: 5000,
            currency: 'usd',
            recurring: { interval: 'month' },
            product: {
              id: o.productId ?? 'prod_UvguYkSJiAasqC',
              name: o.productName ?? 'EmpireLaunch AI Subscription',
            },
          },
        },
      ],
    },
  };
}

function fakeStripe(o: { subs?: any[]; subsFail?: boolean; updateFail?: Error } = {}) {
  const calls = { updates: [] as Array<{ id: string; params: any }> };
  const api: StripeBillingApi = {
    subscriptions: {
      list: async () => {
        if (o.subsFail) throw new Error('Stripe: network error');
        return { data: o.subs ?? [], has_more: false };
      },
      retrieve: async (id: string) => {
        const found = (o.subs ?? []).find((s) => s.id === id);
        if (!found) throw new Error('No such subscription');
        return found;
      },
      update: async (id: string, params: any) => {
        calls.updates.push({ id, params });
        if (o.updateFail) throw o.updateFail;
        const found = (o.subs ?? []).find((s) => s.id === id) ?? makeSub({ id });
        return { ...found, cancel_at_period_end: params.cancel_at_period_end === true };
      },
    },
    checkout: { sessions: { list: async () => ({ data: [], has_more: false }) } },
  };
  setStripeApi(api);
  clearBillingCache();
  return calls;
}

function makeReq(o: { userId?: string; email?: string } = {}) {
  return {
    userId: o.userId ?? CLIENT,
    user: { id: o.userId ?? CLIENT, email: o.email ?? 'client@example.com' },
    headers: {},
    body: {},
    query: {},
  } as any;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

/**
 * Stub the two Drizzle reads the admin controller performs. `db.select()` is a
 * plain method on the drizzle instance, so replacing it here keeps the controller
 * code under test untouched and guarantees no query leaves the process.
 *
 * The returned chain is both thenable (resolves the CLIENT rows — the query the
 * controller awaits directly) and has `.where()` (resolves the SUBSCRIPTION rows).
 * On the LibSQL schema this sandbox runs on, `subscriptions` does not exist, so
 * that query throws before `db.select` is even called — see HAS_SUBSCRIPTIONS.
 */
const HAS_SUBSCRIPTIONS = Boolean(schema.subscriptions);

function stubDb(config: { subRows?: any[]; clientRows?: any[]; fail?: boolean }) {
  const original = (db as any).select;
  (db as any).select = () => ({
    from: () => {
      if (config.fail) throw new Error('db unreachable');
      return {
        innerJoin: () => ({
          where: () => Promise.resolve(config.subRows ?? []),
          then: (resolve: any, reject: any) => Promise.resolve(config.clientRows ?? []).then(resolve, reject),
        }),
      };
    },
  });
  return () => {
    (db as any).select = original;
  };
}

// ═════════════════════════ (1) GET /api/billing/me ═════════════════════════

test('(1a) /billing/me returns the real plan, period end and brand slot', async () => {
  fakeStripe({
    subs: [
      makeSub({
        id: 'sub_me',
        ref: CLIENT,
        priceId: PRICE_BRAND2,
        productId: 'prod_UwdsLaUyzg2WgS',
        productName: 'Empire Brand 2 Expansion Subscription',
      }),
    ],
  });

  const res = makeRes();
  await getMyBilling(makeReq({ userId: CLIENT }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked, true);
  assert.equal(res.body.plan.brandSlot, 'brand2');
  assert.equal(res.body.currentPeriodEnd, new Date(PERIOD_END * 1000).toISOString());
  assert.equal(res.body.activeUntil, res.body.currentPeriodEnd);
  assert.equal(res.body.cancelAtPeriodEnd, false);
});

test('(1b) /billing/me with no Stripe subscription is explicitly unlinked (no invented plan/date)', async () => {
  fakeStripe({ subs: [] });
  const res = makeRes();
  await getMyBilling(makeReq({ userId: CLIENT, email: 'nobody@example.com' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked, false);
  assert.equal(res.body.reason, 'no_subscription');
  assert.equal(res.body.currentPeriodEnd, undefined);
  assert.equal(res.body.plan, undefined);
});

test('(1c) /billing/me with Stripe down says unavailable, and never reports a plan', async () => {
  fakeStripe({ subsFail: true });
  const res = makeRes();
  await getMyBilling(makeReq({ userId: CLIENT }), res);
  assert.equal(res.body.linked, false);
  assert.equal(res.body.reason, 'stripe_unavailable');
  assert.equal(res.body.currentPeriodEnd, undefined);
});

test('(1d) /billing/me without an authenticated user is a 401, not a plan', async () => {
  fakeStripe({ subs: [] });
  const res = makeRes();
  await getMyBilling({ userId: undefined, user: undefined, headers: {}, body: {}, query: {} } as any, res);
  assert.equal(res.statusCode, 401);
});

// ══════════════════════════ (2) POST /api/billing/cancel ════════════════════

test('(2a) cancel returns 200 with the paid-through date and only sets cancel_at_period_end', async () => {
  const calls = fakeStripe({ subs: [makeSub({ id: 'sub_c', ref: CLIENT })] });
  const res = makeRes();
  await cancelMyBilling(makeReq({ userId: CLIENT }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'canceled');
  assert.equal(res.body.cancelled, true);
  assert.equal(res.body.cancelAtPeriodEnd, true);
  assert.equal(res.body.activeUntil, new Date(PERIOD_END * 1000).toISOString());
  assert.deepEqual(calls.updates, [{ id: 'sub_c', params: { cancel_at_period_end: true } }]);
});

test('(2b) cancelling twice is fine: same body, one write', async () => {
  const calls = fakeStripe({ subs: [makeSub({ id: 'sub_twice', ref: CLIENT })] });
  const first = makeRes();
  await cancelMyBilling(makeReq({ userId: CLIENT }), first);

  // Stripe now reports the flag set.
  const calls2 = fakeStripe({ subs: [makeSub({ id: 'sub_twice', ref: CLIENT, cancelAtPeriodEnd: true })] });
  const second = makeRes();
  await cancelMyBilling(makeReq({ userId: CLIENT }), second);

  assert.equal(second.statusCode, 200);
  assert.equal(second.body.activeUntil, first.body.activeUntil);
  assert.equal(second.body.alreadyCancelled, true);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls2.updates.length, 0);
});

test('(2c) nothing to cancel ⇒ 409 with a showable message — NOT the silent 404 that hid the defect', async () => {
  const calls = fakeStripe({ subs: [] });
  const res = makeRes();
  await cancelMyBilling(makeReq({ userId: CLIENT, email: 'nobody@example.com' }), res);

  assert.notEqual(res.statusCode, 404, 'a 404 is what the frontend used to swallow');
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.cancelled, false);
  assert.equal(res.body.code, 'NO_SUBSCRIPTION');
  assert.match(res.body.message, /could not find a Stripe subscription/i);
  assert.ok(res.body.error, 'the frontend has an `error` field to display');
  assert.equal(calls.updates.length, 0);
});

test('(2d) Stripe rejecting the cancel ⇒ 503 "not cancelled", never a success body', async () => {
  fakeStripe({ subs: [makeSub({ id: 'sub_x', ref: CLIENT })], updateFail: new Error('Subscription not cancelable') });
  const res = makeRes();
  await cancelMyBilling(makeReq({ userId: CLIENT }), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.cancelled, false);
  assert.equal(res.body.code, 'STRIPE_UNAVAILABLE');
  assert.match(res.body.message, /NOT cancelled/);
});

test('(2e) Stripe unreachable ⇒ 503, and the client is told the subscription still stands', async () => {
  fakeStripe({ subsFail: true });
  const res = makeRes();
  await cancelMyBilling(makeReq({ userId: CLIENT }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.cancelled, false);
  assert.match(res.body.message, /NOT cancelled/);
});

// ═════════════════ (3) GET /api/admin/client-stats extension ════════════════

test('(3a) zero subscriptions: a genuine 0, with the old shape intact', async () => {
  fakeStripe({ subs: [] });
  const restore = stubDb({
    subRows: [],
    clientRows: [{ userId: CLIENT, id: CLIENT, email: 'a@b.com', tier: 'STANDARD_USER' }],
  });
  try {
    const res = makeRes();
    await getClientStats(makeReq({ userId: OWNER_USER_ID }), res);

    assert.equal(res.statusCode, 200);
    // unchanged keys the Home Base card already reads
    assert.equal(res.body.activeSubscribers, 0);
    assert.equal(res.body.totalClients, 1);
    // new keys
    assert.equal(res.body.activeSubscribersSource, 'stripe');
    assert.deepEqual(res.body.payingClients, { total: 0, subscription: 0, brand2: 0, brand3: 0 });
    assert.equal(res.body.cancellingClients, 0);
    assert.ok(res.body.billingReadAt);
    assert.equal(res.body.billingError, null);
  } finally {
    restore();
  }
});

test('(3b) some subscriptions: per-brand paying clients + the cancellations count', async () => {
  fakeStripe({
    subs: [
      makeSub({ id: 'sub_a1', ref: CLIENT }),
      makeSub({ id: 'sub_a2', ref: CLIENT, priceId: PRICE_BRAND2, productId: 'prod_UwdsLaUyzg2WgS', productName: 'Empire Brand 2 Expansion Subscription' }),
      makeSub({ id: 'sub_b1', ref: CLIENT_B }),
      makeSub({ id: 'sub_c1', ref: CLIENT_C, cancelAtPeriodEnd: true }),
    ],
  });
  const restore = stubDb({
    subRows: [{ userId: CLIENT, id: CLIENT, email: 'a@b.com', tier: 'STANDARD_USER' }],
    clientRows: [
      { userId: CLIENT, id: CLIENT, email: 'a@b.com', tier: 'STANDARD_USER' },
      { userId: CLIENT_B, id: CLIENT_B, email: 'b@b.com', tier: 'STANDARD_USER' },
      // the owner also owns an empire — she must never be counted as a client
      { userId: OWNER_USER_ID, id: OWNER_USER_ID, email: 'stacipeabody@gmail.com', tier: 'OWNER_MASTER' },
    ],
  });
  try {
    const res = makeRes();
    await getClientStats(makeReq({ userId: OWNER_USER_ID }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalClients, 2, 'owner excluded from client count');
    assert.deepEqual(res.body.payingClients, { total: 3, subscription: 3, brand2: 1, brand3: 0 });
    assert.equal(res.body.cancellingClients, 1);
    assert.equal(res.body.activeSubscribers, 3);
  } finally {
    restore();
  }
});

test('(3c) Stripe down: the DB numbers still answer, billing fields are null — never a fake 0', async () => {
  fakeStripe({ subsFail: true });
  const restore = stubDb({
    subRows: [{ userId: CLIENT, id: CLIENT, email: 'a@b.com', tier: 'STANDARD_USER' }],
    clientRows: [{ userId: CLIENT, id: CLIENT, email: 'a@b.com', tier: 'STANDARD_USER' }],
  });
  try {
    const res = makeRes();
    await getClientStats(makeReq({ userId: OWNER_USER_ID }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(
      res.body.activeSubscribers,
      HAS_SUBSCRIPTIONS ? 1 : null,
      'falls back to the DB count (null where the schema has no subscriptions table — renders "—")',
    );
    assert.notEqual(res.body.activeSubscribers, 0, 'a Stripe outage must never read as "0 subscribers"');
    assert.equal(res.body.activeSubscribersSource, 'db');
    assert.equal(res.body.payingClients, null, 'null renders as "—", not "0 paying clients"');
    assert.equal(res.body.cancellingClients, null);
    assert.ok(res.body.billingError);
    assert.equal(res.body.totalClients, 1);
  } finally {
    restore();
  }
});

test('(3d) both sources down ⇒ 500, not zeros', async () => {
  fakeStripe({ subsFail: true });
  const restore = stubDb({ fail: true });
  try {
    const res = makeRes();
    await getClientStats(makeReq({ userId: OWNER_USER_ID }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.payingClients, undefined);
  } finally {
    restore();
  }
});

// ═════════════════════════════ (4) route wiring ═════════════════════════════

test('(4a) billing routes are mounted at /api/billing behind mobileAuth', () => {
  const router = read('routes/billingRoutes.ts');
  assert.match(router, /router\.get\('\/me',\s*mobileAuth,\s*getMyBilling\)/);
  assert.match(router, /router\.post\('\/cancel',\s*mobileAuth,\s*cancelMyBilling\)/);

  const index = read('index.ts');
  assert.match(index, /app\.use\('\/api\/billing',\s*billingRoutes\)/);
  // mounted before the catch-all '/api' router so it is not shadowed
  assert.ok(index.indexOf("'/api/billing'") < index.indexOf("app.use('/api', subscriptionRoutes)"));
});

test('(4b) the Settings card path POST /api/subscriptions/cancel still works — and no longer 404s', () => {
  const router = read('routes/subscriptionRoutes.ts');
  assert.match(router, /router\.post\('\/subscriptions\/cancel',\s*mobileAuth,\s*cancelSubscription\)/);

  const controller = read('controllers/subscriptionController.ts');
  assert.match(controller, /export const cancelSubscription = cancelMyBilling;/);
  // The old defect: a 404 the frontend swallowed while Stripe kept billing.
  assert.equal(/Could not find Stripe subscription ID/.test(controller), false);
  assert.equal(/No subscription found/.test(controller), false);
});
