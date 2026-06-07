import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export interface ShopifyListingData {
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  variants: {
    price: string;
    sku?: string;
  }[];
  images?: {
    src: string;
  }[];
}

export class ShopifyService {
  private readonly clientId = process.env.SHOPIFY_CLIENT_ID || '';
  private readonly clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  private readonly redirectUri = process.env.SHOPIFY_REDIRECT_URI || '';

  /**
   * Generates the Shopify OAuth URL.
   * Shopify requires the shop name to construct the URL.
   */
  getAuthUrl(shopName: string, state: string) {
    const scopes = [
      'write_products',
      'read_products',
      'read_orders',
      'read_shopify_payments_payouts',
      'read_content',
      'write_content'
    ].join(',');

    return `https://${shopName}.myshopify.com/admin/oauth/authorize?client_id=${this.clientId}&scope=${scopes}&redirect_uri=${this.redirectUri}&state=${state}`;
  }

  /**
   * Exchanges authorization code for an access token.
   */
  async getAccessToken(shopName: string, code: string) {
    const url = `https://${shopName}.myshopify.com/admin/oauth/access_token`;
    
    const response = await axios.post(url, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
    });

    return response.data;
  }

  async createListing(shopName: string, accessToken: string, productData: ShopifyListingData) {
    // Shopify Admin REST API endpoint
    const url = `https://${shopName}.myshopify.com/admin/api/2024-04/products.json`;
    
    const response = await axios.post(url, { product: productData }, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    return response.data;
  }
}

export const shopifyService = new ShopifyService();
