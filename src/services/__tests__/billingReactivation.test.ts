/**
 * REACTIVATE — Stripe first, so a client is never asked to pay twice.
 *
 * The defect this suite exists to prevent: `POST /api/subscriptions/reactivate`
 * looked for a live subscription only in OUR database (`subscriptions.stripeSubscriptionId`)
 * and in the last five Checkout Sessions. A Payment Link buyer has no
 * `subscriptions` row, so both lookups came back empty and the endpoint offered a
 * brand-new checkout — asking a client who had just cancelled to pay AGAIN for a
 * period they had already paid for.
 *
 * Nothing here touches live Stripe: the `stripeService` methods are shadowed on
 * the singleton and the billing module's client is injected through
 * `setStripeApi()`, so no charge, cancellation or network call is possible.
 *
 * Covered:
 *   (a) DB row present + a live Stripe subscription → reactivated, NO checkout
 *   (b) NO DB row, live subscription found in Stripe by email → reactivated, NO
 *       checkout  ← the bug
 *   (b2) the snapshot cannot prove it, so the customer-directory door is asked
 *   (b3) the DB's subscription id is dead, Stripe still has a live one → that one
 *   (c) Stripe itself says nothing is live → checkout offered (unchanged shape)
 *   (d) Stripe unreachable → a clear error, NEVER a checkout
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, schema } from '../../db/index.js';
import { reactivateSubscription, subscriptionRows } from '../../controllers/subscriptionController.js';
import { stripeService } from '../stripeService.js';
import { clearBillingCache, setStripeApi, type StripeBillingApi } from '../stripeSubscriptions.js';

const CLIENT = '44444444-4444-4444-8444-444444444444';
const CLIENT_EMAIL = 'client@example.com';
const PERIOD_END = 1_769_904_000;
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();

// ───────────────────────────────── fixtures ─────────────────────────────────

function makeSub(o: {
  id: string;
  email?: string | null;
  customerId?: string;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  ref?: string | null;
}) {
  const customer: any = { id: o.customerId ?? `cus_${o.id}` };
  if (o.email !== null) customer.email = o.email ?? CLIENT_EMAIL;
  return {
    id: o.id,
    status: o.status ?? 'active',
    customer,
    metadata: o.ref ? { client_reference_id: o.ref } : {},
    cancel_at_period_end: o.cancelAtPeriodEnd ?? true,
    created: 1_767_225_600,
    currency: 'usd',
    items: {
      data: [
        {
          current_period_start: 1_767_225_600,
          current_period_end: PERIOD_END,
          price: {
            id: 'price_1TvpWDDrblkzsiVM1103uTqb',
            unit_amount: 5000,
            currency: 'usd',
            recurring: { interval: 'month' },
            product: { id: 'prod_UvguYkSJiAasqC', name: 'EmpireLaunch AI Subscription' },
          },
        },
      ],
    },
  };
}

interface FakeOptions {
  /** What `subscriptions.list` returns when NOT filtered by customer (the snapshot read). */
  subs?: any[];
  subsFail?: boolean;
  /** What `customers.list({ email })` returns. */
  customers?: any[];
  customersFail?: boolean;
  /** Per-customer subscriptions, for the customer-directory door. */
  perCustomerSubs?: Record<string, any[]>;
}

function fakeStripe(options: FakeOptions = {}) {
  const calls = {
    updates: [] as Array<{ id: string; params: any }>,
    customersList: [] as any[],
    subsList: [] as any[],
  };

  const api: StripeBillingApi = {
    subscriptions: {
      list: async (params: any = {}) => {
        calls.subsList.push(params);
        if (options.subsFail) throw new Error('Stripe: network error');
        if (params?.customer) {
          return { data: (options.perCustomerSubs ?? {})[params.customer] ?? [], has_more: false };
        }
        return { data: options.subs ?? [], has_more: false };
      },
      retrieve: async (id: string) => {
        const found = (options.subs ?? []).find((s) => s.id === id);
        if (!found) throw new Error(`No such subscription: ${id}`);
        return found;
      },
      update: async (id: string, params: any) => {
        calls.updates.push({ id, params });
        const found = (options.subs ?? []).find((s) => s.id === id) ?? makeSub({ id });
        return { ...found, cancel_at_period_end: params.cancel_at_period_end === true };
      },
    },
    checkout: { sessions: { list: async () => ({ data: [], has_more: false }) } },
    customers: {
      retrieve: async (id: string) => ({ id }),
      list: async (params: any = {}) => {
        calls.customersList.push(params);
        if (options.customersFail) throw new Error('Stripe: customer search failed');
        return { data: options.customers ?? [], has_more: false };
      },
    },
  };

  setStripeApi(api);
  clearBillingCache();
  return calls;
}

