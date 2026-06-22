import axios from 'axios';

export interface SystemeIoContact {
  email: string;
  first_name?: string;
  tags?: string[];
}

export class SystemeIoService {
  private baseUrl = 'https://api.systeme.io/api';

  /**
   * Create a contact in Systeme.io
   */
  async createContact(apiKey: string, contact: SystemeIoContact) {
    const response = await axios.post(`${this.baseUrl}/contacts`, contact, {
      headers: { 'X-API-Key': apiKey }
    });
    return response.data;
  }

  /**
   * Add a tag to a contact
   */
  async addTag(apiKey: string, tagName: string) {
    const response = await axios.post(`${this.baseUrl}/tags`, { name: tagName }, {
      headers: { 'X-API-Key': apiKey }
    });
    return response.data;
  }

  /**
   * Get newsletters
   */
  async getNewsletters(apiKey: string) {
    const response = await axios.get(`${this.baseUrl}/newsletters`, {
      headers: { 'X-API-Key': apiKey }
    });
    return response.data;
  }

  /**
   * Get account handle/info for verification
   */
  async getAccountInfo(apiKey: string) {
    // There isn't a direct "me" endpoint mentioned, but we can try listing contacts as a check
    const response = await axios.get(`${this.baseUrl}/contacts?limit=1`, {
      headers: { 'X-API-Key': apiKey }
    });
    return {
      handle: 'Systeme.io Account',
      id: apiKey.substring(0, 8) + '...',
      contacts_count: response.headers['x-total-count'] || 0
    };
  }

  /**
   * Create an email campaign
   */
  async createCampaign(apiKey: string, name: string) {
    const response = await axios.post(`${this.baseUrl}/campaigns`, { name }, {
      headers: { 'X-API-Key': apiKey }
    });
    return response.data;
  }

  /**
   * Create a step (email) in a campaign
   */
  async createCampaignStep(apiKey: string, campaignId: number, step: {
    subject: string,
    content: string,
    delay_days: number
  }) {
    const response = await axios.post(`${this.baseUrl}/campaigns/${campaignId}/steps`, step, {
      headers: { 'X-API-Key': apiKey }
    });
    return response.data;
  }
}

export const systemeIoService = new SystemeIoService();
