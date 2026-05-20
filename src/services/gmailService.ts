import axios from 'axios';
import dotenv from 'dotenv';
import { integrationService } from './integrationService.js';

dotenv.config();

export class GmailService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.GMAIL_CLIENT_ID || '';
    this.clientSecret = process.env.GMAIL_CLIENT_SECRET || '';
    this.redirectUri = process.env.GMAIL_REDIRECT_URI || '';
  }

  getAuthUrl(state: string) {
    const scopes = [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'openid'
    ].join(' ');

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.append('client_id', this.clientId);
    url.searchParams.append('redirect_uri', this.redirectUri);
    url.searchParams.append('response_type', 'code');
    url.searchParams.append('scope', scopes);
    url.searchParams.append('state', state);
    url.searchParams.append('access_type', 'offline');
    url.searchParams.append('prompt', 'consent');

    return url.toString();
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

  async refreshAccessToken(refreshToken: string) {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    return response.data;
  }

  async sendEmail(accessToken: string, to: string, subject: string, body: string) {
    // Gmail API requires the email to be base64url encoded
    const emailContent = [
      `To: ${to}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${subject}`,
      '',
      body,
    ].join('\r\n');

    const encodedEmail = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await axios.post(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { raw: encodedEmail },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  }

  async sendThankYouEmail(userId: string, customerEmail: string, productName: string) {
    const credentials = await integrationService.getCredentials(userId, 'gmail');
    if (!credentials || !credentials.access_token) {
      throw new Error('Gmail credentials not found or unauthorized');
    }

    const subject = `Thank you for your purchase of ${productName}!`;
    const body = `Hi there! Thank you for purchasing ${productName}. We hope you enjoy it!`;
    
    return this.sendEmail(credentials.access_token, customerEmail, subject, body);
  }
}

export const gmailService = new GmailService();
