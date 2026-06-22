import axios from 'axios';
import dotenv from 'dotenv';
import { integrationService } from './integrationService.js';

dotenv.config();

export class CanvaService {
  private baseUrl = 'https://api.canva.com/v1';

  /**
   * Generates a design from a template using the autofill API.
   * Mocked for now to demonstrate the flow.
   */
  async createFromTemplate(userId: string, templateId: string, data: any) {
    const credentials = await integrationService.getCredentials(userId, 'canva');
    if (!credentials || !credentials.accessToken) {
      throw new Error('No Canva credentials found');
    }

    const response = await axios.post(
      `${this.baseUrl}/autofills`,
      {
        brand_template_id: templateId,
        data: data
      },
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const jobId = response.data.job.id;
    return this.pollAutofillJob(userId, jobId);
  }

  private async pollAutofillJob(userId: string, jobId: string): Promise<string> {
    const credentials = await integrationService.getCredentials(userId, 'canva');
    let status = 'IN_PROGRESS';
    let designId = '';

    while (status === 'IN_PROGRESS') {
      await new Promise(resolve => setTimeout(resolve, 3000)); // Poll every 3 seconds
      const response = await axios.get(`${this.baseUrl}/autofills/${jobId}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` }
      });
      status = response.data.job.status;
      if (status === 'SUCCESS') {
        designId = response.data.job.design_id;
      } else if (status === 'FAILED') {
        throw new Error(`Canva autofill job failed: ${response.data.job.error.message}`);
      }
    }
    return designId;
  }

  /**
   * Triggers an export job for a design.
   */
  async exportDesign(userId: string, designId: string) {
    const credentials = await integrationService.getCredentials(userId, 'canva');
    const response = await axios.post(
      `${this.baseUrl}/exports`,
      {
        design_id: designId,
        format: { type: 'PDF_STANDARD' }
      },
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const jobId = response.data.job.id;
    return this.pollExportJob(userId, jobId);
  }

  private async pollExportJob(userId: string, jobId: string): Promise<string> {
    const credentials = await integrationService.getCredentials(userId, 'canva');
    let status = 'IN_PROGRESS';
    let exportUrl = '';

    while (status === 'IN_PROGRESS') {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const response = await axios.get(`${this.baseUrl}/exports/${jobId}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` }
      });
      status = response.data.job.status;
      if (status === 'SUCCESS') {
        exportUrl = response.data.job.export_url;
      } else if (status === 'FAILED') {
        throw new Error(`Canva export job failed: ${response.data.job.error.message}`);
      }
    }
    return exportUrl;
  }

  /**
   * Alias for createFromTemplate to match orchestrator naming
   */
  async autofillDesign(userId: string, templateId: string, data: any) {
    return this.createFromTemplate(userId, templateId, data);
  }

  /**
   * Search for brand templates matching a query.
   * Mocked search logic as per Step 2 of the pipeline.
   */
  async searchTemplates(userId: string, style: string, niche: string): Promise<string[]> {
    // In a real implementation, this would use semantic search or Canva's asset search API
    // For now, returning a mock template ID based on niche
    console.log(`Searching Canva templates for style: ${style}, niche: ${niche}`);
    if (niche.toLowerCase().includes('planner')) {
      return ['TEMPLATE_PLANNER_001', 'TEMPLATE_PLANNER_002'];
    } else if (niche.toLowerCase().includes('journal')) {
      return ['TEMPLATE_JOURNAL_001', 'TEMPLATE_JOURNAL_002'];
    }
    return ['TEMPLATE_GENERIC_001'];
  }
}

export const canvaService = new CanvaService();
