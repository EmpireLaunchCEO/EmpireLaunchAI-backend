import { db, schema } from '../db/index.js';
import { campaigns, scheduledPosts } from '../db/sqlite-schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { canvaService } from './canvaService.js';
import { aiScriptingService } from './aiScriptingService.js';
import { distributionQueue } from './queueService.js';
import { notificationService } from './notificationService.js';
import { webSocketService } from './websocketService.js';

export interface StyleDNA {
  colors: string[];
  fonts: string[];
  pacing: 'slow' | 'medium' | 'fast';
  hooks: string[];
  visualAesthetic: string;
}

export interface CreationRequest {
  userId: string;
  campaignId: string;
  niche: string;
  productName: string;
  platforms: string[];
}

export class CreationEngine {
  /**
   * Main entry point to generate a campaign's master asset and queue distribution.
   */
  async generateMasterAsset(request: CreationRequest) {
    const { userId, campaignId, niche, productName, platforms } = request;
    console.log(`[CreationEngine] Generating master asset for campaign ${campaignId}...`);

    webSocketService.notifyUser(userId, 'ai-log', { message: `[STUDIO] Initializing master asset generation for ${productName}...` });

    // 1. Generate/Retrieve Style DNA
    const styleDna = await this.generateStyleDNA(niche, productName);
    
    // 2. Update Campaign with Style DNA
    await db.update(campaigns)
      .set({ styleDna, updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));

    // 3. Generate Design Blueprint parameterized with DNA
    const blueprint = await aiScriptingService.generateDesignBlueprint({
      businessNiche: niche,
      userGoal: `Create a high-converting asset for ${productName} with ${styleDna.visualAesthetic} aesthetic.`,
      productName: productName,
      customerInquiry: `Style DNA: Colors(${styleDna.colors.join(',')}), Fonts(${styleDna.fonts.join(',')}), Pacing(${styleDna.pacing})`
    });

    webSocketService.notifyUser(userId, 'ai-log', { message: `[STUDIO] Design blueprint generated. Selecting best-fit templates...` });

    // 4. Select and Autofill Canva Template (Mocked single video source logic)
    // In a real implementation, we would call an AI agent to select the template
    const templates = await canvaService.searchTemplates(userId, styleDna.visualAesthetic, niche);
    const masterTemplateId = templates[0];

    const designId = await canvaService.autofillDesign(userId, masterTemplateId, {
      title: productName,
      dna_colors: styleDna.colors,
      dna_fonts: styleDna.fonts,
      hook: styleDna.hooks[0]
    });

    webSocketService.notifyUser(userId, 'ai-log', { message: `[STUDIO] Master asset created. Exporting and synchronizing...` });

    // 5. Export Master Asset
    const masterAssetUrl = await canvaService.exportDesign(userId, designId);

    // 6. Update Campaign with Master Asset URL
    await db.update(campaigns)
      .set({ masterAssetUrl, updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));

    // 7. Populate Multi-Platform Distribution Queue
    await this.queueMultiPlatformDistribution(userId, campaignId, masterAssetUrl, platforms, productName);

    webSocketService.notifyUser(userId, 'ai-log', { message: `[STUDIO] Multi-platform distribution queued successfully.` });
    
    return { masterAssetUrl, styleDna };
  }

  private async generateStyleDNA(niche: string, productName: string): Promise<StyleDNA> {
    // Simple logic for prototype, would be an LLM call in production
    return {
      colors: ['#FF5733', '#C70039', '#900C3F'],
      fonts: ['Montserrat', 'Open Sans'],
      pacing: 'medium',
      hooks: [`Unlock the secret to ${niche} success!`],
      visualAesthetic: 'Minimalist Modern'
    };
  }

  private async queueMultiPlatformDistribution(
    userId: string, 
    campaignId: string, 
    assetUrl: string, 
    platforms: string[],
    productName: string
  ) {
    for (const platform of platforms) {
      const postId = uuidv4();
      
      // 1. Create Scheduled Post entry
      await db.insert(scheduledPosts).values({
        id: postId,
        campaignId,
        platform: platform.toLowerCase(),
        content: {
          videoUrl: assetUrl,
          title: productName,
          caption: `Elevate your ${productName} game! #empire #launch`
        },
        scheduledFor: new Date(), // Immediate for this flow or based on campaign frequency
        status: 'approved', // Auto-approved for this flow or pending if required
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // 2. Add to Distribution Queue
      await distributionQueue.add(`distribute-${platform}-${postId}`, {
        postId,
        userId,
        platform: platform.toLowerCase(),
        content: {
          videoUrl: assetUrl,
          title: productName,
          caption: `Elevate your ${productName} game! #empire #launch`
        }
      });

      console.log(`[CreationEngine] Queued ${platform} distribution for post ${postId}`);
    }
  }
}

export const creationEngine = new CreationEngine();
