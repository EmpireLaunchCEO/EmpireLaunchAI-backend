import { Request, Response } from 'express';
import { db, schema } from '../db/index.js';
import { stripeService } from '../services/stripeService.js';
import { eq, desc } from 'drizzle-orm';

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
