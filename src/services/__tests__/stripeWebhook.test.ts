/**
 * STRIPE PAYMENT WEBHOOK — the client pays, the app finds out.
 *
 * Every case here posts a real signed body through the REAL Express app
 * (`src/index.ts`, imported with VERCEL=1 so it does not listen or start
 * workers): helmet, cors, morgan, the webhook router with its own express.raw(),
 * and — crucially — the global express.json() that must NOT have touched the body.
 * The fixture bodies are deliberately formatted with odd whitespace so that a body
 * which went through a JSON parser and was re-serialised would fail the signature.
 *
 * The database is an in-memory store injected through setStripeWebhookStore, so
 * these tests never touch a real database. The real drizzle store is proven
 * separately against the production Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import Stripe from 'stripe';

const SECRET = 'whsec_test_only_not_a_real_secret';
const BRAND2_LINK = 'plink_test_brand2';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const USER_EMAIL = 'payer@example.com';

// Env must be set before the app (and the service that builds the payment-link →
// brand map at import time) is loaded.
process.env.VERCEL = '1';
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_PAYMENT_LINK_BRAND1 = 'plink_test_brand1';
process.env.STRIPE_PAYMENT_LINK_BRAND2 = BRAND2_LINK;
process.env.STRIPE_PAYMENT_LINK_BRAND3 = 'plink_test_brand3';

const appModule = await import('../../index.js');
const service = await import('../stripeWebhookService.js');
const app = appModule.default;

// ---------------------------------------------------------------------------
// In-memory store standing in for the database
// ---------------------------------------------------------------------------

interface FakeState {
  events: Map<string, any>;
  subscriptions: any[];
  logs: any[];
  users: Map<string, { id: string; businessSlots: number; email: string; isLocked: boolean }>;
  cancelled: string[];
}

function makeStore(state: FakeState) {
  return {
    async claimEvent(record: any) {
      if (state.events.has(record.id)) return false;
      state.events.set(record.id, { ...record });
      return true;
    },
    async finishEvent(eventId: string, patch: any) {
      const row = state.events.get(eventId);
      if (row) Object.assign(row, patch);
    },
    async findUserById(userId: string) {
      const user = state.users.get(userId);
      return user ? { id: user.id, businessSlots: user.businessSlots } : null;
    },
    async findUserByEmail(email: string) {
      for (const user of state.users.values()) {
        if (user.email.toLowerCase() === String(email || '').toLowerCase()) {
          return { id: user.id, businessSlots: user.businessSlots };
        }
      }
      return null;
    },
    async hasPaymentForSession(sessionId: string) {
      return state.subscriptions.some((row) => row.stripeSessionId === sessionId);
    },
    async applyPayment(input: any) {
      state.subscriptions.push({
        userId: input.userId,
        type: input.brandSlot === 1 ? 'subscription' : 'expansion',
        stripeSessionId: input.sessionId,
        amount: input.amountTotal,
        paidAt: input.paidAt,
        stripeSubscriptionId: input.stripeSubscriptionId,
        customerName: input.customerName,
      });
      state.logs.push({
        userId: input.userId,
        amount: input.amountTotal,
        status: 'paid',
        periodStart: input.paidAt,
        periodEnd: input.renewalAt,
        type: input.brandSlot === 1 ? 'subscription' : 'expansion',
      });
      const user = state.users.get(input.userId);
      if (user) {
        user.businessSlots = Math.max(user.businessSlots, input.brandSlot);
        user.isLocked = false;
      }
    },
    async cancelSubscription(stripeSubscriptionId: string) {
      state.cancelled.push(stripeSubscriptionId);
      return state.subscriptions.filter((row) => row.stripeSubscriptionId === stripeSubscriptionId).length;
    },
  };
}

function freshState(): FakeState {
  const users = new Map<string, any>();
  users.set(USER_ID, { id: USER_ID, businessSlots: 1, email: USER_EMAIL, isLocked: true });
  return { events: new Map(), subscriptions: [], logs: [], users, cancelled: [] };
}

// ---------------------------------------------------------------------------
// The real server
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';

test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(() => {
  server?.close();
});

/**
 * A body formatted the way Stripe does NOT send it — extra spaces and a newline.
 * If express.json() had parsed and re-serialised this, the bytes would change and
 * the signature would no longer match. That is the raw-body proof.
 */
