import axios from 'axios';
import { integrationService } from './integrationService.js';

export class PinterestService {
  private clientId = process.env.PINTEREST_CLIENT_ID;
  private clientSecret = process.env.PINTEREST_CLIENT_SECRET;
  private redirectUri = process.env.PINTEREST_REDIRECT_URI;

  async getAccessToken(code: string) {
    const response = await axios.post('https://api.pinterest.com/v5/oauth/token', 
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri || '',
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return response.data;
  }

  async createPin(userId: string, params: { boardId: string; mediaUrl: string; title: string; description: string; link?: string }) {
    const credentials = await integrationService.getCredentials(userId, 'pinterest');
    if (!credentials || !credentials.accessToken) {
      throw new Error('No Pinterest credentials found');
    }

    const response = await axios.post('https://api.pinterest.com/v5/pins', 
      {
        board_id: params.boardId,
        media_source: {
          source_type: 'image_url',
          url: params.mediaUrl,
        },
        title: params.title,
        description: params.description,
        link: params.link,
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

  async getBoards(userId: string) {
    const credentials = await integrationService.getCredentials(userId, 'pinterest');
    if (!credentials || !credentials.accessToken) {
      throw new Error('No Pinterest credentials found');
    }

    const response = await axios.get('https://api.pinterest.com/v5/boards', {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
      },
    });

    return response.data;
  }

  async publishPost(userId: string, postData: any) {
    console.log(`[PinterestService] Publishing Pin for user ${userId}`);
    
    // In a real scenario, we'd fetch the user's default board if not provided
    const boards = await this.getBoards(userId);
    const boardId = postData.boardId || (boards.items && boards.items.length > 0 ? boards.items[0].id : null);
    
    if (!boardId) {
      throw new Error('No Pinterest board found to pin to');
    }

    return this.createPin(userId, {
      boardId,
      mediaUrl: postData.imageUrl || postData.videoUrl,
      title: postData.title || 'New Empire Launch AI Post',
      description: postData.caption || '',
      link: postData.paymentUrl,
    });
  }
}

export const pinterestService = new PinterestService();
