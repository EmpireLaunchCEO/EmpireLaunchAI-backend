/**
 * STRIPE PAYMENT WEBHOOK — the app finally learns that a client paid.
 *
 * The owner sells through THREE Payment Links in HER OWN Stripe account
 * (frontend `src/lib/payment-links.ts`). Nothing on the platform side takes the
 * money, so the only signal the app can get is Stripe's own webhook event. This
 * service applies that event to the real per-brand subscription model that
 * already exists in this repo:
 *
 *   subscriptions        — one row per paid brand (type 'subscription' = brand 1,
 *                          'expansion' = brand 2/3) with the payment date. This is
 *                          what `adminController` counts as a paying client and
 *                          what `subscriptionController.checkRenewal` reads.
 *   subscription_logs    — status 'paid' + periodStart/periodEnd, i.e. the payment
 *                          date and the renewal date (+1 month). This is what
 *                          `subscriptionGuard` reads to decide suspension.
 *   users.business_slots — the brand slot the client actually owns (1..3), and
 *                          is_locked = false so the account is active again.
 *   stripe_webhook_events— one row per Stripe event id: the idempotency ledger, and
 *                          the home of a payment we could not attribute to a user
 *                          (never dropped, never silently lost).
 *
 * Two hard rules from the brief, encoded here:
 *   - NO Stripe API calls and NO Stripe API key. `checkout.session.completed`
 *     carries everything. The only secret is STRIPE_WEBHOOK_SECRET (signature).
 *   - NO `resolveUserId` / identity middleware. The caller is Stripe, not a user,
 *     and `resolveUserId` CREATES a user for an unknown id — exactly wrong here.
 *     An unknown id falls through to the email, and then to 'unmatched'.
 */
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

// The payment-link → brand map below is built at import time, so .env must be
// loaded first (same pattern as services/stripeService.ts). In production these
// are real service variables.
dotenv.config();

/** The one deployed path the owner pastes into her Stripe dashboard. */
export const STRIPE_WEBHOOK_PATH = '/api/webhooks/stripe';

/** The one env var the owner must save (her Stripe signing secret). */
export const STRIPE_WEBHOOK_SECRET_ENV = 'STRIPE_WEBHOOK_SECRET';

export const STRIPE_WEBHOOK_SECRET_MISSING_MESSAGE =
  `Stripe webhook is not configured yet: ${STRIPE_WEBHOOK_SECRET_ENV} is not set on the server. ` +
  `Add this endpoint in the Stripe dashboard (Developers → Webhooks → Add endpoint) for ` +
  `${STRIPE_WEBHOOK_PATH}, then save the signing secret it shows as ${STRIPE_WEBHOOK_SECRET_ENV}. ` +
  `No payment is being recorded until that secret is saved.`;

export type BrandSlotNumber = 1 | 2 | 3;

/**
 * ONE named constant, the only place a Stripe Payment Link id maps to a brand.
 *
 * The owner's three links live in her own Stripe account, so their `plink_...`
 * ids do not exist anywhere in this repo and cannot be looked up without a
 * Stripe API call (which this route must never make). They are therefore seeded
 * from the environment, one variable per brand, at boot:
 *
 *   STRIPE_PAYMENT_LINK_BRAND1 = plink_...   (the $50/mo subscription, brand 1)
 *   STRIPE_PAYMENT_LINK_BRAND2 = plink_...   (expansion slot, brand 2)
 *   STRIPE_PAYMENT_LINK_BRAND3 = plink_...   (expansion slot, brand 3)
 *
 * Either the bare id or the full `https://buy.stripe.com/...` link is accepted.
 * An unmapped link is credited to brand 1 and logged loudly with its exact id
 * (see `brandSlotForPaymentLink`) — never dropped.
 */
export const PAYMENT_LINK_ENV_NAMES: Readonly<Record<BrandSlotNumber, string>> = Object.freeze({
  1: 'STRIPE_PAYMENT_LINK_BRAND1',
  2: 'STRIPE_PAYMENT_LINK_BRAND2',
  3: 'STRIPE_PAYMENT_LINK_BRAND3',
});

