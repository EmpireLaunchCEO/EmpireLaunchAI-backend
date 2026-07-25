import { Request, Response } from 'express';
import { db, schema } from '../db/index.js';
import { stripeService } from '../services/stripeService.js';
import { eq, desc, and, gt } from 'drizzle-orm';

const { subscriptions } = schema;

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
    const renewsAt = new Date(paidAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const graceEndsAt = new Date(renewsAt.getTime() + 2 * 24 * 60 * 60 * 1000);
    const now = new Date();

    // Still active
    if (now < renewsAt) {
      return res.json({ status: 'active', renewsAt: renewsAt.toISOString(), paidAt: paidAt.toISOString() });
    }

    // Grace period — check Stripe for recent payment
    if (now >= renewsAt && now < graceEndsAt) {
      const payment = await stripeService.verifyUserPayment(userId);
      if (payment.paid && payment.paidAt && new Date(payment.paidAt) > paidAt) {
        await db.update(subscriptions)
          .set({ paidAt: new Date(payment.paidAt), amount: payment.amount ?? latest.amount })
          .where(eq(subscriptions.id, latest.id));
        const newRenewsAt = new Date(new Date(payment.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
        return res.json({ status: 'active', renewsAt: newRenewsAt.toISOString(), paidAt: payment.paidAt });
      }
      return res.json({
        status: 'grace_period',
        renewsAt: renewsAt.toISOString(),
        graceEndsAt: graceEndsAt.toISOString(),
        message: 'Payment processing. 2-day grace period.',
      });
    }

    // Past due
    return res.json({
      status: 'past_due',
      renewsAt: renewsAt.toISOString(),
      message: 'Payment failed. Please update payment method.',
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

    const payment = await stripeService.verifyUserPayment(userId);
    if (payment.paid && payment.paidAt) {
      const [latest] = await db.select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .orderBy(desc(subscriptions.paidAt))
        .limit(1);
      if (latest && new Date(payment.paidAt) > new Date(latest.paidAt!)) {
        await db.update(subscriptions)
          .set({ paidAt: new Date(payment.paidAt), amount: payment.amount ?? latest.amount })
          .where(eq(subscriptions.id, latest.id));
      }
      return res.json({ status: 'paid', paidAt: payment.paidAt, amount: payment.amount });
    }
    res.json({ status: 'pending' });
  } catch (error: any) {
    console.error('[Subscription] Poll error:', error);
    res.status(500).json({ error: error.message });
  }
};
