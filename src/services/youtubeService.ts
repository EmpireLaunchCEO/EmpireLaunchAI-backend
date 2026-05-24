import axios from 'axios';
import dotenv from 'dotenv';
import { integrationService } from './integrationService.js';

dotenv.config();

export class YouTubeService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.YOUTUBE_CLIENT_ID || '';
    this.clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';
    this.redirectUri = process.env.YOUTUBE_REDIRECT_URI || '';
  }

  getAuthUrl(state: string) {
    const scopes = [
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/youtube.readonly',
    ].join(' ');

    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${this.clientId}&redirect_uri=${this.redirectUri}&response_type=code&scope=${scopes}&state=${state}&access_type=offline&prompt=consent`;
  }

  async getAccessToken(code: string) {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });

    return response.data;
  }

  async getAnalytics(userId: string, startDate: string, endDate: string) {
    const credentials = await integrationService.getCredentials(userId, 'youtube');
    if (!credentials || !credentials.accessToken) {
      throw new Error('No YouTube credentials found');
    }

    const response = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
      },
      params: {
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'views,likes,dislikes,shares,estimatedMinutesWatched,averageViewDuration',
        dimensions: 'day',
      },
    });

    return response.data;
  }
}

export const youtubeService = new YouTubeService();