export const PAYMENT_LINK_BRAND_SLOTS: Readonly<Record<string, BrandSlotNumber>> =
  Object.freeze(buildPaymentLinkBrandSlots());

/** `https://buy.stripe.com/abc123` and `plink_abc123` both normalise to a key. */
function normalizeLinkKey(value: string | null | undefined): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const clean = tail.split('?')[0].trim();
  return clean || null;
}

function buildPaymentLinkBrandSlots(): Record<string, BrandSlotNumber> {
  const map: Record<string, BrandSlotNumber> = {};
  const pairs: Array<[BrandSlotNumber, string]> = [
    [1, PAYMENT_LINK_ENV_NAMES[1]],
    [2, PAYMENT_LINK_ENV_NAMES[2]],
    [3, PAYMENT_LINK_ENV_NAMES[3]],
  ];
  for (const [slot, envName] of pairs) {
    const key = normalizeLinkKey(process.env[envName]);
    if (key) map[key] = slot;
  }
  return map;
}

/**
 * Which brand did this payment buy? Mapped link → that slot. Anything else is
 * credited to brand 1 (the base plan every client starts on) and logged with the
 * exact payment-link id so it can be added to `PAYMENT_LINK_BRAND_SLOTS`.
 */
export function brandSlotForPaymentLink(linkId: string | null | undefined): BrandSlotNumber {
  const key = normalizeLinkKey(linkId);
  const mapped = key ? PAYMENT_LINK_BRAND_SLOTS[key] : undefined;
  if (mapped) return mapped;
  console.warn(
    `[StripeWebhook] UNMAPPED payment link "${linkId || '(none)'}" — credited to brand 1. ` +
      `Set ${PAYMENT_LINK_ENV_NAMES[1]} / ${PAYMENT_LINK_ENV_NAMES[2]} / ${PAYMENT_LINK_ENV_NAMES[3]} ` +
      `to the plink_ ids from the Stripe dashboard to attribute brands 2 and 3 correctly.`,
  );
  return 1;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface StripeWebhookUser {
  id: string;
  businessSlots: number;
}

export interface StripeWebhookEventRecord {
  id: string;
  type: string;
  status: WebhookStatus;
  reason?: string | null;
  userId?: string | null;
  brandSlot?: number | null;
  paymentLinkId?: string | null;
  stripeSessionId?: string | null;
  stripeCustomerId?: string | null;
  customerEmail?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
  mode?: string | null;
  payload?: unknown;
}

export interface StripeWebhookEventPatch {
  status?: WebhookStatus;
  reason?: string | null;
  userId?: string | null;
  brandSlot?: number | null;
  paymentLinkId?: string | null;
  stripeSessionId?: string | null;
  stripeCustomerId?: string | null;
  customerEmail?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
  mode?: string | null;
  processedAt?: Date | null;
}

export interface ApplyPaymentInput {
  userId: string;
  brandSlot: BrandSlotNumber;
  sessionId: string;
  amountTotal: number | null;
  currency: string | null;
  paidAt: Date;
  renewalAt: Date;
  stripeSubscriptionId: string | null;
  stripeInvoiceId: string | null;
  customerName: string | null;
}

/**
 * Everything this route needs from the database. The real implementation is
 * `drizzleStripeWebhookStore`; tests inject an in-memory one so the HTTP path can
 * be proven without touching a database.
 */
export interface StripeWebhookStore {
  /** Atomically claim an event id. `false` = Stripe retried, already applied. */
  claimEvent(record: StripeWebhookEventRecord): Promise<boolean>;
  finishEvent(eventId: string, patch: StripeWebhookEventPatch): Promise<void>;
  findUserById(userId: string): Promise<StripeWebhookUser | null>;
  findUserByEmail(email: string): Promise<StripeWebhookUser | null>;
  hasPaymentForSession(sessionId: string): Promise<boolean>;
  applyPayment(input: ApplyPaymentInput): Promise<void>;
  cancelSubscription(stripeSubscriptionId: string): Promise<number>;
}

/** +1 month, clamped so Jan 31 → Feb 28/29 instead of spilling into March. */
export function addOneMonth(from: Date): Date {
  const next = new Date(from.getTime());
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  const lastDayOfTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDayOfTargetMonth));
  return next;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as any).id === 'string') return (value as any).id;
  return null;
}

