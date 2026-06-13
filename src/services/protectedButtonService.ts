import { db, schema } from '../db/index.js';
const { paymentButtons, products } = schema;
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-01-27-acacia' as any,
});

export class ProtectedButtonService {
  /**
   * Generates a protected proxy URL for a product.
   */
  async generateButton(userId: string, productId: string, platform: string, isSingleUse: boolean = false) {
    const buttonId = uuidv4();
    const ott = crypto.randomBytes(16).toString('hex');
    
    // 1. Fetch product to get base data
    const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
    if (!product) throw new Error('Product not found');

    // 2. Store the Proxy Mapping
    await db.insert(paymentButtons).values({
      id: buttonId,
      userId,
      productId,
      platform,
      buttonType: 'interactive',
      buttonData: { 
        ott, 
        isSingleUse,
        label: `Get ${product.name}`
      },
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // 3. Return the Proxy URL
    return `https://pay.empirelaunch.ai/${buttonId}?ott=${ott}`;
  }

  /**
   * Resolves a proxy click to a real Stripe Checkout session.
   */
  async resolveProxy(buttonId: string, providedOtt: string, context: { userAgent: string, referrer: string, ip: string }) {
    const [button] = await db.select()
      .from(paymentButtons)
      .where(eq(paymentButtons.id, buttonId))
      .limit(1);
    
    if (!button || button.status !== 'active') {
      throw new Error('Link expired or invalid');
    }

    const buttonData = button.buttonData as any;

    // 1. OTT Validation
    if (buttonData.ott !== providedOtt) {
      throw new Error('Invalid security token');
    }

    // 2. Basic Bot Detection (Mock for now)
    if (context.userAgent.toLowerCase().includes('bot') || context.userAgent.toLowerCase().includes('crawler')) {
      console.log(`[Security] Bot detected for button ${buttonId}: ${context.userAgent}`);
      throw new Error('Security check failed');
    }

    // 3. Fetch Product
    const [product] = await db.select().from(products).where(eq(products.id, button.productId)).limit(1);
    if (!product) throw new Error('Product not found');

    // 4. Resolve Stripe Session
    // Note: In a full implementation, we'd use the user's Stripe Connect account ID from the vault
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: product.currency || 'usd',
            product_data: {
              name: product.name,
              description: product.description || '',
            },
            unit_amount: product.price,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `https://empirelaunch.ai/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://empirelaunch.ai/cancel`,
      metadata: {
        buttonId,
        userId: button.userId,
        productId: button.productId,
        platform: button.platform
      }
    });

    // 5. Expire OTT if single-use
    if (buttonData.isSingleUse) {
      await db.update(paymentButtons)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(paymentButtons.id, buttonId));
    }

    return session.url;
  }
}

export const protectedButtonService = new ProtectedButtonService();
