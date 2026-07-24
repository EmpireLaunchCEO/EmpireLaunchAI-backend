import Stripe from 'stripe';
import dotenv from 'dotenv';
import { db, schema } from '../db/index.js';
import { revenueOracle } from './revenueOracle.js';
import { paymentButtonService } from './paymentButtonService.js';
const { paymentButtons } = schema;
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

let stripe: Stripe;
function getStripe(): Stripe {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY not configured. Stripe operations unavailable.');
    }
    stripe = new Stripe(key, {
      apiVersion: '2025-01-27-acacia' as any,
    });
  }
  return stripe;
}

export class StripeService {
  async createConnectAccount(email: string) {
    const account = await getStripe().accounts.create({
      type: 'express',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
    return account;
  }

  async createAccountLink(accountId: string, returnUrl: string, refreshUrl: string) {
    const accountLink = await getStripe().accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
    return accountLink;
  }

  async createProductAndPrice(accountId: string, name: string, description: string, priceInCents: number) {
    const product = await getStripe().products.create({
      name,
      description,
    }, {
      stripeAccount: accountId,
    });

    const price = await getStripe().prices.create({
      unit_amount: priceInCents,
      currency: 'usd',
      product: product.id,
    }, {
      stripeAccount: accountId,
    });

    return { product, price };
  }

  async createPaymentLink(accountId: string, priceId: string) {
    const paymentLink = await getStripe().paymentLinks.create({
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // Enable modern methods explicitly if needed, 
      // though dashboard-controlled is often preferred for AI optimization.
      payment_method_types: ['card', 'venmo', 'cashapp'] as any,
      payment_method_collection: 'always',
    }, {
      stripeAccount: accountId,
    });
    return paymentLink;
  }

  async createPaymentButton(userId: string, accountId: string, productId: string, priceId: string, buttonText: string, buttonColor: string) {
    // 1. Create Payment Link in Stripe
    const paymentLink = await this.createPaymentLink(accountId, priceId);
    // 2. Store Payment Button in DB
    const id = await paymentButtonService.createButton(
      userId,
      productId,
      'general',
      { 
        url: paymentLink.url, 
        label: buttonText, 
        color: buttonColor, 
        stripeLinkId: paymentLink.id 
      },
      'link'
    );
    return { id, url: paymentLink.url, buttonText, buttonColor };
  }

  async getAccount(accountId: string) {
    return await getStripe().accounts.retrieve(accountId);
  }

  /**
   * Triggers an Instant Payout to the user's linked debit card.
   */
  async triggerInstantPayout(userId: string, accountId: string, amountInCents: number) {
    const balance = await getStripe().balance.retrieve({}, { stripeAccount: accountId });
    const totalAvailable = balance.available.reduce((sum, b) => sum + b.amount, 0);

    const withdrawalLimit = await revenueOracle.getWithdrawalLimit(userId, totalAvailable);

    if (amountInCents > withdrawalLimit) {
      throw new Error(`Instant Payout exceeds limit. Available after dues: ${(withdrawalLimit / 100).toFixed(2)}`);
    }

    console.log(`[Stripe] Triggering Instant Payout for user ${userId}: ${(amountInCents / 100).toFixed(2)}`);

    return await getStripe().payouts.create({
      amount: amountInCents,
      currency: 'usd',
      method: 'instant',
    }, {
      stripeAccount: accountId,
    });
  }

  /**
   * Transfers funds to user account while respecting Pending Dues lock.
   */
  async transferToUser(userId: string, accountId: string, amountInCents: number) {
    const balance = await getStripe().balance.retrieve({}, { stripeAccount: accountId });
    const totalAvailable = balance.available.reduce((sum, b) => sum + b.amount, 0);
    
    const withdrawalLimit = await revenueOracle.getWithdrawalLimit(userId, totalAvailable);
    
    if (amountInCents > withdrawalLimit) {
      throw new Error(`Withdrawal exceeds limit. Available after dues: ${(withdrawalLimit / 100).toFixed(2)}`);
    }

    return await getStripe().transfers.create({
      amount: amountInCents,
      currency: 'usd',
      destination: accountId,
    });
  }

  /**
   * Sweeps withheld dues to the platform's primary Stripe account.
   */
  async sweepToPlatform(userId: string, accountId: string) {
    const dues = await revenueOracle.calculatePendingDues(userId);
    if (dues.total <= 0) return { status: 'no_dues' };

    // In a real flow, this would use a 'reversal' or 'transfer' from the connect account back to platform
    // For now, we simulate the owner sweep
    console.log(`[Stripe] Sweeping ${(dues.total / 100).toFixed(2)} from user ${userId} to platform account.`);
    
    // Update local ledger
    if (dues.surcharges > 0) {
        await revenueOracle.recordSurchargePayment(userId, dues.surcharges);
    }

    return { 
      status: 'success', 
      amountSwept: dues.total, 
      type: dues.surcharges > 0 ? 'subscription_and_surcharge' : 'subscription_only' 
    };
  }

  async createPlatformCheckoutSession(userId: string, returnUrl: string, currency: string = 'usd', amountInCents: number = 5000) {
    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: 'EmpireLaunch AI - SaaS Platform Access',
              description: 'Full access to AI-driven business scaling, automations, and multi-tenant infrastructure.',
            },
            unit_amount: amountInCents,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}?canceled=true`,
      client_reference_id: userId,
      metadata: { userId, currency, amountInCents: String(amountInCents) },
    });
    return session;
  }

  async createExpansionCheckoutSession(userId: string, returnUrl: string) {
    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Empire Expansion Slot',
              description: 'Unlock an additional business slot in your empire. Includes +1 multi-tenant expansion.',
            },
            unit_amount: 5000, // $50.00 one-time
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}&expansion=true`,
      cancel_url: `${returnUrl}?canceled=true`,
      client_reference_id: userId,
      metadata: { userId, type: 'expansion' },
    });
    return session;
  }

  async getSession(sessionId: string) {
    return await getStripe().checkout.sessions.retrieve(sessionId);
  }

  async createFinancialConnectionsSession(accountId: string, userId: string) {
    const session = await getStripe().financialConnections.sessions.create({
      account_holder: {
        type: 'account',
        account: accountId,
      },
      permissions: ['balances', 'ownership', 'transactions'],
    });
    return session;
  }

  async getRecentCheckoutSessions(limit = 10) {
    const sessions = await getStripe().checkout.sessions.list({
      limit,
      expand: ['data.customer_details'],
    });
    return sessions.data;
  }

  async verifyUserPayment(userId: string): Promise<{ paid: boolean; paidAt: string | null; amount: number | null }> {
    // Look for completed checkouts in the last 24 hours
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const sessions = await getStripe().checkout.sessions.list({
      limit: 50,
      status: 'complete',
      created: { gte: oneDayAgo },
    });
    // Return the most recent completed checkout (if any)
    if (sessions.data.length > 0) {
      const latest = sessions.data[0];
      return { 
        paid: true, 
        paidAt: new Date(latest.created * 1000).toISOString(), 
        amount: latest.amount_total || 0 
      };
    }
    return { paid: false, paidAt: null, amount: null };
  }
}

export const stripeService = new StripeService();
