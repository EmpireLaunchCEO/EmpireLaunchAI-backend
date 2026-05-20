import axios from 'axios';
import dotenv from 'dotenv';
import { integrationService } from './integrationService.js';

dotenv.config();

export class MetaService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.META_CLIENT_ID || '';
    this.clientSecret = process.env.META_CLIENT_SECRET || '';
    this.redirectUri = process.env.META_REDIRECT_URI || '';
  }

  getAuthUrl(state: string) {
    const scopes = [
      'instagram_basic',
      'instagram_content_publish',
      'pages_show_list',
      'pages_read_engagement',
      'public_profile',
    ].join(',');

    return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${this.clientId}&redirect_uri=${this.redirectUri}&state=${state}&scope=${scopes}`;
  }

  async getAccessToken(code: string) {
    const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        client_secret: this.clientSecret,
        code,
      },
    });

    return response.data;
  }

  async getLongLivedToken(shortLivedToken: string) {
    const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        fb_exchange_token: shortLivedToken,
      },
    });

    return response.data;
  }

  async postToInstagram(accessToken: string, instagramBusinessAccountId: string, imageUrl: string, caption: string) {
    // 1. Create media container
    const containerResponse = await axios.post(
      `https://graph.facebook.com/v18.0/${instagramBusinessAccountId}/media`,
      {
        image_url: imageUrl,
        caption,
        access_token: accessToken,
      }
    );

    const creationId = containerResponse.data.id;

    // 2. Publish media
    const publishResponse = await axios.post(
      `https://graph.facebook.com/v18.0/${instagramBusinessAccountId}/media_publish`,
      {
        creation_id: creationId,
        access_token: accessToken,
      }
    );

    return publishResponse.data;
  }

  async getInstagramAccounts(accessToken: string) {
    const response = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        fields: 'instagram_business_account,name',
        access_token: accessToken,
      },
    });

    return response.data;
  }

  async publishPost(userId: string, postData: any) {
    console.log(`[MetaService] Publishing to Instagram for user ${userId}`);
    
    // 1. Fetch Credentials
    const credentials = await integrationService.getCredentials(userId, 'meta');
    if (!credentials) {
      throw new Error('No Meta credentials found');
    }

    // 2. Publish
    return this.postToInstagram(
      credentials.accessToken,
      credentials.instagramBusinessAccountId,
      postData.imageUrl,
      postData.caption
    );
  }
}

export const metaService = new MetaService();
