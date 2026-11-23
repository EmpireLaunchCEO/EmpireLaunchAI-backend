import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export interface EtsyListing {
  listing_id: number;
  title: string;
  description: string;
  price: {
    amount: number;
    divisor: number;
    currency_code: string;
  };
  url: string;
  views: number;
  num_favorers: number;
  creation_tsz: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * EtsyService (v3) - High Intelligence Production Implementation
 * Handles official OAuth flow and production endpoints for listing management.
 */
export class EtsyService {
  private readonly clientSecret = process.env.ETSY_CLIENT_SECRET || '';
  private readonly redirectUri = process.env.ETSY_REDIRECT_URI || '';
  private readonly baseUrl = 'https://openapi.etsy.com/v3';

  /**
   * Read at call time, not at construction time: the keystring is an operator
   * setting, and a value that appears after this module was first imported must
   * still be honoured (and a value that is absent must be reported as absent).
   */
  private get clientId(): string {
    return process.env.ETSY_CLIENT_ID || '';
  }

  /** True when the owner's free Etsy keystring is present. */
  get isConfigured(): boolean {
    return this.clientId.trim().length > 0;
  }

  /**
   * Generates the official Etsy OAuth 2.0 URL
   */
  getAuthUrl(state: string, codeChallenge: string) {
    const scopes = [
      'listings_r',
      'listings_w',
      'listings_d',
      'shops_r',
      'transactions_r', // Required for Sales logic
      'email_r',
      'profile_r',
    ].join('%20');
    
    return `https://www.etsy.com/oauth/connect?response_type=code&redirect_uri=${this.redirectUri}&scope=${scopes}&client_id=${this.clientId}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
  }

  /**
   * Exchanges OAuth authorization code for access + refresh tokens.
   */
  async getAccessToken(code: string, codeVerifier: string): Promise<TokenResponse> {
    const response = await axios.post('https://api.etsy.com/v3/public/oauth/token', {
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code,
      code_verifier: codeVerifier,
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return response.data;
  }

  /**
   * Fetches the authenticated user's shop information.
   */
  async getShop(accessToken: string) {
    const response = await axios.get(`${this.baseUrl}/application/shops`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'x-api-key': this.clientId,
      },
    });
    return response.data;
  }

  /**
   * Searches Etsy listings by keyword.
   */
  async searchListings(keywords: string, limit: number = 10) {
    const response = await axios.get(`${this.baseUrl}/application/listings/active`, {
      params: {
        keywords,
        limit,
      },
      headers: {
        'x-api-key': this.clientId,
      },
    });
    return response.data;
  }

  /**
   * Real active listings for a keyword, with the real result count.
   * Etsy v3 answers `{ count, results: [...] }`; both halves are returned as-is
   * so callers can report a real number instead of guessing at one.
   */
  async findAllActiveListingsByKeywords(
    keywords: string,
    limit: number = 12,
  ): Promise<{ count: number; results: any[] }> {
    const data = await this.searchListings(keywords, limit);
    return {
      count: typeof data?.count === 'number' ? data.count : 0,
      results: Array.isArray(data?.results) ? data.results : [],
    };
  }

  /**
   * PRODUCTION: Creates a listing on Etsy
   * Ref: POST /v3/application/shops/{shop_id}/listings
   */
  async createListing(accessToken: string, shopId: string, data: any) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/application/shops/${shopId}/listings`,
        {
          quantity: data.quantity || 1,
          title: data.title,
          description: data.description,
          price: data.price,
          who_made: data.who_made || 'i_did',
          when_made: data.when_made || 'made_to_order',
          taxonomy_id: data.taxonomy_id || 1, // General digital category
          is_renewable: true,
          type: 'download', // Primary focus: Digital Marketing
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'x-api-key': this.clientId,
          },
        }
      );
      return response.data;
    } catch (error: any) {
      console.error('Etsy Creation Error:', error.response?.data || error.message);
      throw new Error(`Etsy sync failed: ${JSON.stringify(error.response?.data || error.message)}`);
    }
  }

  /**
   * PRODUCTION: Fetches real sales receipts
   * Ref: GET /v3/application/shops/{shop_id}/receipts
   */
  async getRecentSales(accessToken: string, shopId: string) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/application/shops/${shopId}/receipts`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'x-api-key': this.clientId,
          },
        }
      );
      return response.data.results;
    } catch (error: any) {
      console.error('Etsy Sales Fetch Error:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * PRODUCTION: Fetches shop statistics for Growth Analytics
   * Ref: GET /v3/application/shops/{shop_id}/stats
   */
  async getGrowthStats(accessToken: string, shopId: string) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/application/shops/${shopId}/stats`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'x-api-key': this.clientId,
          },
        }
      );
      return response.data;
    } catch (error: any) {
      console.error('Etsy Stats Error:', error.response?.data || error.message);
      return null;
    }
  }
}

export const etsyService = new EtsyService();
