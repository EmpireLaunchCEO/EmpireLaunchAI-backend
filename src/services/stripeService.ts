import Stripe from 'stripe';
import dotenv from 'dotenv';

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
    }, {
      stripeAccount: accountId,
    });

    return paymentLink;
  }

  async getAccount(accountId: string) {
    return await stripe.accounts.retrieve(accountId);
  }
}

export const stripeService = new StripeService();