function sessionBody(overrides: Record<string, unknown> = {}, eventId = 'evt_test_1') {
  const event = {
    id: eventId,
    object: 'event',
    api_version: '2024-06-20',
    created: 1_770_000_000,
    livemode: false,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_abc123',
        object: 'checkout.session',
        mode: 'subscription',
        amount_total: 5000,
        currency: 'usd',
        customer: 'cus_test_1',
        subscription: 'sub_test_1',
        payment_link: BRAND2_LINK,
        client_reference_id: USER_ID,
        customer_details: { email: USER_EMAIL, name: 'Jane Cooper' },
        ...overrides,
      },
    },
  };
  return JSON.stringify(event, null, 1).replace(/\n/g, '\n ');
}

function sign(payload: string, secret = SECRET) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

async function post(payload: string, signature: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature) headers['stripe-signature'] = signature;
  const res = await fetch(`${baseUrl}/api/webhooks/stripe`, { method: 'POST', headers, body: payload });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('[stripe webhook] a signed checkout.session.completed through the real middleware stack marks the client paid', async () => {
  const state = freshState();
  service.setStripeWebhookStore(makeStore(state) as any);
  const payload = sessionBody();

  const res = await post(payload, sign(payload));

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.equal(res.json?.status, 'applied');

  // The right row, for the right brand, with the right money and dates.
  assert.equal(state.subscriptions.length, 1, 'exactly one payment row');
  const payment = state.subscriptions[0];
  assert.equal(payment.userId, USER_ID);
  assert.equal(payment.type, 'expansion', 'brand 2 link must book an expansion');
  assert.equal(payment.stripeSessionId, 'cs_test_abc123');
  assert.equal(payment.amount, 5000);
  assert.equal(payment.stripeSubscriptionId, 'sub_test_1');
  assert.equal(payment.customerName, 'Jane Cooper');
  assert.ok(payment.paidAt instanceof Date);

  // Paid state + renewal date exactly one month later.
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].status, 'paid');
  const days = (state.logs[0].periodEnd.getTime() - state.logs[0].periodStart.getTime()) / 86_400_000;
  assert.ok(days >= 28 && days <= 31, `renewal should be ~1 month out, got ${days} days`);

  // The brand slot the client now owns, and the account is not locked.
  const user = state.users.get(USER_ID)!;
  assert.equal(user.businessSlots, 2, 'brand 2 must lift business_slots to 2');
  assert.equal(user.isLocked, false);

  // The event ledger says applied, and it matched on the reference id.
  const event = state.events.get('evt_test_1');
  assert.equal(event.status, 'applied');
  assert.equal(event.reason, 'matched_by_client_reference_id');
  assert.equal(event.brandSlot, 2);
});

test('[stripe webhook] a tampered body is a 400 and nothing is written', async () => {
  const state = freshState();
  service.setStripeWebhookStore(makeStore(state) as any);
  const payload = sessionBody();
  const signature = sign(payload);
  const tampered = payload.replace('5000', '5');

  const res = await post(tampered, signature);

  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
  assert.match(res.text, /signature/i);
  assert.equal(state.events.size, 0, 'no event row');
  assert.equal(state.subscriptions.length, 0, 'no payment row');
  assert.equal(state.users.get(USER_ID)!.businessSlots, 1, 'slots untouched');
});

test('[stripe webhook] a missing signature header is a 400 and nothing is written', async () => {
  const state = freshState();
  service.setStripeWebhookStore(makeStore(state) as any);
  const payload = sessionBody();

  const res = await post(payload, null);

  assert.equal(res.status, 400);
  assert.equal(state.events.size, 0);
  assert.equal(state.subscriptions.length, 0);
});

test('[stripe webhook] Stripe retrying the same event id applies the payment once', async () => {
  const state = freshState();
  service.setStripeWebhookStore(makeStore(state) as any);
  const payload = sessionBody();

  const first = await post(payload, sign(payload));
  const second = await post(payload, sign(payload));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'a retry is a 200, never a 500');
  assert.equal(state.subscriptions.length, 1, 'a second delivery must not create a second payment row');
  assert.equal(state.logs.length, 1, 'nor extend the subscription twice');
  assert.equal(state.users.get(USER_ID)!.businessSlots, 2, 'nor double the brand slot');
});

