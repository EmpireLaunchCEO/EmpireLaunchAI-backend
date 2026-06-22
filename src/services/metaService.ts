import axios from 'axios';
import { integrationService } from './integrationService.js';

export class MetaService {
  private clientId = process.env.META_CLIENT_ID;
  private clientSecret = process.env.META_CLIENT_SECRET;
  private redirectUri = `${process.env.FRONTEND_URL}/auth/callback/meta`;

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

  getAuthUrl(state: string) {
    const scopes = [
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_insights',
      'pages_show_list',
      'pages_read_engagement'
    ].join(',');
    return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${this.clientId}&redirect_uri=${this.redirectUri}&scope=${scopes}&state=${state}&response_type=code`;
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

  async getInstagramInsights(userId: string, mediaId: string) {
    const credentials = await integrationService.getCredentials(userId, 'meta');
    if (!credentials || !credentials.accessToken) {
      throw new Error('No Meta credentials found');
    }

    const response = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}/insights`, {
      params: {
        metric: 'engagement,impressions,reach,saved',
        access_token: credentials.accessToken,
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

    let finalCaption = postData.caption;

    // 2. Inject Payment Link if provided
    if (postData.paymentUrl) {
      finalCaption = `${finalCaption}\n\n🛒 Buy it here: ${postData.paymentUrl}`;
    }

    // 3. Publish
    return this.postToInstagram(
      credentials.accessToken,
      credentials.instagramBusinessAccountId,
      postData.imageUrl,
      finalCaption
    );
  }
}

export const metaService = new MetaService();
