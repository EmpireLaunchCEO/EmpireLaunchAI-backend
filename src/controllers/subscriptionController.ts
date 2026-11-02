import { Request, Response } from 'express';
import { db, schema } from '../db/index.js';
import { stripeService } from '../services/stripeService.js';
import { cancelMyBilling } from './billingController.js';
import { findLiveClientSubscription } from '../services/stripeSubscriptions.js';
import { eq, desc } from 'drizzle-orm';

const { subscriptions, users } = schema;

/** Calendar month math — matches Stripe's interval: 'month' billing cycle */
function addCalendarMonth(date: Date): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + 1);
  return result;
}

/**
 * POST /api/stripe/verify-subscription
 * Verifies a user's payment status via Stripe API and records the result.
 */
export const verifySubscription = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { type } = req.body; // 'subscription' | 'expansion'

    if (!userId) {
      return res.status(400).json({ error: 'Authentication required' });
    }

    // Verify payment with Stripe
    const payment = await stripeService.verifyUserPayment(userId);

    if (payment.paid) {
      // Check if subscription already recorded to avoid duplicates
      const [existing] = await db.select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .limit(1);

      if (!existing) {
        await db.insert(subscriptions).values({
          userId,
          type: type || 'subscription',
          amount: payment.amount,
          paidAt: new Date(payment.paidAt!),
          createdAt: new Date(),
        });
      }
    }

    res.json({
      status: 'success',
      verified: payment.paid,
      paidAt: payment.paidAt,
      amount: payment.amount,
    });
  } catch (error: any) {
    console.error('[Subscription] Verification error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/subscriptions/:userId
 * Returns all subscriptions for a user.
 */
export const getUserSubscriptions = async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const userSubscriptions = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt));

    res.json({
      status: 'success',
      subscriptions: userSubscriptions,
      count: userSubscriptions.length,
    });
  } catch (error: any) {
    console.error('[Subscription] Fetch error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/stripe/create-checkout-session
 * Creates a dynamic Stripe Checkout Session tagged with the user's ID.
 */
export const createCheckoutSession = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { type, clientName, referral } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Authentication required' });
    }
    if (!type || !['subscription', 'expansion'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "subscription" or "expansion"' });
    }

    const url = await stripeService.createCheckoutSession(userId, type, { clientName, referral });
    res.json({ url });
  } catch (error: any) {
    console.error('[Subscription] Checkout session error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/subscriptions/check-renewal
 * Checks subscription status and triggers Stripe re-verification if expired.
 */
export const checkRenewal = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(400).json({ error: 'Authentication required' });

    // Admin bypass
    if (userId === '00000000-0000-0000-0000-000000000000') {
      return res.json({ status: 'active', renewsAt: null, message: 'Admin — bypassing payment check' });
    }

    // Find latest subscription
    const [latest] = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.paidAt))
      .limit(1);

    if (!latest) {
      return res.json({ status: 'never_paid', message: 'No subscription record found' });
    }

    const paidAt = new Date(latest.paidAt!);
    const renewsAt = addCalendarMonth(paidAt);
    const now = new Date();

    // Still active
    if (now < renewsAt) {
      return res.json({ status: 'active', renewsAt: renewsAt.toISOString(), paidAt: paidAt.toISOString() });
    }

    // Past renewal — check Stripe's actual subscription status
    const stripeStatus = await stripeService.getSubscriptionStatus(userId);

    if (stripeStatus.status === 'active') {
      // Stripe says active — update our record
      if (stripeStatus.currentPeriodStart) {
        await db.update(subscriptions)
          .set({ paidAt: new Date(stripeStatus.currentPeriodStart) })
          .where(eq(subscriptions.id, latest.id));
      }
      return res.json({
        status: 'active',
        renewsAt: stripeStatus.currentPeriodEnd || renewsAt.toISOString(),
        paidAt: stripeStatus.currentPeriodStart || paidAt.toISOString(),
      });
    }

    if (stripeStatus.status === 'past_due' || stripeStatus.status === 'incomplete') {
      return res.json({
        status: 'grace_period',
        renewsAt: renewsAt.toISOString(),
        stripeStatus: stripeStatus.status,
        message: 'Payment processing. Waiting for Stripe to retry.',
      });
    }

    // unpaid, canceled, unknown → check 30-day retention before blocking
    if (latest.canceledAt) {
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      if (new Date().getTime() - new Date(latest.canceledAt).getTime() > thirtyDaysMs) {
        return res.json({
          status: 'expired',
          message: 'Your data retention period has expired. Please sign up again.',
        });
      }
    }

    return res.json({
      status: 'past_due',
      renewsAt: renewsAt.toISOString(),
      message: 'Payment failed. Please update your payment method.',
    });
  } catch (error: any) {
    console.error('[Subscription] Renewal check error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/subscriptions/poll-renewal
 * Lightweight poll for dashboard during grace period to check Stripe for new payment.
 */
export const pollRenewal = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(400).json({ error: 'Authentication required' });

    // Admin bypass
    if (userId === '00000000-0000-0000-0000-000000000000') {
      return res.json({ status: 'active', renewsAt: null, message: 'Admin — bypassing payment check' });
    }

    const stripeStatus = await stripeService.getSubscriptionStatus(userId);

    if (stripeStatus.status === 'active') {
      const [latest] = await db.select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .orderBy(desc(subscriptions.paidAt))
        .limit(1);
      if (latest && stripeStatus.currentPeriodStart) {
        await db.update(subscriptions)
          .set({ paidAt: new Date(stripeStatus.currentPeriodStart) })
          .where(eq(subscriptions.id, latest.id));
      }
      return res.json({ status: 'active', renewsAt: stripeStatus.currentPeriodEnd });
    }

    if (stripeStatus.status === 'past_due' || stripeStatus.status === 'incomplete') {
      return res.json({ status: 'pending', stripeStatus: stripeStatus.status });
    }

    res.json({ status: 'failed', stripeStatus: stripeStatus.status });
  } catch (error: any) {
    console.error('[Subscription] Poll error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/subscriptions/cancel — kept for the Settings card, which already
 * calls this path. Delegates to the real cancel in controllers/billingController
 * (services/stripeSubscriptions.ts): resolve the Stripe subscription by
 * `client_reference_id`/email, set `cancel_at_period_end: true`, keep access
 * until the paid period ends, and return a visible error instead of the old
 * bare 404 that the frontend silently swallowed while Stripe kept billing.
 */
export const cancelSubscription = cancelMyBilling;

/**
 * The ONE local read the reactivate handler needs: the newest `subscriptions` row
 * for this user (it carries `stripeSubscriptionId` and `canceledAt`).
 *
 * It is a small seam rather than an inline query for two reasons:
 *   • the row is a HINT, not the truth. Stripe is asked either way, so a failed or
 *     unavailable read must not turn into a 500 (and must certainly not turn into
 *     "pay again") — it degrades to `null` and the Stripe-first lookup decides;
 *   • it makes the "DB row present" case testable without a database.
 */
export const subscriptionRows = {
  async latest(userId: string): Promise<{ stripeSubscriptionId?: string | null; canceledAt?: Date | null } | null> {
    try {
      const [row] = await db.select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .orderBy(desc(subscriptions.paidAt))
        .limit(1);
      return (row as any) ?? null;
    } catch (error: any) {
      console.warn('[Subscription] subscriptions row unavailable:', error?.message || error);
      return null;
    }
  },
};

/**
 * What we say when Stripe cannot be asked. Deliberately NOT a checkout: "we could
 * not check" is not "you owe us money again".
 */
const STRIPE_UNREACHABLE_BODY = {
  status: 'error',
  code: 'STRIPE_UNAVAILABLE',
  error: 'We could not reach the billing system, so nothing was changed.',
  message:
    'We could not reach the billing system, so nothing was changed — your plan is untouched and you have NOT been asked to pay again. Please try again in a moment.',
};

/**
 * The email that identifies this client in Stripe.
 *
 * `mobileAuth` sets `req.user` to the full user row when a session token resolves,
 * but only `{ id, mobileSessionToken }` on the auto-provisioned path — so the
 * email is re-read from the database when it is missing. Auto-provisioned users
 * get a `<uuid>@user.empirelaunch.ai` placeholder, which is not a real mailbox
 * and must never be used to match money.
 */
async function resolveClientEmail(req: Request, userId: string): Promise<string | null> {
  const fromAuth = String((req as any).user?.email || '').trim();
  if (fromAuth && !fromAuth.endsWith('@user.empirelaunch.ai')) return fromAuth;
  try {
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const email = String((row as any)?.email || '').trim();
    if (email && !email.endsWith('@user.empirelaunch.ai')) return email;
  } catch (error: any) {
    // A missing email only narrows the search; it must not fail the request.
    console.warn('[Subscription] could not read client email:', error?.message || error);
  }
  return null;
}

/**
 * POST /api/subscriptions/reactivate
 * Reactivates a subscription set to cancel at period end.
 */
export const reactivateSubscription = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(400).json({ error: 'Authentication required' });

    // First, check if canceled and past 30-day retention
    const latest = await subscriptionRows.latest(userId);

    if (latest?.canceledAt) {
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      if (new Date().getTime() - new Date(latest.canceledAt).getTime() > thirtyDaysMs) {
        return res.json({
          status: 'expired',
          message: 'Your data retention period has expired. Please sign up again.',
        });
      }
    }

    const clientEmail = await resolveClientEmail(req, userId);

    // Check Stripe status to determine if the subscription is still revivable
    let stripeStatus: Awaited<ReturnType<typeof stripeService.getSubscriptionStatus>> | null = null;
    try {
      stripeStatus = await stripeService.getSubscriptionStatus(userId);
    } catch (error: any) {
      // We could not ask Stripe, so we do not know whether a paid period is still
      // running. Answering "pay again" on that uncertainty is how a client gets
      // charged twice.
      console.error('[Subscription] Reactivate status check failed:', error?.message || error);
      return res.status(503).json(STRIPE_UNREACHABLE_BODY);
    }

    // Scenario 1: Subscription exists and is still in active period (cancel_at_period_end)
    if (stripeStatus.subscriptionId && stripeStatus.status !== 'canceled' && stripeStatus.status !== 'unpaid') {
      const result = await stripeService.reactivateSubscription(stripeStatus.subscriptionId);
      return res.json({
        status: 'reactivated',
        renewsAt: result.currentPeriodEnd,
        message: 'Subscription reactivated. You will be billed at the end of the current period.',
      });
    }

    // Try reactivating from DB record if it has a subscription ID
    if (latest?.stripeSubscriptionId) {
      try {
        const result = await stripeService.reactivateSubscription(latest.stripeSubscriptionId);
        return res.json({
          status: 'reactivated',
          renewsAt: result.currentPeriodEnd,
          message: 'Subscription reactivated. You will be billed at the end of the current period.',
        });
      } catch {
        // Reactivation failed — do NOT go to a checkout yet: Stripe may still hold
        // a live subscription we simply have no row for. Ask Stripe below.
      }
    }

    // ── Stripe first, before any checkout is ever offered ────────────────────
    // A Payment Link buyer has no `subscriptions` row, so both paths above can
    // miss a subscription Stripe is still collecting for. Offering a checkout in
    // that case asks them to pay AGAIN for a period they already paid for.
    // `findLiveClientSubscription` answers from Stripe itself (client_reference_id,
    // known customer id, then the customer directory by email) and returns `null`
    // ONLY when Stripe had nothing active/trialing/past_due.
    let live: Awaited<ReturnType<typeof findLiveClientSubscription>> = null;
    try {
      live = await findLiveClientSubscription({ userId, email: clientEmail });
    } catch (error: any) {
      console.error('[Subscription] Reactivate Stripe lookup failed:', error?.message || error);
      return res.status(503).json(STRIPE_UNREACHABLE_BODY);
    }

    if (live) {
      let renewsAt = live.subscription.currentPeriodEnd;
      try {
        const result = await stripeService.reactivateSubscription(live.subscription.id);
        renewsAt = result.currentPeriodEnd || renewsAt;
      } catch (error: any) {
        // A live subscription exists and we could not flip it back on. A checkout
        // here would charge them twice, so say what happened instead.
        console.error('[Subscription] Reactivate on the Stripe subscription failed:', error?.message || error);
        return res.status(503).json({
          status: 'error',
          code: 'STRIPE_UNAVAILABLE',
          subscriptionId: live.subscription.id,
          error: 'We found your paid plan but could not switch the renewal back on.',
          message:
            'We found your paid plan but could not switch the renewal back on, so nothing was changed and you have NOT been asked to pay again. Please try again in a moment.',
        });
      }
      return res.json({
        status: 'reactivated',
        renewsAt,
        subscriptionId: live.subscription.id,
        brandSlot: live.subscription.brandSlot,
        matchedBy: live.matchedBy,
        message: 'Subscription reactivated. You will be billed at the end of the current period.',
      });
    }

    // Scenario 2: Stripe itself confirms nothing is live — a new checkout is the
    // only honest answer left.
    const checkoutUrl = await stripeService.createCheckoutSession(userId, 'subscription');
    return res.json({
      status: 'requires_payment',
      checkoutUrl,
      message: 'Your previous subscription has ended. Please start a new subscription.',
    });
  } catch (error: any) {
    console.error('[Subscription] Reactivate error:', error);
    res.status(500).json({ error: error.message });
  }
};
