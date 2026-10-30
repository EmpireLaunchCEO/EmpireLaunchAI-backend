/**
 * STRIPE SUBSCRIPTIONS — the money truth layer, with NO live Stripe.
 *
 * Every test injects a fake Stripe client through `setStripeApi()`. Nothing in
 * this file can reach the network: the real client is only built inside
 * `getStripeApi()`, and the seam is always set before a call.
 *
 * Covered:
 *   (a) brand-slot mapping — known price ids (verified live 2026-10-30), env
 *       overrides, product id, product NAME fallback, explicit default;
 *   (b) client resolution — `client_reference_id` on the subscription metadata,
 *       `client_reference_id` on the originating Checkout Session (what a Payment
 *       Link actually carries), and the email fallback with Gmail dot/alias and
 *       case normalisation;
 *   (c) owner aggregates — 0 / some / cancelled-but-still-active / owner excluded;
 *   (d) cancel — `cancel_at_period_end` only, idempotent, no access revocation,
 *       visible error when there is nothing to cancel or Stripe rejects;
 *   (e) the client-facing view — real period end when linked, an honest
 *       `linked: false` (never an invented plan or date) when not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRAND_LABELS,
  CANCEL_NO_SUBSCRIPTION_MESSAGE,
  aggregateOwnerStats,
  cancelClientSubscription,
  clearBillingCache,
  getClientBillingView,
  getOwnerBillingStats,
  matchClientSubscriptions,
  normalizeBillingEmail,
  readBillingSnapshot,
  resolveBrandSlot,
  setStripeApi,
  type BillingSnapshot,
  type StripeBillingApi,
} from '../stripeSubscriptions.js';
import { OWNER_USER_ID } from '../ownerIdentity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(SRC_ROOT, rel), 'utf8');

// Live-verified Stripe identities (read-only API, 2026-10-30).
const PRICE_BASE = 'price_1TvpWDDrblkzsiVM1103uTqb';
const PRICE_BRAND2 = 'price_1TwkaIDrblkzsiVMtsEP18TB';
const PRICE_BRAND3 = 'price_1TyeuqDrblkzsiVMhiCktLiP';
const PROD_BASE = 'prod_UvguYkSJiAasqC';
const PROD_BRAND2 = 'prod_UwdsLaUyzg2WgS';
const PROD_BRAND3 = 'prod_Uyc9Vws147m6sK';

const PERIOD_START = 1_767_225_600; // 2026-01-01T00:00:00Z
const PERIOD_END = 1_769_904_000;   // 2026-01-31T00:00:00Z

interface SubOverrides {
  id?: string;
  status?: string;
  customer?: any;
  metadata?: Record<string, string>;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  created?: number;
  priceId?: string;
  productId?: string;
  productName?: string;
  periodEnd?: number | null;
  amount?: number;
}

/** A Stripe subscription as the API returns it (period on the ITEM, per current API). */
function makeSub(o: SubOverrides = {}) {
  return {
    id: o.id ?? 'sub_default',
    status: o.status ?? 'active',
    customer: o.customer ?? { id: 'cus_default', email: 'client@example.com' },
    metadata: o.metadata ?? {},
    cancel_at_period_end: o.cancel_at_period_end ?? false,
    cancel_at: o.cancel_at ?? null,
    created: o.created ?? 1_767_225_600,
    currency: 'usd',
    items: {
      data: [
        {
          current_period_start: PERIOD_START,
          current_period_end: o.periodEnd === null ? undefined : (o.periodEnd ?? PERIOD_END),
          price: {
            id: o.priceId ?? PRICE_BASE,
            unit_amount: o.amount ?? 5000,
            currency: 'usd',
            recurring: { interval: 'month' },
            product: {
              id: o.productId ?? PROD_BASE,
              name: o.productName ?? 'EmpireLaunch AI Subscription',
            },
          },
        },
      ],
    },
  };
}

