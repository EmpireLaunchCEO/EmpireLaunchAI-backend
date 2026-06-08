import { hunterGathererService, CreatorObjective } from './hunterGathererService.js';
import { webSocketService } from './websocketService.js';
import { notificationService } from './notificationService.js';
import { dnaVaultService, DnaStrand } from './dnaVaultService.js';
import { visualProxyService } from './visualProxyService.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Content Creator Bridge
 * 
 * Hybrid API/Browser Switchboard for creative platforms (Kittl, Canva, CapCut).
 * These platforms don't offer comprehensive OAuth APIs for design operations,
 * so we use a browser automation approach with the Neural Browser Worker.
 * 
 * Principles:
 * - Free First: Always prioritize free-tier templates/features before paid
 * - Anti-Copycat: Extract DNA parameters only, never save source images
 * - Zero-Source-Image: Generated previews are AI-synthesized, not source copies
 */

export type CreatorPlatform = 'canva' | 'kittl' | 'capcut';

export interface CreatorJob {
  jobId: string;
  userId: string;
  platform: CreatorPlatform;
  objective: CreatorObjective;
  niche: string;
  styleDna?: any;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  createdAt: Date;
}

export class ContentCreatorBridge {

  /**
   * Orchestrate a full design flow on a creator platform.
   * 1. SEARCH for free templates in the niche
   * 2. APPLY DNA parameters (colors, fonts, pacing)
   * 3. EXPORT the final design
   * 4. Store the DNA strand (not the image) in the Vault
   * 5. Generate an AI-Synthesized preview for the gallery
   */
  async executeDesignFlow(
    userId: string,
    platform: CreatorPlatform,
    niche: string,
    styleDna?: any
  ) {
    const jobId = uuidv4();
    console.log(`[ContentCreatorBridge] Starting ${platform} flow for ${niche} (job ${jobId})`);

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🎨 ${platform}: Searching free templates for "${niche}"...`
    });

    try {
      // Phase 1: Free-First Template Search
      const templatesResult: any = await this.searchFreeTemplates(userId, platform, niche);
      const templates: any[] = templatesResult?.templates || [];
      
      if (!templates || templates.length === 0) {
        throw new Error(`No free templates found for ${niche} on ${platform}`);
      }

      webSocketService.notifyUser(userId, 'ai-log', {
        message: `🔍 ${platform}: Found ${templates.length} free templates. Selecting best match...`
      });

      // Phase 2: Apply DNA to best template
      const templateList = templates as any;
      const bestTemplateId = templateList[0]?.id || templateList[0]?.url?.split('/').pop();
      if (!bestTemplateId) throw new Error('Could not determine template ID');

      const appliedDna = styleDna || await this.resolveDnaForNiche(userId, niche);
      
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `🧬 ${platform}: Applying Style DNA to template...`
      });

      await this.applyDnaToDesign(userId, platform, bestTemplateId, appliedDna);

      // Phase 3: Export the final design
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `📤 ${platform}: Exporting final design...`
      });

      const exportResult = await this.exportDesign(userId, platform, bestTemplateId) as any;

      // Phase 4: Store DNA strand in Vault (NOT the exported image)
      const dnaStrand: DnaStrand = {
        category: 'layout',
        subCategory: platform,
        manifest: {
          ...appliedDna,
          templateId: bestTemplateId,
          platform,
          niche,
          generationMethod: 'free_tier_browser',
          sourceImageDiscarded: true,
        },
        performanceScore: 75,
        sourcePlatform: platform,
        metadata: {
          tags: [niche, platform, 'free-tier', 'ai-synthesized'],
          brandTrait: 'content_creator',
          originalityBadge: 'ai-synthesized',
          sourceImageDiscarded: true,
        },
        isSynthesized: true,
      };

      const strandId = await dnaVaultService.storeStrand(dnaStrand);

      // Phase 5: Generate AI-Synthesized preview
      const visualSummary = await visualProxyService.summarizeStrand(userId, dnaStrand);

      webSocketService.notifyUser(userId, 'ai-log', {
        message: `✅ ${platform} design flow complete! DNA stored in Vault.`
      });

      await notificationService.notifyUser(
        userId,
        `🎨 ${platform} design created for "${niche}". AI-Synthesized preview ready.`,
        false
      );

      return {
        jobId,
        platform,
        niche,
        templateId: bestTemplateId,
        exportUrl: exportResult?.url || exportResult?.exportUrl,
        strandId,
        visualSummary,
        status: 'completed',
      };
    } catch (error: any) {
      console.error(`[ContentCreatorBridge] ${platform} flow failed:`, error.message);
      
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `❌ ${platform} flow failed: ${error.message}. Switching to manual assisted mode.`
      });

      await notificationService.notifyUser(
        userId,
        `${platform} design encountered an issue: ${error.message}. Manual mode available.`,
        true
      );

      return {
        jobId,
        platform,
        niche,
        status: 'failed',
        error: error.message,
      };
    }
  }

  /**
   * Phase 1: Search for free templates using the browser agent.
   * Free First protocol: only free-tier templates are fetched.
   */
  private async searchFreeTemplates(userId: string, platform: CreatorPlatform, niche: string) {
    const result = await hunterGathererService.triggerHarvesting(userId, {
      platform,
      objective: 'SEARCH_TEMPLATES',
      params: { niche },
    });
    return result;
  }

  /**
   * Phase 2: Apply DNA parameters to a design via browser automation.
   */
  private async applyDnaToDesign(userId: string, platform: CreatorPlatform, designId: string, dna: any) {
    return hunterGathererService.triggerHarvesting(userId, {
      platform,
      objective: 'APPLY_DNA',
      params: { designId, ...dna },
    });
  }

  /**
   * Phase 3: Export the final design.
   */
  private async exportDesign(userId: string, platform: CreatorPlatform, designId: string) {
    return hunterGathererService.triggerHarvesting(userId, {
      platform,
      objective: 'EXPORT_DESIGN',
      params: { designId },
    });
  }

  /**
   * Resolve default DNA parameters for a niche when no custom DNA is provided.
   */
  private async resolveDnaForNiche(userId: string, niche: string) {
    // Query vault for relevant strands
    const strands = await dnaVaultService.findTopPerformers('palette', 70, 3);
    const colors = strands.map(s => s.manifest?.primary).filter(Boolean).slice(0, 3);
    
    return {
      colors: colors.length >= 3 ? colors : ['#1a1a2e', '#e94560', '#0f3460'],
      fontFamily: 'Inter',
      pacing: 'moderate',
      niche,
    };
  }
}

export const contentCreatorBridge = new ContentCreatorBridge();