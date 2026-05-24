import { etsyService } from './etsyService.js';
import { aiScriptingService } from './aiScriptingService.js';
import { db, schema } from '../db/index.js';
const { products, approvals, tasks } = schema;
import { v4 as uuidv4 } from 'uuid';
import { integrationService } from './integrationService.js';

export class ListingEngine {
  async researchAndDraft(userId: string, goalId: string, niche: string) {
    console.log(`[ListingEngine] Starting research and drafting for ${niche}...`);

    // 1. Search Best Sellers
    const searchResults = await etsyService.searchListings(niche, 5);
    const bestSellers = searchResults.results || [];

    if (bestSellers.length === 0) {
      console.warn(`No best sellers found for niche: ${niche}`);
    }

    // 2. Generate SEO-optimized listing idea
    const seoData = await aiScriptingService.generateListingSEO(niche, bestSellers);

    // 3. Create a Task for this listing
    const taskId = uuidv4();
    await db.insert(tasks).values({
      id: taskId,
      goalId,
      title: `Draft Listing for ${seoData.title}`,
      description: `Automated draft listing creation for niche: ${niche}`,
      status: 'todo',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 4. Create an Approval Request for the draft
    const approvalId = uuidv4();
    await db.insert(approvals).values({
      id: approvalId,
      userId,
      taskId,
      type: 'content',
      payload: {
        platform: 'etsy',
        ...seoData,
        sourceMarketData: bestSellers.map((b: any) => ({ title: b.title, url: b.url }))
      },
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { taskId, approvalId, seoData };
  }

  async publishListing(userId: string, platform: string, draftPayload: any) {
    console.log(`[ListingEngine] Publishing listing to ${platform} for user ${userId}...`);
    // This is a generic entry point for the orchestrator
    if (platform.toLowerCase() === 'etsy') {
       // In a real flow, the payload might already be the approval payload
       // For now, we simulate the publication
       const credentials = await integrationService.getCredentials(userId, 'etsy');
       if (!credentials) throw new Error('Etsy integration not found');

       return await etsyService.createListing(credentials.accessToken, credentials.shopId, {
         title: draftPayload.title,
         description: draftPayload.description,
         price: (draftPayload.price / 100).toFixed(2),
         quantity: 100,
         state: 'active', // Publish immediately if called via orchestrator
         taxonomy_id: 1,
         who_made: 'i_did',
         when_made: 'made_to_order',
         is_supply: false,
       });
    }
    throw new Error(`Platform ${platform} not supported for direct publication yet.`);
  }

  async publishApprovedListing(userId: string, approvalId: string) {
    // 1. Verify Approval
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    if (!approval || approval.status !== 'approved') {
      throw new Error('Listing not approved or not found');
    }

    // 2. Get Etsy Credentials
    const credentials = await integrationService.getCredentials(userId, 'etsy');
    if (!credentials) throw new Error('Etsy integration not found');

    // 3. Create Product in local DB
    const productId = uuidv4();
    await db.insert(products).values({
      id: productId,
      userId,
      name: approval.payload.title,
      description: approval.payload.description,
      price: approval.payload.price,
      currency: 'usd',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 4. Create Draft on Etsy
    // In a real flow, we'd use the shopId from the user's shop integration
    const shopId = credentials.shopId; 
    const etsyListing = await etsyService.createListing(credentials.accessToken, shopId, {
      title: approval.payload.title,
      description: approval.payload.description,
      price: (approval.payload.price / 100).toFixed(2),
      quantity: 100, // Default quantity for digital products
      state: 'active', // Publish as active once approved
      taxonomy_id: 1, // Placeholder taxonomy ID
      who_made: 'i_did',
      when_made: 'made_to_order',
      is_supply: false,
    });

    // 5. Update Task
    if (approval.taskId) {
      await db.update(tasks)
        .set({ status: 'completed', result: { etsyListingId: etsyListing.listing_id }, updatedAt: new Date() })
        .where(eq(tasks.id, approval.taskId));
    }

    return etsyListing;
  }
}

import { eq } from 'drizzle-orm';
export const listingEngine = new ListingEngine();
