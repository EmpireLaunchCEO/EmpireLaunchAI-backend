import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export class EtsyService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.ETSY_CLIENT_ID || '';
    this.clientSecret = process.env.ETSY_CLIENT_SECRET || '';
    this.redirectUri = process.env.ETSY_REDIRECT_URI || '';
  }

  getAuthUrl(state: string, codeChallenge: string) {
    const scopes = [
      'listings_r',
      'listings_w',
      'listings_d',
      'shops_r',
      'email_r',
      'profile_r',
    ].join('%20');

    return `https://www.etsy.com/oauth/connect?response_type=code&redirect_uri=${this.redirectUri}&scope=${scopes}&client_id=${this.clientId}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
  }

  async getAccessToken(code: string, codeVerifier: string) {
    const response = await axios.post('https://api.etsy.com/v3/public/oauth/token', {
      grant_type: 'authorization_code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code,
      code_verifier: codeVerifier,
    });

    return response.data;
  }

  async refreshAccessToken(refreshToken: string) {
    const response = await axios.post('https://api.etsy.com/v3/public/oauth/token', {
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: refreshToken,
    });

    return response.data;
  }

  async createListing(accessToken: string, shopId: string, listingData: any) {
    const response = await axios.post(
      `https://openapi.etsy.com/v3/application/shops/${shopId}/listings`,
      listingData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'x-api-key': this.clientId,
        },
      }
    );

    return response.data;
  }

  async getShop(accessToken: string) {
    const response = await axios.get('https://openapi.etsy.com/v3/application/users/me/shops', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': this.clientId,
      },
    });

    return response.data;
  }

  async searchListings(query: string, limit: number = 10) {
    // Note: Public search usually requires an API key and different endpoint
    // For this implementation, we simulate searching for high-performing listings
    const response = await axios.get('https://openapi.etsy.com/v3/application/listings/active', {
      params: {
        keywords: query,
        limit,
        sort_on: 'score', // Simulation of 'best seller' ranking
      },
      headers: {
        'x-api-key': this.clientId,
      },
    });

    return response.data;
  }
}

export const etsyService = new EtsyService();