interface FakeOptions {
  subs?: any[];
  sessions?: any[];
  subsFail?: boolean;
  sessionsFail?: boolean;
  updateFail?: Error;
  hasMore?: boolean;
}

function fakeStripe(options: FakeOptions = {}) {
  const calls = {
    subsList: 0,
    sessionsList: 0,
    updates: [] as Array<{ id: string; params: any }>,
    retrieves: 0,
  };

  const api: StripeBillingApi = {
    subscriptions: {
      list: async () => {
        calls.subsList += 1;
        if (options.subsFail) throw new Error('Stripe: invalid API key provided');
        return { data: options.subs ?? [], has_more: options.hasMore ?? false };
      },
      retrieve: async (id: string) => {
        calls.retrieves += 1;
        const found = (options.subs ?? []).find((s) => s.id === id);
        if (!found) throw new Error(`No such subscription: ${id}`);
        return found;
      },
      update: async (id: string, params: any) => {
        calls.updates.push({ id, params });
        if (options.updateFail) throw options.updateFail;
        const found = (options.subs ?? []).find((s) => s.id === id) ?? makeSub({ id });
        return { ...found, cancel_at_period_end: params.cancel_at_period_end === true };
      },
    },
    checkout: {
      sessions: {
        list: async () => {
          calls.sessionsList += 1;
          if (options.sessionsFail) throw new Error('checkout sessions: permission denied');
          return { data: options.sessions ?? [], has_more: false };
        },
      },
    },
  };

  return { api, calls };
}

function useFake(options: FakeOptions = {}) {
  const fake = fakeStripe(options);
  setStripeApi(fake.api);
  return fake;
}

/** Run `fn` with a temporary env var, always restoring it. */
async function withEnv(key: string, value: string | undefined, fn: () => Promise<void> | void) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

// ═══════════════════════════ (a) brand-slot mapping ═════════════════════════

test('(a1) every live-verified price id resolves to its own brand slot', () => {
  const cases: Array<[string, string]> = [
    [PRICE_BASE, 'subscription'],
    ['price_1TvoejDrblkzsiVME1uomjbi', 'subscription'], // earlier duplicate of the base $50/mo
    ['price_1TYzFsDrblkzsiVMxWuyJAlO', 'subscription'], // and the one before that
    [PRICE_BRAND2, 'brand2'],
    [PRICE_BRAND3, 'brand3'],
  ];
  for (const [priceId, slot] of cases) {
    const r = resolveBrandSlot({ priceId });
    assert.equal(r.slot, slot, `${priceId} must map to ${slot}`);
    assert.equal(r.source, 'known_price');
  }
});

test('(a2) product id resolves the slot when the price is unknown (prices get replaced, products do not)', () => {
  assert.equal(resolveBrandSlot({ priceId: 'price_unknown', productId: PROD_BRAND2 }).slot, 'brand2');
  assert.equal(resolveBrandSlot({ priceId: 'price_unknown', productId: PROD_BRAND3 }).slot, 'brand3');
  assert.equal(resolveBrandSlot({ productId: PROD_BASE }).slot, 'subscription');
  assert.equal(resolveBrandSlot({ productId: PROD_BRAND2 }).source, 'known_product');
});

test('(a3) an env override beats a known id, so the owner can re-point without a deploy', async () => {
  await withEnv('STRIPE_PRICE_BRAND2', 'price_newly_created', async () => {
    const r = resolveBrandSlot({ priceId: 'price_newly_created' });
    assert.equal(r.slot, 'brand2');
    assert.equal(r.source, 'env_price');
  });
});

test('(a4) product NAME is the last heuristic: brand NUMBER decides, never the word "expansion"', () => {
  const b3 = resolveBrandSlot({ productName: 'Empire Brand 3 Expansion Subscription' });
  assert.equal(b3.slot, 'brand3');
  assert.equal(b3.source, 'product_name');

  const b2 = resolveBrandSlot({ productName: 'Empire Brand 2 Expansion Subscription' });
  assert.equal(b2.slot, 'brand2');

  // "Empire Brand Expansion" (one-time, no number) must NOT be filed as brand 2.
  const ambiguous = resolveBrandSlot({ productName: 'Empire Brand Expansion' });
  assert.equal(ambiguous.slot, 'subscription');
  assert.equal(ambiguous.source, 'default');
});

