import { Request, Response } from 'express';
import {
  cancelClientSubscription,
  getClientBillingView,
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
 * Status codes the frontend can act on (never a silent 404):
 *   200 — cancelled (or already cancelling; identical body)
 *   409 NO_SUBSCRIPTION    — we cannot see a subscription to cancel; show `message`
 *   503 STRIPE_UNAVAILABLE — Stripe rejected/unreachable; NOT cancelled; show `message`
 */
export const cancelMyBilling = async (req: Request, res: Response) => {
  try {
    const identity = clientIdentity(req);
    if (!identity.userId) {
      return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    }

    const result = await cancelClientSubscription(identity);

    if (!result.ok) {
      const status = result.code === 'NO_SUBSCRIPTION' ? 409 : 503;
      return res.status(status).json({
        status: 'not_cancelled',
        cancelled: false,
        code: result.code,
        error: result.message,
        message: result.message,
      });
    }

    return res.json({
      status: 'canceled',
      cancelled: true,
      alreadyCancelled: result.alreadyCancelled,
      cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      activeUntil: result.activeUntil,
      // Kept for the current Settings card, which reads `activeUntil` only.
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
