import { Request, Response } from 'express';
import { stripeService } from '../services/stripeService.js';
import { paymentButtonService } from '../services/paymentButtonService.js';
import { protectedButtonService } from '../services/protectedButtonService.js';
import { vaultService } from '../services/vaultService.js';
import { db, schema } from '../db/index.js';
const { users, products, paymentLinks } = schema;
import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export const onboardUser = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    
    let stripeAccountId = await vaultService.getSecret(userId, 'stripe', 'stripe_account_id');

    if (!stripeAccountId) {
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) return res.status(404).json({ error: 'User not found' });
      
      const account = await stripeService.createConnectAccount(user.email);
      stripeAccountId = account.id;
      
      await vaultService.storeSecret(userId, 'stripe', 'stripe_account_id', stripeAccountId);
    }

    const returnUrl = `${process.env.FRONTEND_URL}/stripe/callback?userId=${userId}`;
    const refreshUrl = `${process.env.FRONTEND_URL}/stripe/onboard?userId=${userId}`;

    const accountLink = await stripeService.createAccountLink(stripeAccountId, returnUrl, refreshUrl);

    res.json({ url: accountLink.url });
  } catch (error: any) {
    console.error('Error in onboardUser:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getAccountStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const stripeAccountId = await vaultService.getSecret(userId, 'stripe', 'stripe_account_id');

    if (!stripeAccountId) {
      return res.json({ connected: false });
    }

    const account = await stripeService.getAccount(stripeAccountId);
    res.json({
      connected: account.details_submitted,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
    });
  } catch (error: any) {
    console.error('Error in getAccountStatus:', error);
    res.status(500).json({ error: error.message });
  }
};

export const createPaymentLink = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const { name, description, priceInCents } = req.body;

    const stripeAccountId = await vaultService.getSecret(userId, 'stripe', 'stripe_account_id');
    if (!stripeAccountId) {
      return res.status(400).json({ error: 'User must complete Stripe onboarding first' });
    }

    // 1. Create product and price in user's Connect account
    const { product: stripeProduct, price: stripePrice } = await stripeService.createProductAndPrice(
      stripeAccountId,
      name,
      description,
      priceInCents
    );

    // 2. Save product to local DB
    const productId = uuidv4();
    await db.insert(products).values({
      id: productId,
      userId,
      name,
      description,
      price: priceInCents,
      currency: 'usd',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 3. Create payment link in Stripe
    const stripePaymentLink = await stripeService.createPaymentLink(stripeAccountId, stripePrice.id);

    // 4. Save payment link to local DB
    const paymentLinkId = uuidv4();
    await db.insert(paymentLinks).values({
      id: paymentLinkId,
      productId,
      stripeLinkId: stripePaymentLink.id,
      url: stripePaymentLink.url,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 5. Create default payment button (HOOK)
    await paymentButtonService.createButton(
      userId,
      productId,
      'general',
      { 
        url: stripePaymentLink.url, 
        label: 'Buy Now', 
        color: '#000000', 
        stripeLinkId: stripePaymentLink.id 
      },
      'link'
    );

    res.json({
      productId,
      paymentLinkId,
      url: stripePaymentLink.url
    });
  } catch (error: any) {
    console.error('Error in createPaymentLink:', error);
    res.status(500).json({ error: error.message });
  }
};

export const createPaymentButton = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const { name, description, priceInCents, buttonText, buttonColor } = req.body;

    const stripeAccountId = await vaultService.getSecret(userId, 'stripe', 'stripe_account_id');
    if (!stripeAccountId) {
      return res.status(400).json({ error: 'User must complete Stripe onboarding first' });
    }

    // 1. Create product and price in user's Connect account
    const { product: stripeProduct, price: stripePrice } = await stripeService.createProductAndPrice(
      stripeAccountId,
      name,
      description,
      priceInCents
    );

    // 2. Save product to local DB
    const productId = uuidv4();
    await db.insert(products).values({
      id: productId,
      userId,
      name,
      description,
      price: priceInCents,
      currency: 'usd',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 3. Generate Protected Proxy URL
    const proxyUrl = await protectedButtonService.generateButton(
      userId,
      productId,
      'general'
    );

    res.json({ 
      productId, 
      proxyUrl, 
      buttonText: buttonText || 'Buy Now', 
      buttonColor: buttonColor || '#000000' 
    });
  } catch (error: any) {
    console.error('Error in createPaymentButton:', error);
    res.status(500).json({ error: error.message });
  }
};

export const triggerInstantPayout = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const { amountInCents } = req.body;

    const stripeAccountId = await vaultService.getSecret(userId, 'stripe', 'stripe_account_id');
    if (!stripeAccountId) {
      return res.status(400).json({ error: 'User must complete Stripe onboarding first' });
    }

    const payout = await stripeService.triggerInstantPayout(userId, stripeAccountId, amountInCents);
    res.json(payout);
  } catch (error: any) {
    console.error('Error in triggerInstantPayout:', error);
    res.status(500).json({ error: error.message });
  }
};

export const createPlatformCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const { returnUrl, currency, amountInCents } = req.body;
    if (!userId) return res.status(401).json({ error: 'Auth required' });

    const validCurrencies = ['usd', 'eur', 'gbp', 'jpy', 'cny', 'krw', 'cad', 'aud', 'brl', 'mxn', 'inr'];
    const checkoutCurrency = currency && validCurrencies.includes(currency) ? currency : 'usd';
    const checkoutAmount = typeof amountInCents === 'number' && amountInCents > 0 ? amountInCents : 5000;

    const session = await stripeService.createPlatformCheckoutSession(userId, returnUrl, checkoutCurrency, checkoutAmount);
    res.json({ url: session.url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createExpansionCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const { returnUrl } = req.body;
    if (!userId) return res.status(401).json({ error: 'Auth required' });

    const session = await stripeService.createExpansionCheckoutSession(userId, returnUrl);
    res.json({ url: session.url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const verifyPlatformPayment = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    const session = await stripeService.getSession(sessionId as string);
    if (session.payment_status === 'paid') {
      const userId = session.client_reference_id;
      if (userId) {
        if (session.metadata?.type === 'expansion') {
           // Increment business slots
           await db.update(users).set({ 
             businessSlots: sql`${users.businessSlots} + 1`, 
             updatedAt: new Date() 
           }).where(eq(users.id, userId));
        } else {
           await db.update(users).set({ tier: 'STANDARD_USER', updatedAt: new Date() }).where(eq(users.id, userId));
        }
      }
      return res.json({ status: 'paid' });
    }
    res.json({ status: 'unpaid' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createFinancialConnectionsSession = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const stripeAccountId = await vaultService.getSecret(userId, 'stripe', 'stripe_account_id');

    if (!stripeAccountId) {
      return res.status(400).json({ error: 'User must complete Stripe onboarding first' });
    }

    const session = await stripeService.createFinancialConnectionsSession(stripeAccountId, userId);
    res.json({ client_secret: session.client_secret });
  } catch (error: any) {
    console.error('Error in createFinancialConnectionsSession:', error);
    res.status(500).json({ error: error.message });
  }
};