test('(a5) nothing matches ⇒ base slot with source "default" (visible, not silent)', () => {
  const r = resolveBrandSlot({ priceId: 'price_mystery', productName: 'Something Else' });
  assert.equal(r.slot, 'subscription');
  assert.equal(r.source, 'default');
  assert.equal(r.matchedOn, 'price_mystery');
  assert.equal(BRAND_LABELS.brand3, 'Brand 3');
});

// ═════════════════════════ (b) client resolution ════════════════════════════

const CLIENT = '11111111-1111-4111-8111-111111111111';

test('(b1) client_reference_id on the subscription metadata resolves the client', async () => {
  useFake({
    subs: [makeSub({ id: 'sub_meta', metadata: { client_reference_id: CLIENT } })],
    sessions: [],
  });
  const snapshot = await readBillingSnapshot({ fresh: true });
  const matches = matchClientSubscriptions(snapshot, { userId: CLIENT, email: null });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].subscription.id, 'sub_meta');
  assert.equal(matches[0].matchedBy, 'client_reference_id');
});

test('(b2) client_reference_id on the Checkout Session resolves the client (what a Payment Link carries)', async () => {
  useFake({
    subs: [makeSub({ id: 'sub_via_session', metadata: {} })],
    sessions: [
      { id: 'cs_1', client_reference_id: CLIENT, subscription: 'sub_via_session' },
      { id: 'cs_0', client_reference_id: 'someone-else', subscription: 'sub_other' },
    ],
  });
  const snapshot = await readBillingSnapshot({ fresh: true });
  const matches = matchClientSubscriptions(snapshot, { userId: CLIENT, email: null });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].subscription.id, 'sub_via_session');
  assert.equal(matches[0].matchedBy, 'client_reference_id');
});

test('(b3) email fallback: case, Gmail dots and googlemail all match one mailbox', async () => {
  useFake({
    subs: [
      makeSub({
        id: 'sub_email',
        metadata: {},
        customer: { id: 'cus_x', email: 'Staci.Peabody@GoogleMail.com' },
      }),
    ],
  });
  const snapshot = await readBillingSnapshot({ fresh: true });

  for (const email of [
    'stacipeabody@gmail.com',
    'Staci.Peabody@gmail.com',
    'STACI.PEABODY@GOOGLEMAIL.COM',
  ]) {
    const matches = matchClientSubscriptions(snapshot, { userId: 'no-ref-here', email });
    assert.equal(matches.length, 1, `${email} must match`);
    assert.equal(matches[0].matchedBy, 'email');
  }
});

test('(b4) email fallback is case-insensitive for non-Gmail too, and never matches a different mailbox', async () => {
  useFake({
    subs: [makeSub({ id: 'sub_biz', metadata: {}, customer: { id: 'cus_b', email: 'Owner@BrandBiz.com' } })],
  });
  const snapshot = await readBillingSnapshot({ fresh: true });
  assert.equal(matchClientSubscriptions(snapshot, { userId: 'u', email: 'owner@brandbiz.com' }).length, 1);
  assert.equal(matchClientSubscriptions(snapshot, { userId: 'u', email: 'someone@else.com' }).length, 0);
  assert.equal(normalizeBillingEmail('A.B@Gmail.com'), normalizeBillingEmail('ab@googlemail.com'));
});

test('(b5) an unattributable subscription is NOT handed to a stranger', async () => {
  useFake({
    subs: [makeSub({ id: 'sub_orphan', metadata: {}, customer: { id: 'cus_o', email: 'nobody@example.com' } })],
  });
  const snapshot = await readBillingSnapshot({ fresh: true });
  assert.equal(matchClientSubscriptions(snapshot, { userId: CLIENT, email: 'other@example.com' }).length, 0);
});

