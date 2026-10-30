/**
 * STRIPE SUBSCRIPTIONS — the one place the app learns the truth about money.
 *
 * Before this module the app guessed:
 *   • `stripeService.getSubscriptionStatus()` looked at the last 5 checkout
 *     sessions and called it a day (a client who bought anything afterwards
 *     looked unsubscribed);
 *   • `subscriptionController.cancelSubscription` returned 404 when no
 *     `stripeSubscriptionId` was stored locally, and the frontend swallowed it —
 *     so a client could believe they cancelled while Stripe kept billing;
 *   • Home Base counted `subscriptions` rows written by the checkout verify step,
 *     which only exist if the client happened to hit that endpoint.
 *
 * This module reads Stripe once and answers every money question from that one
 * snapshot:
 *   • one client  → status, real `currentPeriodEnd`, `cancelAtPeriodEnd`, brand slot
 *   • the owner   → paying clients, per-brand counts, cancelled-but-still-active
 *   • cancel      → `cancel_at_period_end: true` (owner rule: access runs to the
 *                   day before renewal — cancellation NEVER revokes access)
 *
 * DESIGN RULES (learned the hard way on this codebase):
 *   1. Never invent a plan or a date. If a client cannot be tied to a Stripe
 *      subscription the answer is `linked: false` with a reason, not a fake
 *      "renews in 30 days" (that fake date is still on the Settings card today).
 *   2. Never report a failure as a zero. A Stripe outage must surface as an
 *      error the caller can render as "—", not as "0 paying clients".
 *   3. Tests never touch live Stripe: the client is injected through
 *      `setStripeApi()` and nothing here builds a real client until a call is
 *      actually made (so importing this module needs no STRIPE_SECRET_KEY).
 *   4. Brand slots are resolved from price/product IDENTITY (verified live), with
 *      env overrides, then a product-NAME heuristic, then an explicit default —
 *      never from the payment link, because the same product has several links
 *      and eleven products share duplicate names.
 */

import Stripe from 'stripe';
import dotenv from 'dotenv';
import { isOwnerIdentity, normalizeOwnerEmail, OWNER_USER_ID } from './ownerIdentity.js';

dotenv.config();

// ─────────────────────────────── brand slots ────────────────────────────────

/** The three things a client can pay for. `subscription` is the base brand slot. */
export type BrandSlot = 'subscription' | 'brand2' | 'brand3';

export const BRAND_SLOTS: readonly BrandSlot[] = ['subscription', 'brand2', 'brand3'];

/** Owner-facing names, matching the Home Base card copy. */
export const BRAND_LABELS: Record<BrandSlot, string> = {
  subscription: 'Subscription',
  brand2: 'Brand 2',
  brand3: 'Brand 3',
};

/**
 * Price IDs verified live against the account on 2026-10-30 (read-only
 * `prices.list` + `paymentLinks.retrieve`, zero cost). Three active payment links
 * map one-to-one onto the three slots:
 *   cNifZhaIo3vIfzxatFefC04 → price_1TvpWDDrblkzsiVM1103uTqb (EmpireLaunch AI Subscription)
 *   4gM28r4k08Q2drp1X9efC06 → price_1TwkaIDrblkzsiVMtsEP18TB (Empire Brand 2 Expansion)
 *   eVq6oH7wcd6i5YX0T5efC07 → price_1TyeuqDrblkzsiVMhiCktLiP (Empire Brand 3 Expansion)
 * The two extra `subscription` prices are earlier duplicates of the same $50/mo
 * base plan that clients may already be on, so they must resolve to the base slot
 * rather than fall through to the default.
 */
const KNOWN_PRICE_SLOTS: Readonly<Record<string, BrandSlot>> = {
  price_1TvpWDDrblkzsiVM1103uTqb: 'subscription',
  price_1TvoejDrblkzsiVME1uomjbi: 'subscription',
  price_1TYzFsDrblkzsiVMxWuyJAlO: 'subscription',
  price_1TwkaIDrblkzsiVMtsEP18TB: 'brand2',
  price_1TyeuqDrblkzsiVMhiCktLiP: 'brand3',
};

/** Product IDs for the same three plans (products outlive prices). */
const KNOWN_PRODUCT_SLOTS: Readonly<Record<string, BrandSlot>> = {
  prod_UvguYkSJiAasqC: 'subscription',
  prod_Uvg0ZchhSQUgGa: 'subscription',
  prod_UY5Q5TN2CKdUbR: 'subscription',
  prod_UwdsLaUyzg2WgS: 'brand2',
  prod_Uyc9Vws147m6sK: 'brand3',
};