/**
 * Shadow the three `stripeService` methods the reactivate handler calls. The
 * singleton is a plain object, so the production code is untouched and every
 * call is recorded instead of reaching Stripe.
 */
function patchStripeService(o: {
  status?: { status: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; subscriptionId: string | null };
  statusFail?: boolean;
  /** Subscription ids whose reactivate must throw (a dead id, e.g. from a stale DB row). */
  reactivateFailFor?: string[];
  currentPeriodEnd?: string;
} = {}) {
  const calls = { status: 0, reactivate: [] as string[], checkout: 0 };
  const original = {
    getSubscriptionStatus: stripeService.getSubscriptionStatus,
    reactivateSubscription: stripeService.reactivateSubscription,
    createCheckoutSession: stripeService.createCheckoutSession,
  };

  (stripeService as any).getSubscriptionStatus = async () => {
    calls.status += 1;
    if (o.statusFail) throw new Error('Stripe: network error');
    return o.status ?? { status: 'unknown', currentPeriodStart: null, currentPeriodEnd: null, subscriptionId: null };
  };
  (stripeService as any).reactivateSubscription = async (id: string) => {
    calls.reactivate.push(id);
    if ((o.reactivateFailFor ?? []).includes(id)) throw new Error('No such subscription');
    return { reactivated: true, currentPeriodEnd: o.currentPeriodEnd ?? PERIOD_END_ISO };
  };
  (stripeService as any).createCheckoutSession = async () => {
    calls.checkout += 1;
    return 'https://checkout.stripe.test/session';
  };

  return {
    calls,
    restore: () => {
      (stripeService as any).getSubscriptionStatus = original.getSubscriptionStatus;
      (stripeService as any).reactivateSubscription = original.reactivateSubscription;
      (stripeService as any).createCheckoutSession = original.createCheckoutSession;
    },
  };
}

/**
 * Stub the `users` read the handler performs when the request carries no email
 * (`mobileAuth`'s auto-provisioned session). Nothing leaves the process.
 */
function stubUsers(rows: any[]) {
  const original = (db as any).select;
  (db as any).select = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  };
  return () => {
    (db as any).select = original;
  };
}

/**
 * Stand in for the one local read the handler makes (`subscriptions` row).
 * The row is only a hint — Stripe is asked either way — so a test can present a
 * row, or none, and both are honest states of a real account.
 */
function stubRows(rows: Array<{ stripeSubscriptionId?: string | null; canceledAt?: Date | null }>) {
  const original = subscriptionRows.latest;
  (subscriptionRows as any).latest = async () => rows[0] ?? null;
  return () => {
    (subscriptionRows as any).latest = original;
  };
}

