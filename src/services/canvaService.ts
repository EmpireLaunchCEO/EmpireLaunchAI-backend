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
    console.log(`Searching Canva templates for style: \${style}, niche: \${niche}`);
    if (niche.toLowerCase().includes('planner')) {
      return ['TEMPLATE_PLANNER_001', 'TEMPLATE_PLANNER_002'];
    } else if (niche.toLowerCase().includes('journal')) {
      return ['TEMPLATE_JOURNAL_001', 'TEMPLATE_JOURNAL_002'];
    }
    return ['TEMPLATE_GENERIC_001'];
  }

  /**
   * Deep DNA Extraction: Brand Kits
   */
  async extractBrandKitDna(userId: string) {
    const credentials = await integrationService.getCredentials(userId, 'canva');
    if (!credentials || !credentials.accessToken) {
      throw new Error('No Canva credentials found');
    }

    try {
        // In production: GET /v1/brand-kits
        const response = await axios.get(`\${this.baseUrl}/brand-kits`, {
            headers: { Authorization: `Bearer \${credentials.accessToken}` }
        });
        
        const kits = response.data.brand_kits || [];
        const strands = [];

        for (const kit of kits) {
            // Extract Colors
            if (kit.colors) {
                for (const palette of kit.colors) {
                    strands.push({
                        category: 'palette' as any,
                        subCategory: kit.name,
                        manifest: { colors: palette.colors, name: palette.name },
                        performanceScore: 90,
                        sourcePlatform: 'canva',
                        isGlobal: false,
                        metadata: { userId, kitId: kit.id, type: 'brand_kit_palette' }
                    });
                }
            }
            // Extract Fonts
            if (kit.fonts) {
                strands.push({
                    category: 'typography' as any,
                    subCategory: kit.name,
                    manifest: { fonts: kit.fonts },
                    performanceScore: 90,
                    sourcePlatform: 'canva',
                    isGlobal: false,
                    metadata: { userId, kitId: kit.id, type: 'brand_kit_fonts' }
                });
            }
        }
        return strands;
    } catch (e: any) {
        console.warn(`[CanvaService] Brand kit extraction failed: \${e.message}. Using fallback.`);
        return [
            {
                category: 'palette' as any,
                subCategory: 'Default Brand Kit',
                manifest: { colors: ['#000000', '#FFFFFF', '#00C4CC'], name: 'Canva Colors' },
                performanceScore: 85,
                sourcePlatform: 'canva',
                isGlobal: false,
                metadata: { userId, type: 'brand_kit_palette' }
            }
        ];
    }
  }

  /**
   * Deep DNA Extraction: Designs
   */
  async extractUserDesignDna(userId: string, limit: number = 5) {
    const credentials = await integrationService.getCredentials(userId, 'canva');
    if (!credentials || !credentials.accessToken) {
        throw new Error('No Canva credentials found');
    }

    try {
        // In production: GET /v1/designs
        const response = await axios.get(`\${this.baseUrl}/designs?limit=\${limit}`, {
            headers: { Authorization: `Bearer \${credentials.accessToken}` }
        });

        const designs = response.data.items || [];
        const strands = [];

        for (const design of designs) {
            // In a real flow, we might fetch design details or use a thumbnail for analysis
            strands.push({
                category: 'layout' as any,
                subCategory: design.title,
                manifest: { title: design.title, thumbnail: design.thumbnail?.url },
                performanceScore: 80,
                sourcePlatform: 'canva',
                externalId: design.id,
                isGlobal: false,
                metadata: { userId, type: 'user_design' }
            });
        }
        return strands;
    } catch (e: any) {
        console.warn(`[CanvaService] Design extraction failed: \${e.message}`);
        return [];
    }
  }
}

export const canvaService = new CanvaService();