test('(b6) the snapshot is read ONCE and reused (a page that asks twice hits Stripe once)', async () => {
  const fake = useFake({ subs: [makeSub({ metadata: { client_reference_id: CLIENT } })] });
  await withEnv('STRIPE_BILLING_CACHE_MS', '60000', async () => {
    clearBillingCache();
    await readBillingSnapshot();
    await readBillingSnapshot();
    assert.equal(fake.calls.subsList, 1);
    await readBillingSnapshot({ fresh: true });
    assert.equal(fake.calls.subsList, 2);
  });
});

// ══════════════════════════ (c) owner aggregates ════════════════════════════

test('(c1) zero subscriptions ⇒ a genuine zero, never a guess', async () => {
  useFake({ subs: [] });
  const stats = await getOwnerBillingStats({ fresh: true });
  assert.equal(stats.payingClients, 0);
  assert.deepEqual(stats.payingClientsByBrand, { subscription: 0, brand2: 0, brand3: 0 });
  assert.equal(stats.cancellingClients, 0);
  assert.equal(stats.totalSubscriptions, 0);
  assert.ok(stats.readAt, 'readAt proves the read happened');
});

test('(c2) counts per brand, distinct clients, and a client holding two brands counts twice by brand', () => {
  const snapshot: BillingSnapshot = {
    readAt: new Date().toISOString(),
    sessionsReadable: true,
    pricesReadable: true,
    truncated: false,
    subscriptions: [
      // client A: base + brand 2
      {
        ...normalizedFixture({ id: 'sub_a1', ref: 'client-a', slot: 'subscription' }),
      },
      { ...normalizedFixture({ id: 'sub_a2', ref: 'client-a', slot: 'brand2' }) },
      // client B: base only
      { ...normalizedFixture({ id: 'sub_b1', ref: 'client-b', slot: 'subscription' }) },
      // client C: brand 3 only
      { ...normalizedFixture({ id: 'sub_c1', ref: 'client-c', slot: 'brand3' }) },
    ],
  };

  const stats = aggregateOwnerStats(snapshot);
  assert.equal(stats.payingClients, 3);
  assert.deepEqual(stats.payingClientsByBrand, { subscription: 2, brand2: 1, brand3: 1 });
  assert.equal(stats.subscriptionsByBrand.subscription, 2);
  assert.equal(stats.totalSubscriptions, 4);
});

test('(c3) cancelled-but-still-active is counted as paying AND as a cancellation; an ended sub is neither', () => {
  const snapshot: BillingSnapshot = {
    readAt: new Date().toISOString(),
    sessionsReadable: true,
    pricesReadable: true,
    truncated: false,
    subscriptions: [
      normalizedFixture({ id: 'sub_live', ref: 'client-live', slot: 'subscription' }),
      normalizedFixture({ id: 'sub_going', ref: 'client-going', slot: 'brand2', cancelling: true }),
      normalizedFixture({ id: 'sub_ended', ref: 'client-gone', slot: 'subscription', status: 'canceled' }),
    ],
  };

  const stats = aggregateOwnerStats(snapshot);
  assert.equal(stats.payingClients, 2, 'the cancelled-and-ended client is not paying');
  assert.equal(stats.cancellingClients, 1);
  assert.equal(stats.payingClientsByBrand.subscription, 1);
  assert.equal(stats.payingClientsByBrand.brand2, 1);
});

test('(c4) past_due still counts as paying (they are inside a paid period and being retried)', () => {
  const snapshot: BillingSnapshot = {
    readAt: new Date().toISOString(),
    sessionsReadable: true,
    pricesReadable: true,
    truncated: false,
    subscriptions: [normalizedFixture({ id: 'sub_pd', ref: 'client-pd', slot: 'subscription', status: 'past_due' })],
  };
  assert.equal(aggregateOwnerStats(snapshot).payingClients, 1);
});

