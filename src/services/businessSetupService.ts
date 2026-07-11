import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export interface SetupStep {
  id: string;
  title: string;
  description: string;
  platform: 'general' | 'etsy' | 'shopify' | 'tiktok' | 'instagram';
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  order: number;
  actionUrl?: string;
  estimatedMinutes: number;
}

export interface BusinessSetupPlan {
  userId: string;
  niche: string;
  platform: string;
  steps: SetupStep[];
  createdAt: Date;
  progress: number; // percentage 0-100
}

export class BusinessSetupService {
  /**
   * Generate a business setup plan for a client based on their niche and chosen platform.
   */
  async generateSetupPlan(userId: string, niche: string, platform: string): Promise<BusinessSetupPlan> {
    const steps = this.getPlatformSteps(platform, niche);
    
    const plan: BusinessSetupPlan = {
      userId,
      niche,
      platform,
      steps,
      createdAt: new Date(),
      progress: 0,
    };

    // Save to DB
    try {
      await db.insert(schema.businessSetups).values({
        id: uuidv4(),
        userId,
        niche,
        platform,
        steps: JSON.parse(JSON.stringify(steps)),
        progress: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (e) {
      console.warn('[BusinessSetup] Failed to save plan:', (e as Error).message);
    }

    return plan;
  }

  /**
   * Get the steps for a specific platform.
   */
  private getPlatformSteps(platform: string, niche: string): SetupStep[] {
    switch (platform.toLowerCase()) {
      case 'etsy':
        return this.getEtsySteps(niche);
      case 'shopify':
        return this.getShopifySteps(niche);
      default:
        return this.getGeneralSteps(niche);
    }
  }

  private getEtsySteps(niche: string): SetupStep[] {
    return [
      { id: 'etsy-01', title: 'Create Etsy Account', description: 'Sign up for an Etsy seller account and verify your email.', platform: 'etsy', status: 'pending', order: 1, actionUrl: 'https://www.etsy.com/sell', estimatedMinutes: 10 },
      { id: 'etsy-02', title: 'Set Up Shop Preferences', description: 'Choose your shop language, country, and currency.', platform: 'etsy', status: 'pending', order: 2, estimatedMinutes: 5 },
      { id: 'etsy-03', title: 'Name Your Shop', description: 'Pick a unique shop name that reflects your brand.', platform: 'etsy', status: 'pending', order: 3, estimatedMinutes: 10 },
      { id: 'etsy-04', title: 'Create Your First Listing', description: `List your first ${niche} product with photos, description, and pricing.`, platform: 'etsy', status: 'pending', order: 4, estimatedMinutes: 20 },
      { id: 'etsy-05', title: 'Set Up Payments', description: 'Connect your bank account or PayPal to receive payments.', platform: 'etsy', status: 'pending', order: 5, estimatedMinutes: 10 },
      { id: 'etsy-06', title: 'Configure Shipping', description: 'Set up shipping profiles with rates and delivery times.', platform: 'etsy', status: 'pending', order: 6, estimatedMinutes: 15 },
      { id: 'etsy-07', title: 'Write Shop Policies', description: 'Create return, refund, and privacy policies.', platform: 'etsy', status: 'pending', order: 7, estimatedMinutes: 10 },
      { id: 'etsy-08', title: 'Optimize with SEO', description: 'Use keywords in titles, tags, and descriptions for discoverability.', platform: 'etsy', status: 'pending', order: 8, estimatedMinutes: 15 },
      { id: 'etsy-09', title: 'Link to EmpireLaunch AI', description: 'Connect your Etsy shop so AI can manage listings and track sales.', platform: 'etsy', status: 'pending', order: 9, estimatedMinutes: 5 },
      { id: 'etsy-10', title: 'Launch & Promote', description: 'Publish your listings and share on social media.', platform: 'etsy', status: 'pending', order: 10, estimatedMinutes: 5 },
    ];
  }

  private getShopifySteps(niche: string): SetupStep[] {
    return [
      { id: 'shop-01', title: 'Start Shopify Trial', description: 'Sign up for a Shopify account (14-day free trial).', platform: 'shopify', status: 'pending', order: 1, actionUrl: 'https://www.shopify.com', estimatedMinutes: 5 },
      { id: 'shop-02', title: 'Choose a Theme', description: 'Pick a free or paid theme that matches your brand aesthetic.', platform: 'shopify', status: 'pending', order: 2, estimatedMinutes: 15 },
      { id: 'shop-03', title: 'Add Products', description: `Add your ${niche} products with descriptions, images, and pricing.`, platform: 'shopify', status: 'pending', order: 3, estimatedMinutes: 20 },
      { id: 'shop-04', title: 'Set Up Payments', description: 'Configure Shopify Payments or connect a payment gateway.', platform: 'shopify', status: 'pending', order: 4, estimatedMinutes: 10 },
      { id: 'shop-05', title: 'Configure Shipping', description: 'Set up shipping zones, rates, and delivery options.', platform: 'shopify', status: 'pending', order: 5, estimatedMinutes: 15 },
      { id: 'shop-06', title: 'Set Up Domain', description: 'Connect a custom domain or use a myshopify.com subdomain.', platform: 'shopify', status: 'pending', order: 6, estimatedMinutes: 10 },
      { id: 'shop-07', title: 'Create Policies', description: 'Generate refund, privacy, and terms pages.', platform: 'shopify', status: 'pending', order: 7, estimatedMinutes: 10 },
      { id: 'shop-08', title: 'Install Marketing Apps', description: 'Add SEO, email marketing, and social media apps.', platform: 'shopify', status: 'pending', order: 8, estimatedMinutes: 15 },
      { id: 'shop-09', title: 'Link to EmpireLaunch AI', description: 'Connect your Shopify store for AI-powered management.', platform: 'shopify', status: 'pending', order: 9, estimatedMinutes: 5 },
      { id: 'shop-10', title: 'Launch Store', description: 'Remove password page and go live!', platform: 'shopify', status: 'pending', order: 10, estimatedMinutes: 5 },
    ];
  }

  private getGeneralSteps(niche: string): SetupStep[] {
    return [
      { id: 'gen-01', title: 'Define Your Niche', description: `Research and refine your "${niche}" niche — know your audience and competitors.`, platform: 'general', status: 'pending', order: 1, estimatedMinutes: 20 },
      { id: 'gen-02', title: 'Choose a Platform', description: 'Decide where to sell: Etsy, Shopify, TikTok Shop, or your own site.', platform: 'general', status: 'pending', order: 2, estimatedMinutes: 10 },
      { id: 'gen-03', title: 'Create Your Brand', description: 'Define your brand name, logo, colors, and voice.', platform: 'general', status: 'pending', order: 3, estimatedMinutes: 15 },
      { id: 'gen-04', title: 'Link Your Accounts', description: 'Connect your chosen platforms via the Link Center.', platform: 'general', status: 'pending', order: 4, estimatedMinutes: 5 },
      { id: 'gen-05', title: 'Generate First Content', description: 'Use Empire Studio to create your first video or design.', platform: 'general', status: 'pending', order: 5, estimatedMinutes: 10 },
      { id: 'gen-06', title: 'Set Up Pricing', description: 'Research competitor pricing and set your prices.', platform: 'general', status: 'pending', order: 6, estimatedMinutes: 15 },
      { id: 'gen-07', title: 'Create Listings', description: 'Write product descriptions, take photos, and publish.', platform: 'general', status: 'pending', order: 7, estimatedMinutes: 20 },
      { id: 'gen-08', title: 'Plan Your Launch', description: 'Schedule social media posts and announce your business.', platform: 'general', status: 'pending', order: 8, estimatedMinutes: 10 },
    ];
  }

  /**
   * Mark a step as completed.
   */
  async completeStep(userId: string, stepId: string): Promise<void> {
    // In production, update the DB record
    console.log(`[BusinessSetup] User ${userId} completed step ${stepId}`);
  }
}

export const businessSetupService = new BusinessSetupService();