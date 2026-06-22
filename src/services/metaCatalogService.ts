import axios from 'axios';
import dotenv from 'dotenv';
import { integrationService } from './integrationService.js';

dotenv.config();

/**
 * Meta Catalog Service
 * 
 * Handles syncing products to Meta's Commerce Catalog for Instagram/Facebook shopping.
 * This maintains "Admin Blindness" by using the integrationService to handle encrypted tokens.
 */
export class MetaCatalogService {
  /**
   * Syncs a list of products to a Meta Catalog.
   */
  async syncCatalog(userId: string, catalogId: string, products: any[]) {
    console.log(`[MetaCatalog] Syncing ${products.length} products for user ${userId} to catalog ${catalogId}`);
    
    // 1. Get Meta Credentials
    const credentials = await integrationService.getCredentials(userId, 'meta');
    if (!credentials || !credentials.accessToken) {
      throw new Error('Meta integration not found or missing access token');
    }

    // 2. Format products for Meta Batch API
    // Meta Batch API expects a specific format: https://developers.facebook.com/docs/marketing-api/catalog/batch/
    const requests = products.map(product => ({
      method: 'CREATE',
      data: {
        id: product.id,
        title: product.name,
        description: product.description,
        availability: 'in stock',
        condition: 'new',
        price: product.price, // Format: "100.00 USD"
        link: product.url,
        image_link: product.imageUrl,
        brand: 'Bizrunner Store'
      }
    }));

    // 3. Send to Meta API
    try {
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${catalogId}/batch`,
        {
          requests,
          access_token: credentials.accessToken
        }
      );

      console.log(`[MetaCatalog] Sync successful:`, response.data);
      return response.data;
    } catch (error: any) {
      console.error('[MetaCatalog] Sync failed:', error.response?.data || error.message);
      throw new Error(`Meta Catalog sync failed: ${error.message}`);
    }
  }

  /**
   * Fetches available catalogs for a user's Meta account.
   */
  async getCatalogs(userId: string) {
    const credentials = await integrationService.getCredentials(userId, 'meta');
    if (!credentials || !credentials.accessToken) {
      throw new Error('Meta integration not found');
    }

    const response = await axios.get(`https://graph.facebook.com/v18.0/me/product_catalogs`, {
      params: { access_token: credentials.accessToken }
    });

    return response.data;
  }
}

export const metaCatalogService = new MetaCatalogService();