test('(c5) the owner is never a client of her own product — by id or by email', () => {
  const snapshot: BillingSnapshot = {
    readAt: new Date().toISOString(),
    sessionsReadable: true,
    pricesReadable: true,
    truncated: false,
    subscriptions: [
      normalizedFixture({ id: 'sub_owner_id', ref: OWNER_USER_ID, slot: 'subscription' }),
      normalizedFixture({
        id: 'sub_owner_mail',
        ref: null,
        slot: 'subscription',
        email: 'staci.peabody@gmail.com',
      }),
      normalizedFixture({ id: 'sub_real', ref: 'client-real', slot: 'brand3' }),
    ],
  };
  const stats = aggregateOwnerStats(snapshot);
  assert.equal(stats.payingClients, 1);
  assert.equal(stats.payingClientsByBrand.brand3, 1);
  assert.equal(stats.payingClientsByBrand.subscription, 0);
});

test('(c6) a Stripe failure is an error, never "0 paying clients"', async () => {
  useFake({ subsFail: true });
  await assert.rejects(() => getOwnerBillingStats({ fresh: true }), /invalid API key|subscriptions list/i);
});

test('(c7) checkout sessions being unreadable does not blind the numbers', async () => {
  useFake({
    subs: [makeSub({ id: 'sub_meta_only', metadata: { client_reference_id: CLIENT } })],
    sessionsFail: true,
  });
  const stats = await getOwnerBillingStats({ fresh: true });
  assert.equal(stats.payingClients, 1);
  assert.equal(stats.sessionsReadable, false);
});

/** Build a NormalizedSubscription for the pure-aggregate tests. */
function normalizedFixture(o: {
  id: string;
  ref: string | null;
  slot: 'subscription' | 'brand2' | 'brand3';
  status?: string;
  cancelling?: boolean;
  email?: string;
}) {
  const status = o.status ?? 'active';
  const live = status === 'active' || status === 'trialing' || status === 'past_due';
  return {
    id: o.id,
    status,
    live,
    customerId: `cus_${o.id}`,
    customerEmail: o.email ?? null,
    clientReferenceId: o.ref,
    linkedBy: o.ref ? ('metadata' as const) : null,
    brandSlot: o.slot,
    brandLabel: BRAND_LABELS[o.slot],
    brandSource: 'known_price' as const,
    brandMatchedOn: null,
    priceId: PRICE_BASE,
    productId: PROD_BASE,
    productName: 'EmpireLaunch AI Subscription',
    amount: 5000,
    currency: 'usd',
    interval: 'month',
    currentPeriodStart: new Date(PERIOD_START * 1000).toISOString(),
    currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(),
    cancelAtPeriodEnd: !!o.cancelling,
    cancelling: !!o.cancelling && live,
    created: new Date(1_767_225_600 * 1000).toISOString(),
  };
}

// ══════════════════════════════ (d) the cancel ══════════════════════════════

test('(d1) cancel sets ONLY cancel_at_period_end and reports the real period end', async () => {
  const fake = useFake({
    subs: [makeSub({ id: 'sub_cancel_me', metadata: { client_reference_id: CLIENT } })],
  });

  const result = await cancelClientSubscription({ userId: CLIENT, email: null });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.cancelAtPeriodEnd, true);
  assert.equal(result.alreadyCancelled, false);
  assert.equal(result.activeUntil, new Date(PERIOD_END * 1000).toISOString());
  assert.equal(fake.calls.updates.length, 1);
  assert.equal(fake.calls.updates[0].id, 'sub_cancel_me');
  // The ONLY thing sent to Stripe is the flag — no deletion, no invoice, no refund.
  assert.deepEqual(fake.calls.updates[0].params, { cancel_at_period_end: true });
});