async function findUserByIdImpl(userId: string): Promise<StripeWebhookUser | null> {
  if (!UUID_RE.test(String(userId || ''))) return null;
  const rows = await db
    .select({ id: schema.users.id, businessSlots: schema.users.businessSlots })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? { id: row.id, businessSlots: Number(row.businessSlots ?? 1) } : null;
}

export const drizzleStripeWebhookStore: StripeWebhookStore = {
  async claimEvent(record) {
    // `id` is the Stripe event id and the primary key: a retry of the same event
    // conflicts, returns no row, and is answered 200 without applying anything twice.
    const inserted = await db
      .insert(schema.stripeWebhookEvents)
      .values({
        id: record.id,
        type: record.type,
        status: record.status,
        reason: record.reason ?? null,
        userId: record.userId ?? null,
        brandSlot: record.brandSlot ?? null,
        paymentLinkId: record.paymentLinkId ?? null,
        stripeSessionId: record.stripeSessionId ?? null,
        stripeCustomerId: record.stripeCustomerId ?? null,
        customerEmail: record.customerEmail ?? null,
        amountTotal: record.amountTotal ?? null,
        currency: record.currency ?? null,
        mode: record.mode ?? null,
        payload: record.payload ?? null,
        receivedAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.stripeWebhookEvents.id })
      .returning({ id: schema.stripeWebhookEvents.id });
    return Array.isArray(inserted) && inserted.length > 0;
  },

  async finishEvent(eventId, patch) {
    await db
      .update(schema.stripeWebhookEvents)
      .set({ ...patch, processedAt: patch.processedAt ?? new Date() })
      .where(eq(schema.stripeWebhookEvents.id, eventId));
  },

  async findUserById(userId) {
    return findUserByIdImpl(userId);
  },

  async findUserByEmail(email) {
    const clean = String(email || '').trim().toLowerCase();
    if (!clean) return null;
    const rows = await db
      .select({ id: schema.users.id, businessSlots: schema.users.businessSlots })
      .from(schema.users)
      .where(eq(schema.users.email, clean))
      .limit(1);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? { id: row.id, businessSlots: Number(row.businessSlots ?? 1) } : null;
  },

  async hasPaymentForSession(sessionId) {
    const rows = await db
      .select({ id: schema.subscriptions.id })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.stripeSessionId, sessionId))
      .limit(1);
    return Array.isArray(rows) && rows.length > 0;
  },

  async applyPayment(input) {
    const isBase = input.brandSlot === 1;
    await db.insert(schema.subscriptions).values({
      userId: input.userId,
      type: isBase ? 'subscription' : 'expansion',
      stripeSessionId: input.sessionId,
      amount: input.amountTotal,
      paidAt: input.paidAt,
      stripeSubscriptionId: input.stripeSubscriptionId,
      customerName: input.customerName,
      createdAt: input.paidAt,
    });
    await db.insert(schema.subscriptionLogs).values({
      userId: input.userId,
      amount: input.amountTotal ?? 0,
      status: 'paid',
      periodStart: input.paidAt,
      periodEnd: input.renewalAt,
      type: isBase ? 'subscription' : 'expansion',
      stripeInvoiceId: input.stripeInvoiceId,
      createdAt: input.paidAt,
    });
    const user = await findUserByIdImpl(input.userId);
    const slots = Math.max(Number(user?.businessSlots ?? 1), input.brandSlot);
    await db
      .update(schema.users)
      .set({ businessSlots: slots, isLocked: false, updatedAt: input.paidAt })
      .where(eq(schema.users.id, input.userId));
  },

  async cancelSubscription(stripeSubscriptionId) {
    const rows = await db
      .update(schema.subscriptions)
      .set({ canceledAt: new Date() })
      .where(
        and(
          eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
          isNull(schema.subscriptions.canceledAt),
        ),
      )
      .returning({ id: schema.subscriptions.id });
    return Array.isArray(rows) ? rows.length : 0;
  },
};

let store: StripeWebhookStore = drizzleStripeWebhookStore;

export function setStripeWebhookStore(next: StripeWebhookStore | null): void {
  store = next ?? drizzleStripeWebhookStore;
}

