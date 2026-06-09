import { db, schema } from '../db/index.js';
const { campaigns, scheduledPosts } = schema;
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { canvaService } from './canvaService.js';
import { aiScriptingService } from './aiScriptingService.js';
import { distributionQueue } from './queueService.js';
import { notificationService } from './notificationService.js';
import { webSocketService } from './websocketService.js';
import { dnaLabService } from './dnaLabService.js';
import { resolveModelForUser, resolveStudioReasoner } from '../utils/resolveModel.js';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { JsonOutputParser } from '@langchain/core/output_parsers';

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

    webSocketService.notifyUser(userId, 'ai-log', { message: `🎬 [STUDIO] Initializing master asset generation for ${productName}...` });

    // 1. Generate/Retrieve Style DNA
    const styleDna = await this.generateStyleDNA(userId, campaignId, niche, productName);
    
    // 2. Update Campaign with Style DNA
    await db.update(campaigns)
      .set({ styleDna, updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));

    // 3. Generate Design Blueprint parameterized with DNA (Uses High-Intelligence Studio Reasoner)
    const blueprint = await aiScriptingService.generateDesignBlueprint({
      userId,
      businessNiche: niche,
      userGoal: `Create a high-converting asset for ${productName} with ${styleDna.visualAesthetic} aesthetic.`,
      productName: productName,
      customerInquiry: `Style DNA: Colors(${styleDna.colors.join(',')}), Fonts(${styleDna.fonts.join(',')}), Pacing(${styleDna.pacing})`
    });

    webSocketService.notifyUser(userId, 'ai-log', { message: `🧠 [STUDIO] Intel Layer: Design blueprint generated via High-Reasoning model.` });

    // 4. Select and Autofill Canva Template
    const templates = await canvaService.searchTemplates(userId, styleDna.visualAesthetic, niche);
    const masterTemplateId = templates[0];

    const designId = await canvaService.autofillDesign(userId, masterTemplateId, {
      title: productName,
      dna_colors: styleDna.colors,
      dna_fonts: styleDna.fonts,
      hook: styleDna.hooks[0]
    });

    webSocketService.notifyUser(userId, 'ai-log', { message: `🎨 [STUDIO] Master asset created. Exporting and synchronizing...` });

    // 5. Export Master Asset
    const masterAssetUrl = await canvaService.exportDesign(userId, designId);

    // 6. Update Campaign with Master Asset URL
    await db.update(campaigns)
      .set({ masterAssetUrl, updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));

    // 7. Populate Multi-Platform Distribution Queue
    await this.queueMultiPlatformDistribution(userId, campaignId, masterAssetUrl, platforms, productName);

    webSocketService.notifyUser(userId, 'ai-log', { message: `✅ [STUDIO] Multi-platform distribution queued successfully.` });
    
    return { masterAssetUrl, styleDna };
  }

  private async generateStyleDNA(userId: string, campaignId: string, niche: string, productName: string): Promise<StyleDNA> {
    // 1. Check for viral links in campaign
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    const viralLinks = campaign?.viralLinks ? JSON.parse(campaign.viralLinks as string) : [];

    if (Array.isArray(viralLinks) && viralLinks.length > 0) {
      console.log(`[CreationEngine] Found ${viralLinks.length} viral links. Harvesting Style DNA...`);
      webSocketService.notifyUser(userId, 'ai-log', { message: `🧬 [STUDIO] Viral links detected. Harvesting Style DNA from ${viralLinks[0]}...` });
      
      try {
        const { dnaProfile } = await dnaLabService.processViralContent(userId, 'tiktok', viralLinks[0]);
        
        return {
          colors: dnaProfile.visual_identity.primary_palette,
          fonts: [dnaProfile.visual_identity.typography_signature.family],
          pacing: dnaProfile.visual_identity.pacing as any,
          hooks: [dnaProfile.narrative_dna.hook_style],
          visualAesthetic: dnaProfile.visual_identity.pacing // Using pacing as aesthetic placeholder
        };
      } catch (e) {
        console.warn('[CreationEngine] DNA harvesting failed, falling back to AI synthesis:', (e as Error).message);
      }
    }

    // Fallback to AI-powered StyleDNA generation (Uses Gemini 3 Flash logic)
    try {
      const model = await resolveStudioReasoner();

      const template = `
        You are the Empire Studio Intelligence Layer (Style DNA Architect). 
        Generate a StyleDNA for a digital product in the "{niche}" niche called "{productName}".

        Return JSON:
        - colors: string[] (3 hex color codes that define the brand)
        - fonts: string[] (2 Google Font names)
        - pacing: "slow" | "medium" | "fast"
        - hooks: string[] (2 attention-grabbing hooks for social media)
        - visualAesthetic: string (e.g. "Minimalist Modern", "Bold Vibrant", "Earthy Natural")
      `;

      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);

      const parsed = await chain.invoke({ niche, productName }) as any;
      if (parsed.colors && parsed.fonts && parsed.visualAesthetic) {
        console.log(`[CreationEngine] High-Intelligence StyleDNA generated for "${productName}"`);
        return parsed as StyleDNA;
      }
    } catch (e) {
      console.warn('[CreationEngine] High-Intelligence StyleDNA generation failed:', (e as Error).message);
    }

    // Smart fallback based on niche keywords
    const niche_lower = niche.toLowerCase();
    let defaultStyle: StyleDNA;
    
    if (niche_lower.includes('minimal') || niche_lower.includes('clean')) {
      defaultStyle = {
        colors: ['#F5F5F0', '#2C2C2C', '#8E8E8E'],
        fonts: ['Inter', 'Playfair Display'],
        pacing: 'slow',
        hooks: [`Clean design meets ${niche} functionality.`, `Simplify your ${niche} workflow today.`],
        visualAesthetic: 'Minimalist Modern',
      };
    } else {
      defaultStyle = {
        colors: ['#FF5733', '#C70039', '#900C3F'],
        fonts: ['Montserrat', 'Open Sans'],
        pacing: 'medium',
        hooks: [`Unlock the secret to ${niche} success!`, `Transform your ${niche} journey today.`],
        visualAesthetic: 'Dynamic Professional',
      };
    }
    
    return defaultStyle;
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
      
      await db.insert(scheduledPosts).values({
        id: postId,
        campaignId,
        platform: platform.toLowerCase(),
        content: {
          videoUrl: assetUrl,
          title: productName,
          caption: `Elevate your ${productName} game! #empire #launch`
        },
        scheduledFor: new Date(),
        status: 'approved',
        createdAt: new Date(),
        updatedAt: new Date()
      });

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
    }
  }
}

export const creationEngine = new CreationEngine();