/** Where a brand decision came from — surfaced so a surprising count is explainable. */
export type BrandSlotSource =
  | 'env_price'
  | 'known_price'
  | 'env_product'
  | 'known_product'
  | 'product_name'
  | 'default';

export interface BrandSlotResolution {
  slot: BrandSlot;
  source: BrandSlotSource;
  /** The price id / product id / product name that decided it. */
  matchedOn: string | null;
}

export interface BrandInput {
  priceId?: string | null;
  productId?: string | null;
  productName?: string | null;
}

function envSlotOverrides(): { prices: Record<string, BrandSlot>; products: Record<string, BrandSlot> } {
  const pairs: Array<[string, BrandSlot]> = [
    ['STRIPE_PRICE_BRAND1', 'subscription'],
    ['STRIPE_PRICE_SUBSCRIPTION', 'subscription'],
    ['STRIPE_PRICE_BRAND2', 'brand2'],
    ['STRIPE_PRICE_BRAND3', 'brand3'],
    ['STRIPE_PRODUCT_BRAND1', 'subscription'],
    ['STRIPE_PRODUCT_SUBSCRIPTION', 'subscription'],
    ['STRIPE_PRODUCT_BRAND2', 'brand2'],
    ['STRIPE_PRODUCT_BRAND3', 'brand3'],
  ];
  const prices: Record<string, BrandSlot> = {};
  const products: Record<string, BrandSlot> = {};
  for (const [key, slot] of pairs) {
    const value = String(process.env[key] || '').trim();
    if (!value) continue;
    if (key.includes('_PRICE_')) prices[value] = slot;
    else products[value] = slot;
  }
  return { prices, products };
}

/**
 * Deterministic brand-slot resolution. Order matters: an explicit configuration
 * beats a known ID, which beats a name heuristic, which beats the default.
 * The default is the base plan — a recurring subscription that matches nothing
 * else is the entry product, and `source: 'default'` makes that visible.
 */
export function resolveBrandSlot(input: BrandInput): BrandSlotResolution {
  const priceId = String(input.priceId || '').trim();
  const productId = String(input.productId || '').trim();
  const productName = String(input.productName || '').trim();
  const env = envSlotOverrides();

  if (priceId && env.prices[priceId]) return { slot: env.prices[priceId], source: 'env_price', matchedOn: priceId };
  if (priceId && KNOWN_PRICE_SLOTS[priceId]) return { slot: KNOWN_PRICE_SLOTS[priceId], source: 'known_price', matchedOn: priceId };
  if (productId && env.products[productId]) return { slot: env.products[productId], source: 'env_product', matchedOn: productId };
  if (productId && KNOWN_PRODUCT_SLOTS[productId]) return { slot: KNOWN_PRODUCT_SLOTS[productId], source: 'known_product', matchedOn: productId };

  if (productName) {
    // "Empire Brand 2 Expansion Subscription" / "Brand 3 Expansion" — match the
    // brand NUMBER, never the word "expansion" alone (both expansion products
    // contain it, so a bare "expansion" match would file brand 3 under brand 2).
    if (/\bbrand\s*3\b/i.test(productName)) return { slot: 'brand3', source: 'product_name', matchedOn: productName };
    if (/\bbrand\s*2\b/i.test(productName)) return { slot: 'brand2', source: 'product_name', matchedOn: productName };
  }

  return { slot: 'subscription', source: 'default', matchedOn: priceId || productId || productName || null };
}

// ───────────────────────────── Stripe client seam ────────────────────────────

/** The narrow slice of the Stripe API this module actually calls. */
export interface StripeSubscriptionLike {
  id: string;
  status?: string;
  customer?: any;
  metadata?: Record<string, string> | null;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  current_period_end?: number | null;
  current_period_start?: number | null;
  created?: number | null;
  currency?: string | null;
  items?: { data?: Array<any> } | null;
}

export interface StripeCheckoutSessionLike {
  id: string;
  client_reference_id?: string | null;
  subscription?: any;
  customer?: any;
  created?: number | null;
}

