/**
 * POST /api/webhooks/stripe — Stripe calls THIS, not a user.
 *
 * Three rules this handler exists to keep:
 *   1. The signature is checked against the exact raw bytes Stripe signed, so the
 *      route is mounted with express.raw() BEFORE the global express.json().
 *   2. A bad/missing signature is a 400 and nothing is written.
 *   3. A missing STRIPE_WEBHOOK_SECRET is a readable 503 naming the variable —
 *      never a crash, never a 500 with a stack.
 *
 * It answers 200 for anything it verified but could not fully apply (Stripe would
 * otherwise retry forever), and 200 for event types it does not handle.
 */
import type { Request, Response } from 'express';
import {
  STRIPE_WEBHOOK_SECRET_ENV,
  STRIPE_WEBHOOK_SECRET_MISSING_MESSAGE,
  handleStripeEvent,
  verifyStripeSignature,
} from '../services/stripeWebhookService.js';

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const secret = String(process.env[STRIPE_WEBHOOK_SECRET_ENV] || '').trim();
  if (!secret) {
    console.error(`[StripeWebhook] ${STRIPE_WEBHOOK_SECRET_ENV} is not set — cannot verify any delivery.`);
    res.status(503).json({ error: STRIPE_WEBHOOK_SECRET_MISSING_MESSAGE, configured: false });
    return;
  }

  const verified = verifyStripeSignature(
    req.body as Buffer | string | undefined,
    req.headers['stripe-signature'],
    secret,
  );
  if (!verified.ok) {
    console.error(`[StripeWebhook] rejected: ${verified.message}`);
    res.status(verified.status).json({ error: verified.message });
    return;
  }

  const event = verified.event;
  try {
    const outcome = await handleStripeEvent(event);
    // Always 200 once the signature is good: an event we could not apply is
    // logged and recorded, not bounced back at Stripe to retry forever.
    res.status(200).json({ received: true, status: outcome.status, reason: outcome.reason });
  } catch (error: any) {
    console.error(`[StripeWebhook] unhandled failure on event ${event?.id}: ${error?.message || error}`);
    res.status(200).json({ received: true, status: 'failed', reason: 'logged' });
  }
}

export default handleStripeWebhook;
