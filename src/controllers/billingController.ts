import { Request, Response } from 'express';
import {
  BRAND_SLOTS,
  CANCEL_BRAND_SLOT_REQUIRED_MESSAGE,
  cancelClientSubscription,
  getClientBillingView,
  parseBrandSlot,
  type BrandSlot,
} from '../services/stripeSubscriptions.js';

/**
 * Client-facing billing endpoints.
 *
 *   GET  /api/billing/me      — the signed-in client's real plan / renewal date
 *   POST /api/billing/cancel  — cancel at period end (never revokes access)
 *
 * Both are served by `services/stripeSubscriptions.ts`; these handlers only turn
 * its answer into an HTTP shape. Identity comes from `mobileAuth`, which sets
 * `req.userId` and `req.user` (the latter carries the email used for the
 * Stripe-customer email fallback).
 */

function clientIdentity(req: Request): { userId: string; email: string | null } {
  const userId = String((req as any).userId || '').trim();
  const email = (req as any).user?.email ?? null;
  return { userId, email };
}

/**
 * Which brand the caller wants to cancel, exactly as they sent it.
 *
 * The canonical shape is the one `GET /api/billing/me` returns and the Settings
 * card already knows — `brandSlot: 'subscription' | 'brand2' | 'brand3'` — so a
 * body of `{ "brandSlot": "brand2" }` is the expected call. A query string or an
 * `x-brand-slot` header is accepted too (same value), because the identifier is
 * the same identifier however it travels.
 *
 * NOTHING here defaults to a slot. A missing or unrecognised value is a 400: the
 * defect this replaces was the endpoint silently cancelling every brand on the
 * account when the caller only meant one.
 */
function requestedBrandSlot(req: Request): unknown {
  const body: any = (req as any).body ?? {};
  const query: any = (req as any).query ?? {};
  const headers: any = (req as any).headers ?? {};
  return (
    body.brandSlot ??
    body.brand_slot ??
    body.brand ??
    query.brandSlot ??
    query.brand_slot ??
    query.brand ??
    headers['x-brand-slot'] ??
    headers['x-brand'] ??
    null
  );
}

/**
 * GET /api/billing/me
 *
 * Never invents a plan or a date. When the client cannot be tied to a Stripe
 * subscription the body is `{ linked: false, reason, message }` — the UI shows
 * "not linked", not a made-up renewal date (which is exactly the defect the
 * Settings card has today with its hard-coded "+30 days").
 */
export const getMyBilling = async (req: Request, res: Response) => {
  try {
    const identity = clientIdentity(req);
    if (!identity.userId) {
      return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    }
    const view = await getClientBillingView(identity);
    return res.json(view);
  } catch (error: any) {
    console.error('[billing] GET /billing/me failed:', error);
    // A failure is not a plan: say so, and let the client render "—".
    return res.status(503).json({
      linked: false,
      reason: 'stripe_unavailable',
      message: 'Billing is temporarily unavailable. Your plan has not changed.',
      error: 'Billing lookup failed',
    });
  }
};

/**
 * POST /api/billing/cancel — also mounted at POST /api/subscriptions/cancel.
 *
 * Owner rule: cancel = END OF PERIOD. "When a client cancels, they have until the
 * day before their renewal date to continue using the platform." So this sets
 * `cancel_at_period_end` and touches nothing else: no quota, no tier, no lock.
 *
 * Cancels ONE brand: the caller names the slot (`brandSlot: 'brand2'`) and only
 * that slot's live subscription is touched. Cancelling Brand 2 leaves the base
 * Subscription and Brand 3 exactly as they were.
 *
 * Status codes the frontend can act on (never a silent 404):
 *   200 — that brand is cancelled (or already cancelling; identical body)
 *   400 BRAND_SLOT_REQUIRED — no recognisable brand slot; NOTHING was cancelled
 *   409 NO_SUBSCRIPTION    — that brand has no live subscription; show `message`
 *   503 STRIPE_UNAVAILABLE — Stripe rejected/unreachable; NOT cancelled; show `message`
 */
export const cancelMyBilling = async (req: Request, res: Response) => {
  try {
    const identity = clientIdentity(req);
    if (!identity.userId) {
      return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    }

    // The brand slot is REQUIRED. Without it we would be back to guessing, and
    // guessing is what cancelled all three brands from one button.
    const rawSlot = requestedBrandSlot(req);
    const brandSlot: BrandSlot | null = parseBrandSlot(rawSlot);
    if (!brandSlot) {
      return res.status(400).json({
        status: 'not_cancelled',
        cancelled: false,
        code: 'BRAND_SLOT_REQUIRED',
        error: CANCEL_BRAND_SLOT_REQUIRED_MESSAGE,
        message: CANCEL_BRAND_SLOT_REQUIRED_MESSAGE,
        // The values this endpoint accepts, so a client can send the right one.
        accepted: [...BRAND_SLOTS],
        received: rawSlot === null || rawSlot === undefined ? null : String(rawSlot),
      });
    }

    const result = await cancelClientSubscription(identity, { brandSlot });

    if (!result.ok) {
      const status = result.code === 'NO_SUBSCRIPTION'
        ? 409
        : result.code === 'BRAND_SLOT_REQUIRED'
          ? 400
          : 503;
      return res.status(status).json({
        status: 'not_cancelled',
        cancelled: false,
        code: result.code,
        brandSlot,
        error: result.message,
        message: result.message,
      });
    }

    return res.json({
      status: 'canceled',
      cancelled: true,
      // Which brand was cancelled — and, by omission, which were NOT.
      brandSlot: result.brandSlot,
      brandLabel: result.brandLabel,
      alreadyCancelled: result.alreadyCancelled,
      cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      activeUntil: result.activeUntil,
      // Kept for the current Settings card, which reads `activeUntil` only.
      // Now contains ONLY the cancelled brand's subscription.
      subscriptions: result.subscriptions,
      message: result.message,
    });
  } catch (error: any) {
    console.error('[billing] POST /billing/cancel failed:', error);
    return res.status(503).json({
      status: 'not_cancelled',
      cancelled: false,
      code: 'STRIPE_UNAVAILABLE',
      error: 'We could not reach the billing system, so your subscription was NOT cancelled.',
      message: 'We could not reach the billing system, so your subscription was NOT cancelled. Please try again in a moment.',
    });
  }
};
