import axios from 'axios';

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
  async createListing(shopName: string, accessToken: string, productData: ShopifyListingData) {
    // Shopify Admin REST API endpoint
    const url = `https://${shopName}.myshopify.com/admin/api/2024-01/products.json`;
    
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