export interface StripeBillingApi {
  subscriptions: {
    list(params: Record<string, any>): Promise<{ data: StripeSubscriptionLike[]; has_more?: boolean }>;
    retrieve(id: string, params?: Record<string, any>): Promise<StripeSubscriptionLike>;
    update(id: string, params: Record<string, any>): Promise<StripeSubscriptionLike>;
  };
  checkout: {
    sessions: {
      list(params: Record<string, any>): Promise<{ data: StripeCheckoutSessionLike[]; has_more?: boolean }>;
    };
  };
  /** Optional so a minimal fake is enough; without it brand names fall back to IDs. */
  prices?: {
    list(params: Record<string, any>): Promise<{ data: any[]; has_more?: boolean }>;
  };
  customers?: {
    retrieve(id: string, params?: Record<string, any>): Promise<any>;
  };
}

let realStripe: StripeBillingApi | null = null;
let injectedStripe: StripeBillingApi | null = null;

/** Tests: inject a fake Stripe. Pass `null` to restore the real client. */
export function setStripeApi(api: StripeBillingApi | null): void {
  injectedStripe = api;
  if (api) clearBillingCache();
}

/**
 * Lazily build the real client. Nothing is constructed at import time, so the
 * module (and every test that imports it) works with no STRIPE_SECRET_KEY and
 * never reaches the network until a call is actually made.
 */
function getStripeApi(): StripeBillingApi {
  if (injectedStripe) return injectedStripe;
  if (!realStripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new StripeBillingUnavailableError('STRIPE_SECRET_KEY not configured');
    }
    // Do NOT pin an apiVersion here. A hard-pinned version that the account no
    // longer serves is rejected outright ("Invalid Stripe API version: …") —
    // verified live 2026-10-30 — which would take down every billing call.
    // Default to the version this SDK was built for, overridable by env.
    const apiVersion = String(process.env.STRIPE_API_VERSION || '').trim();
    realStripe = (apiVersion
      ? new Stripe(key, { apiVersion: apiVersion as any })
      : new Stripe(key)) as unknown as StripeBillingApi;
  }
  return realStripe;
}

/** Thrown when we cannot talk to Stripe at all — never reported as a zero. */
export class StripeBillingUnavailableError extends Error {
  code = 'STRIPE_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'StripeBillingUnavailableError';
  }
}

// ──────────────────────────────── normalising ───────────────────────────────

/** Statuses where money is (or is still being collected) and access is live. */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function isLiveStatus(status: string | null | undefined): boolean {
  return !!status && LIVE_STATUSES.has(status);
}