export function getStripeWebhookStore(): StripeWebhookStore {
  return store;
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

export type WebhookStatus = 'processing' | 'applied' | 'unmatched' | 'ignored' | 'failed';

export interface WebhookOutcome {
  /** What we did with it, for the log line and the 200 body. */
  status: WebhookStatus;
  /** Machine-ish explanation, also persisted on the event row. */
  reason: string | null;
  userId: string | null;
  brandSlot: number | null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Who paid? `client_reference_id` first (the frontend appends the user id), then
 * the email Stripe collected. Deliberately NOT `resolveUserId`: that helper
 * creates a user for an unknown id, which would hand an account to whoever types
 * a uuid into a payment link.
 */
async function resolveIdentity(session: any): Promise<{
  userId: string;
  match: 'client_reference_id' | 'email';
} | null> {
  const reference = readString(session?.client_reference_id);
  if (reference) {
    const byId = await store.findUserById(reference);
    if (byId) return { userId: byId.id, match: 'client_reference_id' };
  }
  const email =
    readString(session?.customer_details?.email) ?? readString(session?.customer_email);
  if (email) {
    const byEmail = await store.findUserByEmail(email);
    if (byEmail) return { userId: byEmail.id, match: 'email' };
  }
  return null;
}

async function applyCheckoutSessionCompleted(session: any): Promise<WebhookOutcome> {
  const sessionId = readString(session?.id) || '(no session id)';
  const linkId = asId(session?.payment_link);
  const customerEmail =
    readString(session?.customer_details?.email) ?? readString(session?.customer_email);
  const identity = await resolveIdentity(session);
  const brandSlot = brandSlotForPaymentLink(linkId);

  if (!identity) {
    console.error(
      `[StripeWebhook] UNMATCHED PAYMENT — session ${sessionId} (${session?.amount_total ?? '?'} ` +
        `${session?.currency ?? ''}, link ${linkId || 'none'}, email ${customerEmail || 'none'}) ` +
        `could not be attributed to any user. It is recorded as 'unmatched' in stripe_webhook_events; ` +
        `the client has paid and needs access.`,
    );
    return {
      status: 'unmatched',
      reason: `no_user_for client_reference_id="${readString(session?.client_reference_id) || ''}" email="${customerEmail || ''}"`,
      userId: null,
      brandSlot,
    };
  }

  if (await store.hasPaymentForSession(sessionId)) {
    return {
      status: 'applied',
      reason: 'payment_already_recorded_for_session',
      userId: identity.userId,
      brandSlot,
    };
  }

  const paidAt = new Date();
  await store.applyPayment({
    userId: identity.userId,
    brandSlot,
    sessionId,
    amountTotal: typeof session?.amount_total === 'number' ? session.amount_total : null,
    currency: readString(session?.currency),
    paidAt,
    renewalAt: addOneMonth(paidAt),
    stripeSubscriptionId: asId(session?.subscription),
    stripeInvoiceId: asId(session?.invoice),
    customerName: readString(session?.customer_details?.name),
  });

  console.log(
    `[StripeWebhook] PAID — user ${identity.userId} (matched by ${identity.match}) ` +
      `brand ${brandSlot}, ${session?.amount_total ?? '?'} ${session?.currency ?? ''}, ` +
      `session ${sessionId}, renews ${addOneMonth(paidAt).toISOString()}`,
  );
  return {
    status: 'applied',
    reason: `matched_by_${identity.match}`,
    userId: identity.userId,
    brandSlot,
  };
}

async function applySubscriptionDeleted(subscription: any): Promise<WebhookOutcome> {
  const subscriptionId = readString(subscription?.id);
  if (!subscriptionId) {
    return { status: 'ignored', reason: 'subscription_deleted_without_id', userId: null, brandSlot: null };
  }
  const canceled = await store.cancelSubscription(subscriptionId);
  console.log(
    `[StripeWebhook] SUBSCRIPTION DELETED — ${subscriptionId} marked cancelled on ${canceled} brand row(s).`,
  );
  return {
    status: canceled > 0 ? 'applied' : 'ignored',
    reason: `subscription_deleted_marked_${canceled}`,
    userId: null,
    brandSlot: null,
  };
}

/**
 * Apply one verified Stripe event. Never throws for a "could not apply" case —
 * it returns the outcome so the route can answer 200 and Stripe stops retrying.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<WebhookOutcome> {
  const object: any = (event as any)?.data?.object ?? {};
  const claimed = await store.claimEvent({
    id: event.id,
    type: event.type,
    status: 'processing',
    stripeSessionId: readString(object?.id),
    paymentLinkId: asId(object?.payment_link),
    stripeCustomerId: asId(object?.customer),
    customerEmail:
      readString(object?.customer_details?.email) ?? readString(object?.customer_email),
    amountTotal: typeof object?.amount_total === 'number' ? object.amount_total : null,
    currency: readString(object?.currency),
    mode: readString(object?.mode),
    payload: event as unknown,
  });

  if (!claimed) {
    console.log(`[StripeWebhook] duplicate event ${event.id} (${event.type}) — already applied, no-op.`);
    return { status: 'applied', reason: 'duplicate_event_noop', userId: null, brandSlot: null };
  }

  let outcome: WebhookOutcome;
  try {
    if (event.type === 'checkout.session.completed') {
      outcome = await applyCheckoutSessionCompleted(object);
    } else if (event.type === 'customer.subscription.deleted') {
      outcome = await applySubscriptionDeleted(object);
    } else {
      // Every other type is a fast 200. `invoice.payment_failed` is explicitly
      // skipped: the subscriptions model has no lapsed/past-due state to move to
      // (only `canceled_at`, which `customer.subscription.deleted` owns).
      outcome = {
        status: 'ignored',
        reason:
          event.type === 'invoice.payment_failed'
            ? 'no_lapsed_state_for_invoice_payment_failed'
            : `unhandled_event_type_${event.type}`,
        userId: null,
        brandSlot: null,
      };
    }
  } catch (error: any) {
    const reason = `apply_failed: ${error?.message || 'unknown error'}`;
    console.error(`[StripeWebhook] could not apply event ${event.id} (${event.type}): ${reason}`);
    outcome = { status: 'failed', reason, userId: null, brandSlot: null };
  }

  await store.finishEvent(event.id, {
    status: outcome.status,
    reason: outcome.reason,
    userId: outcome.userId,
    brandSlot: outcome.brandSlot,
    processedAt: new Date(),
  });

  return outcome;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export interface VerifiedEvent {
  ok: true;
  event: Stripe.Event;
}

export interface VerifyFailure {
  ok: false;
  status: number;
  message: string;
}

/**
 * Verify the signature against the EXACT raw bytes Stripe signed.
 *
 * `Stripe.webhooks.constructEvent` is used as a static, so this route needs no
 * Stripe API key at all — only the signing secret.
 */
export function verifyStripeSignature(
  rawBody: Buffer | string | undefined,
  signature: string | string[] | undefined,
  secret: string,
): VerifiedEvent | VerifyFailure {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : typeof rawBody === 'string' ? Buffer.from(rawBody) : null;
  if (!raw || raw.length === 0) {
    return {
      ok: false,
      status: 400,
      message:
        'Stripe webhook received no raw body. The endpoint must be mounted with express.raw() ' +
        'before the global express.json() parser, or the exact bytes Stripe signed are lost.',
    };
  }
  const header = Array.isArray(signature) ? signature[0] : signature;
  if (!header) {
    return { ok: false, status: 400, message: 'Missing stripe-signature header.' };
  }
  try {
    const event = Stripe.webhooks.constructEvent(raw, header, secret);
    return { ok: true, event };
  } catch (error: any) {
    return {
      ok: false,
      status: 400,
      message: `Stripe signature verification failed: ${error?.message || 'invalid signature'}`,
    };
  }
}

export const stripeWebhookService = {
  STRIPE_WEBHOOK_PATH,
  STRIPE_WEBHOOK_SECRET_ENV,
  PAYMENT_LINK_BRAND_SLOTS,
  brandSlotForPaymentLink,
  addOneMonth,
  handleStripeEvent,
  verifyStripeSignature,
  setStripeWebhookStore,
  getStripeWebhookStore,
  drizzleStripeWebhookStore,
};