test('[stripe webhook] an unknown event type is a fast 200 and changes nothing', async () => {
  const state = freshState();
  service.setStripeWebhookStore(makeStore(state) as any);
  const payload = JSON.stringify({
    id: 'evt_unknown_1',
    object: 'event',
    type: 'customer.created',
    data: { object: { id: 'cus_x', object: 'customer' } },
  });

  const res = await post(payload, sign(payload));

  assert.equal(res.status, 200);
  assert.equal(res.json?.status, 'ignored');
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.events.get('evt_unknown_1')?.status, 'ignored');
});

test('[stripe webhook] a payment we cannot attribute is recorded as unmatched, never dropped', async () => {
  const state = freshState();
  service.setStripeWebhookStore(makeStore(state) as any);
  const payload = sessionBody({
    client_reference_id: '99999999-9999-4999-8999-999999999999',
    customer_details: { email: 'stranger@example.com', name: 'Nobody' },
  });

  const res = await post(payload, sign(payload));

  assert.equal(res.status, 200, 'a real payment must never be answered with an error');
  assert.equal(res.json?.status, 'unmatched');
  const event = state.events.get('evt_test_1');
  assert.equal(event.status, 'unmatched');
  assert.match(String(event.reason), /stranger@example\.com/);
  assert.equal(event.amountTotal, 5000, 'the money is recorded even without a user');
  assert.equal(state.subscriptions.length, 0, 'and no subscription is invented for a stranger');
});

test('[stripe webhook] no STRIPE_WEBHOOK_SECRET is a readable 503, not a crash', async () => {
  const state = freshState();
  service.setStripeWebhookStore(makeStore(state) as any);
  const payload = sessionBody();
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const res = await post(payload, sign(payload));
    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${res.text}`);
    assert.match(res.text, /STRIPE_WEBHOOK_SECRET/);
    assert.doesNotMatch(res.text, /at .*\.ts:\d+/, 'no stack trace');
    assert.equal(state.events.size, 0);
    assert.equal(state.subscriptions.length, 0);
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = saved;
  }
});

test('[stripe webhook] the raw bytes reach the verifier — express.json() did not rewrite them', async () => {
  // If the global JSON parser had touched this route, the signature would fail.
  const state = freshState();
  service.setStripeWebhookStore(makeStore(state) as any);
  const payload = sessionBody({}, 'evt_rawbytes_1');
  assert.ok(payload.includes('\n'), 'fixture must be pretty-printed to prove raw bytes are preserved');

  const res = await post(payload, sign(payload));

  assert.equal(res.status, 200, `signature must verify against the untouched bytes: ${res.text}`);
  assert.equal(state.events.get('evt_rawbytes_1')?.status, 'applied');
});

test('[stripe webhook] the payment-link → brand map is one constant seeded per brand', () => {
  assert.equal(service.brandSlotForPaymentLink('plink_test_brand1'), 1);
  assert.equal(service.brandSlotForPaymentLink('plink_test_brand2'), 2);
  assert.equal(service.brandSlotForPaymentLink('plink_test_brand3'), 3);
  // A full buy.stripe.com URL works too, and an unknown link never throws.
  assert.equal(service.brandSlotForPaymentLink('https://buy.stripe.com/plink_test_brand3'), 3);
  assert.equal(service.brandSlotForPaymentLink('plink_unknown'), 1);
  assert.equal(service.brandSlotForPaymentLink(null), 1);
});

test('[stripe webhook] renewal date is one month out and clamped at month end', () => {
  const jan31 = new Date('2027-01-31T12:00:00.000Z');
  assert.equal(service.addOneMonth(jan31).toISOString().slice(0, 10), '2027-02-28');
  const mar15 = new Date('2027-03-15T12:00:00.000Z');
  assert.equal(service.addOneMonth(mar15).toISOString().slice(0, 10), '2027-04-15');
});