function readUnix(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function toIso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/**
 * Stripe moved `current_period_end` off the Subscription and onto its items
 * (this repo's SDK types already reflect that — the pre-existing tsc errors in
 * stripeService.ts are exactly this). Read the item first, fall back to the
 * legacy top-level field, so both API versions answer correctly.
 */
function readPeriod(sub: StripeSubscriptionLike): { start: number | null; end: number | null } {
  const items = Array.isArray(sub.items?.data) ? sub.items!.data! : [];
  const ends = items.map((i) => readUnix(i?.current_period_end)).filter((n): n is number => n !== null);
  const starts = items.map((i) => readUnix(i?.current_period_start)).filter((n): n is number => n !== null);
  const end = ends.length ? Math.max(...ends) : readUnix(sub.current_period_end);
  const start = starts.length ? Math.min(...starts) : readUnix(sub.current_period_start);
  return { start, end };
}

function readCancelAtPeriodEnd(sub: StripeSubscriptionLike): boolean {
  if (sub.cancel_at_period_end === true) return true;
  // Newer API versions also expose an explicit `cancel_at` timestamp; either one
  // means "will not renew", which is the question the UI actually asks.
  return readUnix(sub.cancel_at) !== null;
}

function readCustomerId(sub: StripeSubscriptionLike): string | null {
  const c = sub.customer;
  if (!c) return null;
  if (typeof c === 'string') return c;
  return typeof c.id === 'string' ? c.id : null;
}

function readCustomerEmail(sub: StripeSubscriptionLike): string | null {
  const c = sub.customer;
  if (!c || typeof c === 'string') return null;
  const email = typeof c.email === 'string' ? c.email.trim() : '';
  return email || null;
}

function firstItem(sub: StripeSubscriptionLike): any | null {
  const items = Array.isArray(sub.items?.data) ? sub.items!.data! : [];
  return items.length ? items[0] : null;
}

function readPriceId(item: any): string | null {
  const p = item?.price;
  if (!p) return null;
  if (typeof p === 'string') return p;
  return typeof p.id === 'string' ? p.id : null;
}

function readProductId(item: any): string | null {
  const p = item?.price?.product ?? item?.plan?.product;
  if (!p) return null;
  if (typeof p === 'string') return p;
  return typeof p.id === 'string' ? p.id : null;
}

function readProductName(item: any): string | null {
  const p = item?.price?.product;
  if (p && typeof p === 'object' && typeof p.name === 'string') return p.name;
  const plan = item?.plan;
  if (plan && typeof plan === 'object' && typeof plan.name === 'string') return plan.name;
  return null;
}

/** One subscription, flattened into exactly what the app needs to answer with. */
export interface NormalizedSubscription {
  id: string;
  status: string;
  live: boolean;
  customerId: string | null;
  customerEmail: string | null;
  /** The app's empire/user id this subscription belongs to, when we can prove it. */
  clientReferenceId: string | null;
  /** How that link was proven — `null` when we could not prove it. */
  linkedBy: 'metadata' | 'checkout_session' | null;
  brandSlot: BrandSlot;
  brandLabel: string;
  brandSource: BrandSlotSource;
  brandMatchedOn: string | null;
  priceId: string | null;
  productId: string | null;
  productName: string | null;
  amount: number | null;
  currency: string | null;
  interval: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Cancelled but access still live until `currentPeriodEnd`. */
  cancelling: boolean;
  created: string | null;
}

function normalizeSubscription(
  sub: StripeSubscriptionLike,
  sessionBySubscription: Map<string, string>,
  priceCatalogue?: Map<string, PriceInfo>,
): NormalizedSubscription {
  const item = firstItem(sub);
  const priceId = readPriceId(item);
  const catalogue = priceId && priceCatalogue ? priceCatalogue.get(priceId) : undefined;
  const productId = readProductId(item) || catalogue?.productId || null;
  // Live, `price.product` is an ID string — the NAME only arrives from the price
  // catalogue read (a deeper expand is rejected by the API), so the name
  // heuristic needs that map to work at all.
  const productName = readProductName(item) || catalogue?.productName || null;
  const brand = resolveBrandSlot({ priceId, productId, productName });
  const period = readPeriod(sub);
  const metaRef =
    sub.metadata?.client_reference_id ||
    sub.metadata?.clientReferenceId ||
    sub.metadata?.userId ||
    null;
  const fromSession = sessionBySubscription.get(sub.id) || null;
  const clientReferenceId = (metaRef || fromSession || null) as string | null;
  const status = String(sub.status || 'unknown');
  const cancelAtPeriodEnd = readCancelAtPeriodEnd(sub);

  return {
    id: sub.id,
    status,
    live: isLiveStatus(status),
    customerId: readCustomerId(sub),
    customerEmail: readCustomerEmail(sub),
    clientReferenceId,
    linkedBy: metaRef ? 'metadata' : fromSession ? 'checkout_session' : null,
    brandSlot: brand.slot,
    brandLabel: BRAND_LABELS[brand.slot],
    brandSource: brand.source,
    brandMatchedOn: brand.matchedOn,
    priceId,
    productId,
    productName,
    amount: typeof item?.price?.unit_amount === 'number' ? item.price.unit_amount : (catalogue?.unitAmount ?? null),
    currency: sub.currency || (typeof item?.price?.currency === 'string' ? item.price.currency : null) || catalogue?.currency || null,
    interval: item?.price?.recurring?.interval || catalogue?.interval || null,
    currentPeriodStart: toIso(period.start),
    currentPeriodEnd: toIso(period.end),
    cancelAtPeriodEnd,
    cancelling: cancelAtPeriodEnd && isLiveStatus(status),
    created: toIso(readUnix(sub.created)),
  };
}

/** A price, flattened — the piece the subscription payload does not carry. */
export interface PriceInfo {
  priceId: string;
  productId: string | null;
  productName: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
}

// ─────────────────────────────── the one read ───────────────────────────────

const DEFAULT_CACHE_MS = 60_000;
const MAX_PAGES = 20;

export interface BillingSnapshot {
  subscriptions: NormalizedSubscription[];
  /** ISO timestamp of the read, so callers can say how fresh the number is. */
  readAt: string;
  /** False when checkout sessions could not be read (email/metadata fallback only). */
  sessionsReadable: boolean;
  /** False when the price catalogue could not be read (brand names fall back to IDs). */
  pricesReadable: boolean;
  truncated: boolean;
}

let cache: { at: number; snapshot: BillingSnapshot } | null = null;

export function clearBillingCache(): void {
  cache = null;
}

function cacheTtlMs(): number {
  const raw = Number(process.env.STRIPE_BILLING_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_MS;
}

async function listAll<T>(
  fetchPage: (params: Record<string, any>) => Promise<{ data: T[]; has_more?: boolean }>,
  params: Record<string, any>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetchPage({ ...params, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    const data = Array.isArray(res?.data) ? res.data : [];
    rows.push(...data);
    if (!res?.has_more || data.length === 0) return { rows, truncated: false };
    const last: any = data[data.length - 1];
    if (!last?.id) return { rows, truncated: false };
    startingAfter = last.id;
  }
  return { rows, truncated: true };
}

/**
 * Read every subscription (and the checkout sessions that carry
 * `client_reference_id`) exactly once, then answer everything from the snapshot.
 *
 * Why both lists: a Payment Link appends `client_reference_id` to the Checkout
 * Session, and that is the only place it is guaranteed to survive — so the
 * session list is what proves which app user paid. `subscriptions.list` is what
 * knows status, period end and cancellation.
 */
export async function readBillingSnapshot(options: { fresh?: boolean } = {}): Promise<BillingSnapshot> {
  if (!options.fresh && cache && Date.now() - cache.at < cacheTtlMs()) {
    return cache.snapshot;
  }

  const api = getStripeApi();

  let subResult: { rows: StripeSubscriptionLike[]; truncated: boolean };
  try {
    // NOTE: only `data.customer` is expanded here. The API refuses deeper paths
    // ("You cannot expand more than 4 levels of a property", verified live
    // 2026-10-30), so the product NAME comes from the price catalogue below.
    subResult = await listAll((params) => api.subscriptions.list(params), {
      status: 'all',
      limit: 100,
      expand: ['data.customer'],
    });
  } catch (error: any) {
    throw new StripeBillingUnavailableError(error?.message || 'Stripe subscriptions list failed');
  }

  const priceCatalogue = new Map<string, PriceInfo>();
  let pricesReadable = false;
  if (api.prices) {
    try {
      const priceResult = await listAll((params) => api.prices!.list(params), {
        limit: 100,
        expand: ['data.product'],
      });
      for (const price of priceResult.rows as any[]) {
        if (!price?.id) continue;
        const product = price.product;
        priceCatalogue.set(String(price.id), {
          priceId: String(price.id),
          productId: typeof product === 'string' ? product : (product?.id ?? null),
          productName: product && typeof product === 'object' && typeof product.name === 'string' ? product.name : null,
          unitAmount: typeof price.unit_amount === 'number' ? price.unit_amount : null,
          currency: typeof price.currency === 'string' ? price.currency : null,
          interval: price.recurring?.interval ?? null,
        });
      }
      pricesReadable = true;
    } catch (error: any) {
      console.warn('[stripeSubscriptions] price catalogue unavailable:', error?.message || error);
    }
  }

  const sessionBySubscription = new Map<string, string>();
  let sessionsReadable = true;
  try {
    const sessionResult = await listAll((params) => api.checkout.sessions.list(params), { limit: 100 });
    for (const session of sessionResult.rows) {
      const subId = typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription && typeof (session.subscription as any).id === 'string' ? (session.subscription as any).id : null);
      const ref = session.client_reference_id ? String(session.client_reference_id) : '';
      if (subId && ref && !sessionBySubscription.has(subId)) sessionBySubscription.set(subId, ref);
    }
  } catch (error: any) {
    // A key without checkout-session read access must not blind the whole
    // endpoint: metadata + email still resolve most clients. Say so in the snapshot.
    sessionsReadable = false;
    console.warn('[stripeSubscriptions] checkout sessions unavailable:', error?.message || error);
  }

  const subscriptions = subResult.rows.map((sub) => normalizeSubscription(sub, sessionBySubscription, priceCatalogue));

  const snapshot: BillingSnapshot = {
    subscriptions,
    readAt: new Date().toISOString(),
    sessionsReadable,
    pricesReadable,
    truncated: subResult.truncated,
  };
  cache = { at: Date.now(), snapshot };
  return snapshot;
}

// ───────────────────────────── client resolution ────────────────────────────

/**
 * Canonical mailbox key. Reuses the owner helper's normalisation rather than
 * duplicating it: Gmail/Googlemail ignore dots and case, so
 * `Staci.Peabody@gmail.com`, `stacipeabody@gmail.com` and
 * `stacipeabody@googlemail.com` are one mailbox. Non-Gmail is lowercased only.
 */
export function normalizeBillingEmail(email: string | null | undefined): string {
  return normalizeOwnerEmail(String(email || ''));
}

export interface ClientIdentity {
  userId: string;
  email?: string | null;
}

export type ClientMatch = 'client_reference_id' | 'email';

export interface ResolvedClientSubscription {
  subscription: NormalizedSubscription;
  matchedBy: ClientMatch;
}

/**
 * Every subscription we can prove belongs to this client, newest first.
 *
 * Order of proof:
 *   1. `client_reference_id` — on the subscription metadata, or on the Checkout
 *      Session that created it (Payment Link query param, no Stripe-side change).
 *   2. the Stripe customer's email against the app user's email, normalised.
 * A subscription that matches neither is NOT attributed — we would rather say
 * "we cannot see a subscription" than show a stranger's renewal date.
 */
export function matchClientSubscriptions(
  snapshot: BillingSnapshot,
  identity: ClientIdentity,
): ResolvedClientSubscription[] {
  const userId = String(identity.userId || '').trim();
  const emailKey = normalizeBillingEmail(identity.email || '');
  const matches: ResolvedClientSubscription[] = [];

  for (const sub of snapshot.subscriptions) {
    if (userId && sub.clientReferenceId && sub.clientReferenceId === userId) {
      matches.push({ subscription: sub, matchedBy: 'client_reference_id' });
      continue;
    }
    if (emailKey && sub.customerEmail && normalizeBillingEmail(sub.customerEmail) === emailKey) {
      matches.push({ subscription: sub, matchedBy: 'email' });
    }
  }

  // Newest first; live before dead when two share a timestamp.
  matches.sort((a, b) => {
    if (a.subscription.live !== b.subscription.live) return a.subscription.live ? -1 : 1;
    return String(b.subscription.created || '').localeCompare(String(a.subscription.created || ''));
  });
  return matches;
}

// ───────────────────────────── client-facing view ───────────────────────────

export interface ClientBillingSubscription {
  subscriptionId: string;
  brandSlot: BrandSlot;
  brandLabel: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  amount: number | null;
  currency: string | null;
  interval: string | null;
  productName: string | null;
}

export interface ClientBillingView {
  linked: boolean;
  /** Present when `linked: false` — why we cannot see a subscription. */
  reason?: 'no_subscription' | 'stripe_unavailable';
  message?: string;
  /** The primary (base) plan. Absent unless `linked`. */
  plan?: {
    subscriptionId: string;
    brandSlot: BrandSlot;
    brandLabel: string;
    productName: string | null;
    amount: number | null;
    currency: string | null;
    interval: string | null;
  };
  status?: string;
  /** Real Stripe period end (ISO). NEVER a computed "paidAt + 30 days". */
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  /** Same instant as `currentPeriodEnd` — named for the UI's "active until …". */
  activeUntil?: string | null;
  /** True while the client is still inside a paid period after cancelling. */
  stillActive?: boolean;
  matchedBy?: ClientMatch;
  /** Every brand slot this client holds (base + expansions). */
  brands?: BrandSlot[];
  subscriptions?: ClientBillingSubscription[];
  readAt?: string;
}

function toClientSubscription(sub: NormalizedSubscription): ClientBillingSubscription {
  return {
    subscriptionId: sub.id,
    brandSlot: sub.brandSlot,
    brandLabel: sub.brandLabel,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    amount: sub.amount,
    currency: sub.currency,
    interval: sub.interval,
    productName: sub.productName,
  };
}

function pickPrimary(matches: ResolvedClientSubscription[]): ResolvedClientSubscription | null {
  if (!matches.length) return null;
  const live = matches.filter((m) => m.subscription.live);
  const pool = live.length ? live : matches;
  // Base plan wins, otherwise the oldest (the one they started on).
  const base = pool.find((m) => m.subscription.brandSlot === 'subscription');
  if (base) return base;
  return [...pool].sort((a, b) => String(a.subscription.created || '').localeCompare(String(b.subscription.created || '')))[0];
}

/** GET /api/billing/me — the signed-in client's real plan, or an honest `linked: false`. */
export async function getClientBillingView(identity: ClientIdentity): Promise<ClientBillingView> {
  let snapshot: BillingSnapshot;
  try {
    snapshot = await readBillingSnapshot();
  } catch (error: any) {
    return {
      linked: false,
      reason: 'stripe_unavailable',
      message: 'Billing is temporarily unavailable. Your plan has not changed.',
    };
  }

  const matches = matchClientSubscriptions(snapshot, identity);
  if (!matches.length) {
    return {
      linked: false,
      reason: 'no_subscription',
      message: 'No Stripe subscription is linked to this account yet.',
      readAt: snapshot.readAt,
    };
  }

  const primary = pickPrimary(matches)!;
  const sub = primary.subscription;
  const brands = Array.from(new Set(matches.map((m) => m.subscription.brandSlot)));

  return {
    linked: true,
    plan: {
      subscriptionId: sub.id,
      brandSlot: sub.brandSlot,
      brandLabel: sub.brandLabel,
      productName: sub.productName,
      amount: sub.amount,
      currency: sub.currency,
      interval: sub.interval,
    },
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    activeUntil: sub.currentPeriodEnd,
    stillActive: sub.live,
    matchedBy: primary.matchedBy,
    brands,
    subscriptions: matches.map((m) => toClientSubscription(m.subscription)),
    readAt: snapshot.readAt,
  };
}

// ─────────────────────────────── owner numbers ──────────────────────────────

export interface OwnerBillingStats {
  /** Distinct clients with at least one live subscription (owner excluded). */
  payingClients: number;
  /** Distinct clients per brand slot. A client on two brands counts in both. */
  payingClientsByBrand: Record<BrandSlot, number>;
  /** Cancelled-but-still-active: `cancel_at_period_end` and still inside the paid period. */
  cancellingClients: number;
  /** Live subscription objects per slot (a client may hold more than one). */
  subscriptionsByBrand: Record<BrandSlot, number>;
  /** Every subscription Stripe returned, live or not — for "is the read real?" checks. */
  totalSubscriptions: number;
  readAt: string;
  sessionsReadable: boolean;
  pricesReadable: boolean;
  truncated: boolean;
}

/** Identity key for counting distinct clients without double counting. */
function clientKey(sub: NormalizedSubscription): string {
  if (sub.clientReferenceId) return `ref:${sub.clientReferenceId}`;
  if (sub.customerId) return `cus:${sub.customerId}`;
  if (sub.customerEmail) return `mail:${normalizeBillingEmail(sub.customerEmail)}`;
  return `sub:${sub.id}`;
}

/** The owner is never a client of her own product — even if she test-bought. */
function isOwnerSubscription(sub: NormalizedSubscription): boolean {
  if (sub.clientReferenceId && sub.clientReferenceId.toLowerCase() === OWNER_USER_ID) return true;
  return isOwnerIdentity({ id: sub.clientReferenceId, email: sub.customerEmail });
}

/**
 * Owner-only aggregates. Pure over a snapshot so the counting rules are testable
 * without any network call, and so a failure upstream can never be reported as 0.
 */
export function aggregateOwnerStats(snapshot: BillingSnapshot): OwnerBillingStats {
  const paying = new Set<string>();
  const perBrand: Record<BrandSlot, Set<string>> = {
    subscription: new Set(),
    brand2: new Set(),
    brand3: new Set(),
  };
  const subsPerBrand: Record<BrandSlot, number> = { subscription: 0, brand2: 0, brand3: 0 };
  const cancelling = new Set<string>();

  for (const sub of snapshot.subscriptions) {
    if (!sub.live) continue;
    if (isOwnerSubscription(sub)) continue;
    const key = clientKey(sub);
    paying.add(key);
    perBrand[sub.brandSlot].add(key);
    subsPerBrand[sub.brandSlot] += 1;
    if (sub.cancelling) cancelling.add(key);
  }

  return {
    payingClients: paying.size,
    payingClientsByBrand: {
      subscription: perBrand.subscription.size,
      brand2: perBrand.brand2.size,
      brand3: perBrand.brand3.size,
    },
    cancellingClients: cancelling.size,
    subscriptionsByBrand: subsPerBrand,
    totalSubscriptions: snapshot.subscriptions.length,
    readAt: snapshot.readAt,
    sessionsReadable: snapshot.sessionsReadable,
    pricesReadable: snapshot.pricesReadable,
    truncated: snapshot.truncated,
  };
}

/** Read + aggregate in one call. Throws `StripeBillingUnavailableError` on failure. */
export async function getOwnerBillingStats(options: { fresh?: boolean } = {}): Promise<OwnerBillingStats> {
  const snapshot = await readBillingSnapshot(options);
  return aggregateOwnerStats(snapshot);
}

// ──────────────────────────────── the cancel ────────────────────────────────

export interface CancelSuccess {
  ok: true;
  /** True when Stripe already had `cancel_at_period_end` set — same answer, no write. */
  alreadyCancelled: boolean;
  cancelAtPeriodEnd: true;
  /** Latest paid-through instant across the client's live subscriptions. */
  activeUntil: string | null;
  subscriptions: Array<{
    subscriptionId: string;
    brandSlot: BrandSlot;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    alreadyCancelled: boolean;
  }>;
  message: string;
}

export interface CancelFailure {
  ok: false;
  code: 'NO_SUBSCRIPTION' | 'STRIPE_UNAVAILABLE';
  message: string;
}

export type CancelResult = CancelSuccess | CancelFailure;

export const CANCEL_NO_SUBSCRIPTION_MESSAGE =
  'We could not find a Stripe subscription on your account, so there was nothing to cancel. ' +
  'You have not been charged again. If you believe this is wrong, tell us in chat and we will check it by hand.';

/**
 * Cancel at period end — the owner's rule, verbatim: "When a client cancels, they
 * have until the day before their renewal date to continue using the platform."
 *
 * Therefore this function:
 *   • sets ONLY `cancel_at_period_end: true` on Stripe (no invoice, no refund,
 *     no subscription deletion),
 *   • touches NO local access state (no tier, no quota, no lock) — the client
 *     keeps working until the paid period ends,
 *   • is idempotent: a second call returns the same period end and does not
 *     write again,
 *   • returns an explicit failure the frontend can show, never a bare 404.
 */
export async function cancelClientSubscription(identity: ClientIdentity): Promise<CancelResult> {
  let snapshot: BillingSnapshot;
  try {
    // Always a fresh read: cancelling on a stale snapshot could either skip a
    // real cancellation or repeat a write.
    snapshot = await readBillingSnapshot({ fresh: true });
  } catch (error: any) {
    return {
      ok: false,
      code: 'STRIPE_UNAVAILABLE',
      message: 'We could not reach the billing system, so your subscription was NOT cancelled. Please try again in a moment.',
    };
  }

  const matches = matchClientSubscriptions(snapshot, identity);
  const liveMatches = matches.filter((m) => m.subscription.live);
  if (!liveMatches.length) {
    return { ok: false, code: 'NO_SUBSCRIPTION', message: CANCEL_NO_SUBSCRIPTION_MESSAGE };
  }

  const api = getStripeApi();
  const results: CancelSuccess['subscriptions'] = [];
  let wrote = false;

  for (const match of liveMatches) {
    const sub = match.subscription;
    if (sub.cancelAtPeriodEnd) {
      results.push({
        subscriptionId: sub.id,
        brandSlot: sub.brandSlot,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: true,
        alreadyCancelled: true,
      });
      continue;
    }

    let updated: StripeSubscriptionLike;
    try {
      updated = await api.subscriptions.update(sub.id, { cancel_at_period_end: true });
      wrote = true;
    } catch (error: any) {
      // One brand failing must not silently leave the others uncancelled and
      // unmentioned: report what did happen and what did not.
      return {
        ok: false,
        code: 'STRIPE_UNAVAILABLE',
        message: `We could not cancel your ${sub.brandLabel} plan (${error?.message || 'Stripe rejected the request'}). Your subscription was NOT cancelled — nothing else was changed, so please try again.`,
      };
    }

    const normalized = normalizeSubscription(updated, new Map([[sub.id, sub.clientReferenceId || '']]));
    results.push({
      subscriptionId: sub.id,
      brandSlot: sub.brandSlot,
      status: normalized.status,
      currentPeriodEnd: normalized.currentPeriodEnd || sub.currentPeriodEnd,
      cancelAtPeriodEnd: normalized.cancelAtPeriodEnd,
      alreadyCancelled: false,
    });
  }

  // Any write invalidates the cached snapshot so /billing/me reflects it at once.
  if (wrote) clearBillingCache();

  const periodEnds = results
    .map((r) => r.currentPeriodEnd)
    .filter((d): d is string => !!d)
    .sort();
  const activeUntil = periodEnds.length ? periodEnds[periodEnds.length - 1] : null;

  return {
    ok: true,
    alreadyCancelled: !wrote,
    cancelAtPeriodEnd: true,
    activeUntil,
    subscriptions: results,
    message: activeUntil
      ? `Your subscription is cancelled and will not renew. You keep full access until ${activeUntil}.`
      : 'Your subscription is cancelled and will not renew. You keep full access until the end of the period you already paid for.',
  };
}

export const stripeSubscriptions = {
  readBillingSnapshot,
  getClientBillingView,
  getOwnerBillingStats,
  aggregateOwnerStats,
  matchClientSubscriptions,
  cancelClientSubscription,
  clearBillingCache,
  setStripeApi,
  resolveBrandSlot,
  normalizeBillingEmail,
};
