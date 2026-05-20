import { etsyService } from './etsyService.js';
import { shopifyService } from './shopifyService.js';
import { amazonService } from './amazonService.js';
import { complianceService } from './complianceService.js';
import { integrationService } from './integrationService.js';
import { auditService } from './auditService.js';

export class UniversalListingEngine {
  async publishListing(userId: string, platform: string, listingData: any) {
    console.log(`[ListingEngine] Publishing to ${platform} for user ${userId}`);

    // 1. Compliance Check
    const validation = await complianceService.validateListing(platform, listingData);
    if (!validation.valid) {
      throw new Error(`Compliance failed for ${platform}: ${validation.errors.join(', ')}`);
    }

    // 2. Fetch Credentials (Admin Blindness: Decryption happens in memory here)
    const credentials = await integrationService.getCredentials(userId, platform.toLowerCase());
    if (!credentials) {
      throw new Error(`No credentials found for ${platform}`);
    }

    let result;
    try {
      // 3. Platform-specific data mapping and execution
      switch (platform) {
        case 'Etsy':
          // Map ContentDraft to Etsy Listing
          const etsyData = {
            title: listingData.title,
            description: listingData.body || listingData.description,
            price: listingData.price || 10.00,
            quantity: listingData.quantity || 1,
            who_made: 'i_did',
            when_made: 'made_to_order',
            is_supply: false,
            // ... images would be a separate call in Etsy v3, but we simplify here
          };
          result = await etsyService.createListing(credentials.accessToken, credentials.shopId, etsyData);
          break;
        case 'Shopify':
          // Map ContentDraft to Shopify Product
          const shopifyData = {
            title: listingData.title,
            body_html: listingData.body || listingData.description,
            vendor: listingData.vendor || 'EmpireLaunch AI AI',
            product_type: listingData.category || 'Digital',
            variants: [{
              price: (listingData.price || 10.00).toString(),
            }],
            images: listingData.mediaUrl ? [{ src: listingData.mediaUrl }] : []
          };
          result = await shopifyService.createListing(credentials.shopName, credentials.accessToken, shopifyData);
          break;
        case 'Amazon':
          // Map ContentDraft to Amazon Listing
          const amazonData = {
            title: listingData.title,
            brand: listingData.brand || 'EmpireLaunch AI',
            description: listingData.body || listingData.description,
            price: listingData.price || 10.00,
            sku: listingData.sku || `BR-${Date.now()}`,
            category: listingData.category || 'GENERIC',
            images: listingData.mediaUrl ? [listingData.mediaUrl] : []
          };
          result = await amazonService.createListing(credentials.accessToken, credentials.marketplaceId, amazonData);
          break;
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }

      // 4. Audit Log
      await auditService.log(userId, 'PUBLISH_LISTING', platform, { success: true });

      return result;
    } catch (error: any) {
      console.error(`[ListingEngine] Error publishing to ${platform}:`, error.message);
      await auditService.log(userId, 'PUBLISH_LISTING', platform, { success: false, error: error.message });
      throw error;
    }
  }
}

export const listingEngine = new UniversalListingEngine();
