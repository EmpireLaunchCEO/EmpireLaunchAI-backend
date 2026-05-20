import { Request, Response } from 'express';
import { stripeService } from '../services/stripeService.js';
import { db, schema } from '../db/index.js';
const { users, products, paymentLinks } = schema;
import { eq } from 'drizzle-orm';
import { gmailService } from '../services/gmailService.js';

export const handleWebhook = async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  const event = req.body; // In real app, use stripe.webhooks.constructEvent

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const userId = session.metadata?.userId;
    const productName = session.metadata?.productName || 'your purchase';

    if (customerEmail && userId) {
      console.log(`Stripe Webhook: Triggering thank you email for ${customerEmail}`);
      await gmailService.sendThankYouEmail(userId, customerEmail, productName);
    }
  }

  res.json({ received: true });
};

export const onboarding = async (req: Request, res: Response) => {
  const { userId, email } = req.body;

  try {
    // @ts-ignore
    let user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    let stripeAccountId = user?.stripeAccountId;

    if (!stripeAccountId) {
      const account = await stripeService.createConnectAccount(email);
      stripeAccountId = account.id;

      // @ts-ignore
      await db.update(users)
        .set({ stripeAccountId, updatedAt: new Date() })
        .where(eq(users.id, userId));
    }

    const accountLink = await stripeService.createAccountLink(
      stripeAccountId,
      `${process.env.FRONTEND_URL}/dashboard?stripe=success`,
      `${process.env.FRONTEND_URL}/dashboard?stripe=refresh`
    );

    res.json({ url: accountLink.url });
  } catch (error: any) {
    console.error('Stripe onboarding error:', error);
    res.status(500).json({ error: error.message });
  }
};

export const createProductLink = async (req: Request, res: Response) => {
  const { userId, name, description, price } = req.body; // price in dollars

  try {
    // @ts-ignore
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user || !user.stripeAccountId) {
      return res.status(400).json({ error: 'User not onboarded with Stripe' });
    }

    const priceInCents = Math.round(price * 100);

    const { product, price: stripePrice } = await stripeService.createProductAndPrice(
      user.stripeAccountId,
      name,
      description,
      priceInCents
    );

    const paymentLink = await stripeService.createPaymentLink(
      user.stripeAccountId,
      stripePrice.id
    );

    // Save to DB
    // @ts-ignore
    const [dbProduct] = await db.insert(products).values({
      userId,
      name,
      description,
      price: priceInCents,
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    // @ts-ignore
    await db.insert(paymentLinks).values({
      productId: dbProduct.id,
      stripeLinkId: paymentLink.id,
      url: paymentLink.url,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ url: paymentLink.url });
  } catch (error: any) {
    console.error('Create product link error:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getStripeStatus = async (req: Request, res: Response) => {
  const { userId } = req.params;

  try {
    // @ts-ignore
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId as string),
    });

    if (!user || !user.stripeAccountId) {
      return res.json({ onboarded: false });
    }

    const account = await stripeService.getAccount(user.stripeAccountId);
    res.json({
      onboarded: account.details_submitted,
      charges_enabled: account.charges_enabled,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
