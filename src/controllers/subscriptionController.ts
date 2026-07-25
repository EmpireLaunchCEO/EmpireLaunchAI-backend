import { Request, Response } from 'express';
import { db, schema } from '../db/index.js';
import { stripeService } from '../services/stripeService.js';
import { eq, desc, and, gt } from 'drizzle-orm';

const { subscriptions } = schema;

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
    const { type } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Authentication required' });
    }
    if (!type || !['subscription', 'expansion'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "subscription" or "expansion"' });
    }

    const url = await stripeService.createCheckoutSession(userId, type);
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

    // unpaid, canceled, unknown → block
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
 * POST /api/subscriptions/cancel
 * Cancels Stripe subscription at period end.
 */
export const cancelSubscription = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(400).json({ error: 'Authentication required' });

    const [latest] = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.paidAt))
      .limit(1);

    if (!latest) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    // Find Stripe subscription ID
    let subId = latest.stripeSubscriptionId;
    if (!subId) {
      const status = await stripeService.getSubscriptionStatus(userId);
      subId = status.subscriptionId;
      // Store for future use
      if (subId) {
        await db.update(subscriptions)
          .set({ stripeSubscriptionId: subId })
          .where(eq(subscriptions.id, latest.id));
      }
    }

    if (!subId) {
      return res.status(404).json({ error: 'Could not find Stripe subscription ID' });
    }

    const result = await stripeService.cancelSubscription(subId);

    res.json({
      status: 'canceled',
      activeUntil: result.currentPeriodEnd,
      message: 'Subscription will be canceled at the end of the current billing period.',
    });
  } catch (error: any) {
    console.error('[Subscription] Cancel error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/subscriptions/reactivate
 * Reactivates a subscription set to cancel at period end.
 */
export const reactivateSubscription = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(400).json({ error: 'Authentication required' });

    // First, check Stripe status to determine if the subscription is still revivable
    const stripeStatus = await stripeService.getSubscriptionStatus(userId);

    // Scenario 1: Subscription exists and is still in active period (cancel_at_period_end)
    if (stripeStatus.subscriptionId && stripeStatus.status !== 'canceled' && stripeStatus.status !== 'unpaid') {
      const result = await stripeService.reactivateSubscription(stripeStatus.subscriptionId);
      return res.json({
        status: 'reactivated',
        renewsAt: result.currentPeriodEnd,
        message: 'Subscription reactivated. You will be billed at the end of the current period.',
      });
    }

    // Also check our DB for a stored subscription ID
    const [latest] = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.paidAt))
      .limit(1);

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
        // Reactivation failed — fall through to new checkout
      }
    }

    // Scenario 2: Fully canceled — create new checkout session
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
