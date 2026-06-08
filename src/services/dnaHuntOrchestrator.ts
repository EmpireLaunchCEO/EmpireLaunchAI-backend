import { db, schema } from '../db/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { webSocketService } from './websocketService.js';
import { notificationService } from './notificationService.js';
import { integrationService } from './integrationService.js';
import { hunterGathererService } from './hunterGathererService.js';
import { neuralBrowserQueue } from './queueService.js';
import { dnaVaultService } from './dnaVaultService.js';
import { marketIntelligenceService } from './marketIntelligenceService.js';
import { visualProxyService } from './visualProxyService.js';
import { resolveModelForUser } from '../utils/resolveModel.js';
import { getMasterBriefing } from './strategicDirective.js';
import dotenv from 'dotenv';

dotenv.config();

export class DnaHuntOrchestrator {
  async triggerHunt(userId: string, platform: string, niche?: string): Promise<{ huntId: string; status: string }> {
    const huntId = uuidv4();
    webSocketService.notifyUser(userId, 'ai-log', { message: `[DNA-HUNT] Initializing hunt on ${platform}...` });
    await neuralBrowserQueue.add('dna-hunt-auto', { huntId, userId, platform, niche });
    return { huntId, status: 'queued' };
  }

  async executeHunt(huntId: string, userId: string, platform: string, niche?: string): Promise<{ strandsStored: number }> {
    try {
      const discoveredPatterns = await this.researchPlatformPatterns(niche || 'digital products', platform);
      let storedCount = 0;
      for (const pattern of discoveredPatterns) {
        try {
          const strand = await this.extractDnaFromPattern(pattern, platform, niche);
          if (strand) {
            await dnaVaultService.storeStrand(strand);
            storedCount++;
          }
        } catch (err) {}
      }
      return { strandsStored: storedCount };
    } catch (error) {
      throw error;
    }
  }

  private async researchPlatformPatterns(niche: string, platform: string): Promise<any[]> {
    try {
      const model = await resolveModelForUser(); 
      const masterBriefing = getMasterBriefing({ niche, goal: 'Market Trend Analysis', userTier: 'Trend Research Agent' });
      
      const template = `
        ${masterBriefing}
        
        Task: Analyze {platform} for the {niche} niche. 
        Identify top-performing patterns (best-sellers, viral hooks, high-converting layouts).
        
        Return JSON array of objects: 
        - title: Name of the trend/pattern
        - category: Broad category
        - subCategory: Narrow category
        - description: Strategic reasoning for why this works
        - estimatedPerformance: 0-100 score
        - manifest: JSON object containing 'dna_elements' (colors, keywords, flow)
      `;
      
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      const result = await chain.invoke({ niche, platform }) as any;
      return Array.isArray(result) ? result : [];
    } catch (e) {
      return [];
    }
  }

  private async extractDnaFromPattern(pattern: any, platform: string, niche?: string): Promise<any> {
    try {
      const model = await resolveModelForUser();
      const masterBriefing = getMasterBriefing({ niche, goal: 'DNA Extraction', userTier: 'Intel Architect' });

      const template = `
        ${masterBriefing}
        
        Task: Extract the 'Core DNA' from the pattern: {title}.
        
        Guidelines:
        - Identify what makes this pattern high-performing.
        - Strategic Logic: Remake a similar version that captures the 'Magic' but is technically unique to avoid copycatting.
        
        Return JSON: 
        - manifest: The logic manifest for remaking this
        - metadata: Technical details
        - performanceScore: 0-100
      `;
      
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      const enrichment = await chain.invoke({ title: pattern.title }) as any;
      return {
        category: pattern.category,
        subCategory: pattern.subCategory,
        embedding: Array.from({ length: 128 }, () => Math.random()),
        manifest: enrichment.manifest || pattern.manifest,
        performanceScore: enrichment.performanceScore || 70,
        sourcePlatform: platform,
        isSynthesized: true,
        metadata: enrichment.metadata || {},
      };
    } catch (e) {
      return null;
    }
  }
}

export const dnaHuntOrchestrator = new DnaHuntOrchestrator();