test('(d2) cancelling twice is fine and says exactly the same thing (no second write)', async () => {
  const fake = useFake({
    subs: [makeSub({ id: 'sub_twice', metadata: { client_reference_id: CLIENT } })],
  });

  const first = await cancelClientSubscription({ userId: CLIENT, email: null });
  assert.equal(first.ok, true);

  // Stripe now reports the flag; the cache was invalidated by the write, so the
  // second call sees it and must not write again.
  (fake.api.subscriptions.list as any) = async () => ({
    data: [makeSub({ id: 'sub_twice', metadata: { client_reference_id: CLIENT }, cancel_at_period_end: true })],
    has_more: false,
  });
  clearBillingCache();

  const second = await cancelClientSubscription({ userId: CLIENT, email: null });
  assert.equal(second.ok, true);
  if (!second.ok || !first.ok) return;
  assert.equal(second.alreadyCancelled, true);
  assert.equal(second.activeUntil, first.activeUntil, 'same period end both times');
  assert.equal(fake.calls.updates.length, 1, 'only the first call wrote to Stripe');
});

test('(d3) no subscription ⇒ an explicit, showable failure (not a silent 404, not a fake success)', async () => {
  const fake = useFake({ subs: [] });
  const result = await cancelClientSubscription({ userId: CLIENT, email: 'nobody@example.com' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'NO_SUBSCRIPTION');
  assert.equal(result.message, CANCEL_NO_SUBSCRIPTION_MESSAGE);
  assert.ok(result.message.length > 40, 'the message is written for the client to read');
  assert.equal(fake.calls.updates.length, 0, 'nothing was written to Stripe');
});

test('(d4) Stripe rejecting the update is reported, and nothing else is touched', async () => {
  const fake = useFake({
    subs: [makeSub({ id: 'sub_nope', metadata: { client_reference_id: CLIENT } })],
    updateFail: new Error('This subscription is not cancelable'),
  });
  const result = await cancelClientSubscription({ userId: CLIENT, email: null });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'STRIPE_UNAVAILABLE');
  assert.match(result.message, /NOT cancelled|not cancelled/i);
  assert.equal(fake.calls.updates.length, 1);
});

test('(d5) a Stripe outage on the read is not reported as a cancellation', async () => {
  useFake({ subsFail: true });
  const result = await cancelClientSubscription({ userId: CLIENT, email: null });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'STRIPE_UNAVAILABLE');
  assert.match(result.message, /NOT cancelled/i);
});