function makeReq(o: { userId?: string; email?: string | null } = {}) {
  const user: any = { id: o.userId ?? CLIENT };
  // `mobileAuth`'s auto-provisioned path sets `{ id, mobileSessionToken }` only —
  // so `email: null` here reproduces a client whose email must be re-read from the DB.
  if (o.email !== null) user.email = o.email ?? CLIENT_EMAIL;
  return { userId: o.userId ?? CLIENT, user, headers: {}, body: {}, query: {} } as any;
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

// ═════════════════════════ (a) the existing correct path ════════════════════

test('(a) DB row present + live Stripe subscription ⇒ reactivated, NO checkout', async () => {
  const stripe = patchStripeService({
    status: { status: 'active', currentPeriodStart: null, currentPeriodEnd: PERIOD_END_ISO, subscriptionId: 'sub_live' },
  });
  const billing = fakeStripe({ subs: [makeSub({ id: 'sub_live', ref: CLIENT })] });
  const restoreDb = stubRows([{ stripeSubscriptionId: 'sub_live' }]);

  try {
    const res = makeRes();
    await reactivateSubscription(makeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'reactivated');
    assert.equal(res.body.renewsAt, PERIOD_END_ISO);
    assert.deepEqual(stripe.calls.reactivate, ['sub_live']);
    assert.equal(stripe.calls.checkout, 0, 'a live subscription must never produce a checkout');
    assert.equal(billing.updates.length, 0, 'the billing module is not involved in this path');
  } finally {
    restoreDb();
    stripe.restore();
  }
});

// ═════════════════ (b) the bug: no DB row, Stripe still billing ═════════════

test('(b) NO DB ROW but a live Stripe subscription found by email ⇒ reactivated, NO checkout', async () => {
  // A Payment Link buyer: nothing in `subscriptions`, and the Checkout Session
  // lookup (`getSubscriptionStatus`) cannot see them either.
  const stripe = patchStripeService();
  const billing = fakeStripe({
    subs: [makeSub({ id: 'sub_paylink', email: 'Client@Example.com', cancelAtPeriodEnd: true })],
  });
  // No email on the request (auto-provisioned session) — it must be read from `users`.
  const restoreUsers = stubUsers([{ id: CLIENT, email: CLIENT_EMAIL }]);
  const restoreDb = stubRows([]);

  try {
    const res = makeRes();
    await reactivateSubscription(makeReq({ email: null }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'reactivated', 'a live paid period must be switched back on');
    assert.equal(res.body.subscriptionId, 'sub_paylink');
    assert.equal(res.body.matchedBy, 'email');
    assert.equal(res.body.renewsAt, PERIOD_END_ISO);
    assert.deepEqual(stripe.calls.reactivate, ['sub_paylink']);
    assert.equal(stripe.calls.checkout, 0, 'THE BUG: this used to be a checkout / "pay again"');
    assert.equal(res.body.checkoutUrl, undefined);
    assert.equal(billing.customersList.length, 0, 'the snapshot door answered; no need for the second');
  } finally {
    restoreUsers();
    restoreDb();
    stripe.restore();
  }
});

test('(b2) the snapshot cannot prove it, so the customer directory is asked — and finds it', async () => {
  const stripe = patchStripeService();
  // The snapshot's customer object carries no email, so door 1 cannot match it.
  const billing = fakeStripe({
    subs: [makeSub({ id: 'sub_noemail', email: null, customerId: 'cus_door2' })],
    customers: [{ id: 'cus_door2', email: CLIENT_EMAIL }],
    perCustomerSubs: { cus_door2: [makeSub({ id: 'sub_noemail', email: CLIENT_EMAIL, customerId: 'cus_door2' })] },
  });
  const restoreDb = stubRows([]);

  try {
    const res = makeRes();
    await reactivateSubscription(makeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'reactivated');
    assert.equal(res.body.subscriptionId, 'sub_noemail');
    assert.equal(billing.customersList.length, 1, 'the customer directory door was asked');
    assert.deepEqual(billing.customersList[0], { email: CLIENT_EMAIL, limit: 10 });
    assert.deepEqual(stripe.calls.reactivate, ['sub_noemail']);
    assert.equal(stripe.calls.checkout, 0);
  } finally {
    restoreDb();
    stripe.restore();
  }
});

test('(b3) a dead subscription id in our DB does not send a live client to a checkout', async () => {
  // The DB row is stale (`sub_dead` no longer exists in Stripe), but Stripe still
  // has a live subscription for this client. The old code offered a checkout here.
  const stripe = patchStripeService({ reactivateFailFor: ['sub_dead'] });
  fakeStripe({ subs: [makeSub({ id: 'sub_still_live', ref: CLIENT })] });
  const restoreDb = stubRows([{ stripeSubscriptionId: 'sub_dead' }]);

  try {
    const res = makeRes();
    await reactivateSubscription(makeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'reactivated');
    assert.equal(res.body.subscriptionId, 'sub_still_live');
    assert.deepEqual(stripe.calls.reactivate, ['sub_dead', 'sub_still_live']);
    assert.equal(stripe.calls.checkout, 0);
  } finally {
    restoreDb();
    stripe.restore();
  }
});

test('(b4) past_due and trialing are still inside a paid period — both are reactivated', async () => {
  for (const status of ['past_due', 'trialing']) {
    const stripe = patchStripeService();
    fakeStripe({ subs: [makeSub({ id: `sub_${status}`, ref: CLIENT, status })] });
    const restoreDb = stubRows([]);
    try {
      const res = makeRes();
      await reactivateSubscription(makeReq(), res);
      assert.equal(res.body.status, 'reactivated', `${status} must not be treated as dead`);
      assert.deepEqual(stripe.calls.reactivate, [`sub_${status}`]);
      assert.equal(stripe.calls.checkout, 0);
    } finally {
      restoreDb();
      stripe.restore();
    }
  }
});

// ═══════════════════ (c) genuinely nothing live ⇒ checkout ══════════════════

test('(c) Stripe confirms nothing is live ⇒ the checkout is offered (shape unchanged)', async () => {
  const stripe = patchStripeService();
  fakeStripe({
    subs: [makeSub({ id: 'sub_ended', ref: CLIENT, status: 'canceled', cancelAtPeriodEnd: false })],
  });
  const restoreDb = stubRows([]);

  try {
    const res = makeRes();
    await reactivateSubscription(makeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'requires_payment');
    assert.equal(res.body.checkoutUrl, 'https://checkout.stripe.test/session');
    assert.equal(stripe.calls.checkout, 1);
    assert.deepEqual(stripe.calls.reactivate, [], 'a cancelled subscription is not reactivated');
  } finally {
    restoreDb();
    stripe.restore();
  }
});

// ═══════════════════ (d) Stripe unreachable ⇒ clear error ═══════════════════

test('(d) Stripe unreachable on the status check ⇒ a clear error, never a checkout', async () => {
  const stripe = patchStripeService({ statusFail: true });
  fakeStripe({ subs: [makeSub({ id: 'sub_x', ref: CLIENT })] });
  const restoreDb = stubRows([]);

  try {
    const res = makeRes();
    await reactivateSubscription(makeReq(), res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'STRIPE_UNAVAILABLE');
    assert.match(res.body.message, /NOT been asked to pay again/i);
    assert.equal(stripe.calls.checkout, 0, 'an outage is not permission to charge again');
    assert.equal(res.body.checkoutUrl, undefined);
  } finally {
    restoreDb();
    stripe.restore();
  }
});

test('(d2) Stripe unreachable on the subscription read ⇒ a clear error, never a checkout', async () => {
  const stripe = patchStripeService();
  fakeStripe({ subsFail: true });
  const restoreDb = stubRows([]);

  try {
    const res = makeRes();
    await reactivateSubscription(makeReq(), res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'STRIPE_UNAVAILABLE');
    assert.equal(stripe.calls.checkout, 0);
    assert.equal(res.body.checkoutUrl, undefined);
  } finally {
    restoreDb();
    stripe.restore();
  }
});

test('(d3) a live subscription that cannot be switched back on is an error — not a second charge', async () => {
  const stripe = patchStripeService({ reactivateFailFor: ['sub_stuck'] });
  fakeStripe({ subs: [makeSub({ id: 'sub_stuck', ref: CLIENT })] });
  const restoreDb = stubRows([]);

  try {
    const res = makeRes();
    await reactivateSubscription(makeReq(), res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'STRIPE_UNAVAILABLE');
    assert.equal(res.body.subscriptionId, 'sub_stuck');
    assert.equal(stripe.calls.checkout, 0, 'they still hold a paid period; never charge again');
  } finally {
    restoreDb();
    stripe.restore();
  }
});
