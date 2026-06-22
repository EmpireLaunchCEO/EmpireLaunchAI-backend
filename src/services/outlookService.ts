import axios from 'axios';
import dotenv from 'dotenv';
import { integrationService } from './integrationService.js';

dotenv.config();

export class OutlookService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.OUTLOOK_CLIENT_ID || '';
    this.clientSecret = process.env.OUTLOOK_CLIENT_SECRET || '';
    this.redirectUri = process.env.OUTLOOK_REDIRECT_URI || '';
  }

  getAuthUrl(state: string) {
    const scopes = [
      'offline_access',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/User.Read',
    ].join(' ');

    const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    url.searchParams.append('client_id', this.clientId);
    url.searchParams.append('response_type', 'code');
    url.searchParams.append('redirect_uri', this.redirectUri);
    url.searchParams.append('response_mode', 'query');
    url.searchParams.append('scope', scopes);
    url.searchParams.append('state', state);

    return url.toString();
  }

  async getAccessToken(code: string) {
    const response = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', new URLSearchParams({
      client_id: this.clientId,
      scope: 'https://graph.microsoft.com/Mail.Send',
      code,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
      client_secret: this.clientSecret,
    }));

    return response.data;
  }

  async refreshAccessToken(refreshToken: string) {
    const response = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', new URLSearchParams({
      client_id: this.clientId,
      scope: 'https://graph.microsoft.com/Mail.Send',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_secret: this.clientSecret,
    }));

    return response.data;
  }

  async sendEmail(accessToken: string, to: string, subject: string, body: string) {
    const response = await axios.post(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        message: {
          subject,
          body: {
            contentType: 'Text',
            content: body,
          },
          toRecipients: [
            {
              emailAddress: {
                address: to,
              },
            },
          ],
        },
        saveToSentItems: 'true',
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.status === 202;
  }

  async sendThankYouEmail(userId: string, customerEmail: string, productName: string) {
    const credentials = await integrationService.getCredentials(userId, 'outlook');
    if (!credentials || !credentials.access_token) {
      throw new Error('Outlook credentials not found or unauthorized');
    }

    const subject = `Thank you for your purchase of ${productName}!`;
    const body = `Hi there! Thank you for purchasing ${productName}. We hope you enjoy it!`;
    
    return this.sendEmail(credentials.access_token, customerEmail, subject, body);
  }
}

export const outlookService = new OutlookService();
