import axios from 'axios';
import dotenv from 'dotenv';
import { integrationService } from './integrationService.js';

dotenv.config();

export class TikTokService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.TIKTOK_CLIENT_ID || '';
    this.clientSecret = process.env.TIKTOK_CLIENT_SECRET || '';
    this.redirectUri = process.env.TIKTOK_REDIRECT_URI || '';
  }

  getAuthUrl(state: string) {
    const scopes = [
      'video.list',
      'video.stats',
      'user.info.basic'
    ].join(',');

    return `https://www.tiktok.com/v2/auth/authorize/?client_key=${this.clientId}&scope=${scopes}&response_type=code&redirect_uri=${this.redirectUri}&state=${state}`;
  }

  async getAccessToken(code: string) {
    const response = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', 
      new URLSearchParams({
        client_key: this.clientId,
        client_secret: this.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri,
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    return response.data;
  }

  async getVideoAnalytics(userId: string) {
    const credentials = await integrationService.getCredentials(userId, 'tiktok_display');
    if (!credentials || !credentials.accessToken) {
      throw new Error('No TikTok Display credentials found');
    }

    const response = await axios.post('https://open.tiktokapis.com/v2/video/list/', 
      {
        fields: ['id', 'title', 'view_count', 'like_count', 'comment_count', 'share_count']
      },
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  }

  async publishVideo(userId: string, videoUrl: string, title: string, description: string) {
    const credentials = await integrationService.getCredentials(userId, 'tiktok_publish');
    if (!credentials || !credentials.accessToken) {
      throw new Error('No TikTok Publish credentials found');
    }

    console.log(`[TikTok] Publishing Video for user ${userId}: ${title}`);
    
    // Mock publishing response for TikTok Content Posting API
    return {
      status: 'success',
      publishId: 'mock-tiktok-pub-' + Math.random().toString(36).substring(7),
      shareUrl: 'https://www.tiktok.com/@user/video/mock'
    };
  }
}

export const tiktokService = new TikTokService();
