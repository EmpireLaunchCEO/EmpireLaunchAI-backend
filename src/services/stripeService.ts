import Stripe from 'stripe';
import dotenv from 'dotenv';
import { db, schema } from '../db/index.js';
import { revenueOracle } from './revenueOracle.js';
import { paymentButtonService } from './paymentButtonService.js';
const { paymentButtons } = schema;
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-01-27-acacia' as any,
});

export class StripeService {
  async createConnectAccount(email: string) {
    const account = await stripe.accounts.create({
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
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
    return accountLink;
  }

  async createProductAndPrice(accountId: string, name: string, description: string, priceInCents: number) {
    const product = await stripe.products.create({
      name,
      description,
    }, {
      stripeAccount: accountId,
    });

    const price = await stripe.prices.create({
      unit_amount: priceInCents,
      currency: 'usd',
      product: product.id,
    }, {
      stripeAccount: accountId,
    });

    return { product, price };
  }

  async createPaymentLink(accountId: string, priceId: string) {
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      // Enable modern methods explicitly if needed, 
      // though dashboard-controlled is often preferred for AI optimization.
      payment_method_types: ['card', 'venmo', 'cashapp'],
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
    return await stripe.accounts.retrieve(accountId);
  }

  /**
   * Triggers an Instant Payout to the user's linked debit card.
   */
  async triggerInstantPayout(userId: string, accountId: string, amountInCents: number) {
    const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
    const totalAvailable = balance.available.reduce((sum, b) => sum + b.amount, 0);

    const withdrawalLimit = await revenueOracle.getWithdrawalLimit(userId, totalAvailable);

    if (amountInCents > withdrawalLimit) {
      throw new Error(`Instant Payout exceeds limit. Available after dues: ${(withdrawalLimit / 100).toFixed(2)}`);
    }

    console.log(`[Stripe] Triggering Instant Payout for user ${userId}: ${(amountInCents / 100).toFixed(2)}`);

    return await stripe.payouts.create({
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
    const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
    const totalAvailable = balance.available.reduce((sum, b) => sum + b.amount, 0);
    
    const withdrawalLimit = await revenueOracle.getWithdrawalLimit(userId, totalAvailable);
    
    if (amountInCents > withdrawalLimit) {
      throw new Error(`Withdrawal exceeds limit. Available after dues: ${(withdrawalLimit / 100).toFixed(2)}`);
    }

    return await stripe.transfers.create({
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
}

export const stripeService = new StripeService();