test('(d6) NO ACCESS REVOCATION: the billing module cannot touch local access state at all', () => {
  const source = read('services/stripeSubscriptions.ts');
  // No DB import ⇒ no tier, quota, lock or session write is even possible here.
  assert.equal(/from '\.\.\/db\//.test(source), false, 'stripeSubscriptions must not import the database');
  assert.equal(/\busers\b\s*\)/.test(source), false);
  // And the only write verb used against Stripe is subscriptions.update.
  assert.match(source, /subscriptions\.update\([^)]*cancel_at_period_end: true/);
  assert.equal(/subscriptions\.(del|cancel)\(/.test(source), false, 'never delete/cancel the object itself');
  // The client keeps working: nothing in the cancel path mentions tier/quota/lock.
  const cancelFn = source.slice(source.indexOf('export async function cancelClientSubscription'));
  assert.equal(/tier|quota|isLocked|is_locked/i.test(cancelFn), false);
});

test('(d7) a client holding two brands has both cancelled, and access runs to the LATEST period end', async () => {
  const laterEnd = PERIOD_END + 30 * 24 * 60 * 60;
  const fake = useFake({
    subs: [
      makeSub({ id: 'sub_multi_a', metadata: { client_reference_id: CLIENT } }),
      makeSub({ id: 'sub_multi_b', metadata: { client_reference_id: CLIENT }, priceId: PRICE_BRAND2, productId: PROD_BRAND2, productName: 'Empire Brand 2 Expansion Subscription', periodEnd: laterEnd }),
    ],
  });

  const result = await cancelClientSubscription({ userId: CLIENT, email: null });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(fake.calls.updates.length, 2);
  assert.deepEqual(
    result.subscriptions.map((s) => s.brandSlot).sort(),
    ['brand2', 'subscription'],
  );
  assert.equal(result.activeUntil, new Date(laterEnd * 1000).toISOString());
});

// ═══════════════════════ (e) the client-facing view ═════════════════════════

test('(e1) linked client sees the REAL Stripe period end and the brand slot', async () => {
  useFake({
    subs: [
      makeSub({
        id: 'sub_brand2',
        metadata: { client_reference_id: CLIENT },
        priceId: PRICE_BRAND2,
        productId: PROD_BRAND2,
        productName: 'Empire Brand 2 Expansion Subscription',
      }),
    ],
  });

  const view = await getClientBillingView({ userId: CLIENT, email: null });
  assert.equal(view.linked, true);
  assert.equal(view.plan?.brandSlot, 'brand2');
  assert.equal(view.plan?.brandLabel, 'Brand 2');
  assert.equal(view.plan?.amount, 5000);
  assert.equal(view.currentPeriodEnd, new Date(PERIOD_END * 1000).toISOString());
  assert.equal(view.activeUntil, view.currentPeriodEnd);
  assert.equal(view.cancelAtPeriodEnd, false);
  assert.equal(view.stillActive, true);
  assert.equal(view.matchedBy, 'client_reference_id');
  assert.deepEqual(view.brands, ['brand2']);
});

test('(e2) unlinked client gets an honest "linked: false" — no invented plan, no invented date', async () => {
  useFake({ subs: [] });
  const view = await getClientBillingView({ userId: CLIENT, email: 'nobody@example.com' });
  assert.equal(view.linked, false);
  assert.equal(view.reason, 'no_subscription');
  assert.equal(view.plan, undefined);
  assert.equal(view.currentPeriodEnd, undefined);
  assert.equal(view.activeUntil, undefined);
  assert.ok(!('currentPeriodEnd' in view), 'the field is absent, so no UI can render a fake date');
  assert.match(view.message || '', /No Stripe subscription/i);
});

test('(e3) a Stripe outage says "unavailable", not "you have no plan"', async () => {
  useFake({ subsFail: true });
  const view = await getClientBillingView({ userId: CLIENT, email: null });
  assert.equal(view.linked, false);
  assert.equal(view.reason, 'stripe_unavailable');
  assert.equal(view.currentPeriodEnd, undefined);
  assert.match(view.message || '', /temporarily unavailable/i);
});

test('(e4) a cancelled-but-active client still shows the paid-through date', async () => {
  useFake({
    subs: [makeSub({ id: 'sub_going', metadata: { client_reference_id: CLIENT }, cancel_at_period_end: true })],
  });
  const view = await getClientBillingView({ userId: CLIENT, email: null });
  assert.equal(view.linked, true);
  assert.equal(view.cancelAtPeriodEnd, true);
  assert.equal(view.stillActive, true);
  assert.equal(view.activeUntil, new Date(PERIOD_END * 1000).toISOString());
});

test('(e5) the base plan is chosen as the primary when the client holds several brands', async () => {
  useFake({
    subs: [
      makeSub({ id: 'sub_b3', metadata: { client_reference_id: CLIENT }, priceId: PRICE_BRAND3, productId: PROD_BRAND3, productName: 'Empire Brand 3 Expansion Subscription' }),
      makeSub({ id: 'sub_base', metadata: { client_reference_id: CLIENT } }),
    ],
  });
  const view = await getClientBillingView({ userId: CLIENT, email: null });
  assert.equal(view.plan?.brandSlot, 'subscription');
  assert.deepEqual([...(view.brands || [])].sort(), ['brand3', 'subscription']);
  assert.equal(view.subscriptions?.length, 2);
});
