import { db, schema } from '../db/index.js';
const { products, paymentLinks, paymentButtons, goals, revenueTransactions } = schema;
import { stripeService } from './stripeService.js';
import { metaService } from './metaService.js';
import { tiktokShopService } from './tiktokShopService.js';
import { notificationService } from './notificationService.js';
import { vaultService } from './vaultService.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export class PaymentLinkService {
  /**
   * Generates a payment link and stages it for social commerce.
   */
  async createBridge(userId: string, productId: string, targetPlatform: 'instagram' | 'tiktok' | 'facebook') {
    console.log(`[PaymentLinkService] Creating bridge for product ${productId} on ${targetPlatform}`);

    // 1. Fetch Product
    const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
    if (!product) throw new Error('Product not found');

    // 2. Resolve Merchant Account from Ownership Vault
    let stripeAccountId = await vaultService.getSecret(userId, 'stripe', 'stripe_account_id');
    
    // Fallback for transition/mock if vault empty
    if (!stripeAccountId) {
        stripeAccountId = `acct_mock_${userId}`;
    }

    // 3. Generate Stripe Payment Link
    const { price } = await stripeService.createProductAndPrice(
      stripeAccountId,
      product.name,
      product.description || '',
      product.price
    );

    const stripeLink = await stripeService.createPaymentLink(stripeAccountId, price.id);

    // 4. Record the link
    const linkId = uuidv4();
    await db.insert(paymentLinks).values({
      id: linkId,
      productId: productId,
      stripeLinkId: stripeLink.id,
      url: stripeLink.url,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // 5. Create Platform Button
    const buttonId = uuidv4();
    await db.insert(paymentButtons).values({
      id: buttonId,
      userId,
      productId,
      platform: targetPlatform,
      buttonType: 'link',
      buttonData: { 
        url: stripeLink.url, 
        label: `Buy ${product.name}`,
        stripeLinkId: stripeLink.id 
      },
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return { 
      linkId, 
      url: stripeLink.url, 
      buttonId,
      platformTags: await this.preparePlatformTags(targetPlatform, productId) 
    };
  }

  /**
   * Prepares platform-specific tagging metadata.
   */
  private async preparePlatformTags(platform: string, productId: string) {
    if (platform === 'instagram') {
      return {
        product_id: productId,
        type: 'shopping_tag',
        checkout_url: 'stripe_link_placeholder'
      };
    }
    if (platform === 'tiktok') {
      return {
        anchor_id: `anchor_${productId}`,
        type: 'product_anchor'
      };
    }
    return {};
  }

  /**
   * Webhook handler for mapping successful payments back to ROI.
   */
  async processPaymentWebhook(stripeEvent: any) {
    if (stripeEvent.type === 'payment_intent.succeeded') {
      const intent = stripeEvent.data.object;
      const metadata = intent.metadata;

      if (metadata.productId && metadata.postId) {
        console.log(`[PaymentLinkService] ROI Match: Product ${metadata.productId} sold via Post ${metadata.postId}`);
        
        // Update revenueTransactions table
        await db.insert(revenueTransactions).values({
          id: uuidv4(),
          userId: metadata.userId,
          platform: 'stripe',
          amount: intent.amount,
          currency: intent.currency,
          externalTransactionId: intent.id,
          productId: metadata.productId,
          date: new Date(),
          createdAt: new Date()
        });
        
        // Send a notification to the user
        await notificationService.notifyUser(
          metadata.userId, 
          `Sale Alert! Your post generated a ${intent.amount / 100} sale.`, 
          false
        );
      }
    }
  }
}

export const paymentLinkService = new PaymentLinkService();
