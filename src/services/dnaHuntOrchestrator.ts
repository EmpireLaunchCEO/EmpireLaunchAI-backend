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
      webSocketService.notifyUser(userId, 'ai-log', { message: `[DNA-HUNT] Researching viral signals for ${niche} on ${platform}...` });
      
      // 1. Research patterns via LLM with updated context
      const discoveredPatterns = await this.researchPlatformPatterns(niche || 'digital products', platform);
      
      // 2. Scrape real-time signals via HunterGatherer
      const realSignals = await this.getRealTimeSignals(userId, platform, niche);
      
      let storedCount = 0;
      
      // Process combined patterns and real signals
      const allTargets = [...discoveredPatterns, ...realSignals];
      
      for (const target of allTargets) {
        try {
          const wvi = this.calculateWVI(target, platform);
          const strand = await this.extractDnaFromPattern(target, platform, niche, wvi);
          
          if (strand) {
            await dnaVaultService.storeStrand(strand);
            storedCount++;
          }
        } catch (err) {
          console.error(`[DnaHunt] Failed to process target:`, err);
        }
      }
      
      return { strandsStored: storedCount };
    } catch (error) {
      console.error(`[DnaHunt] Execute hunt failed:`, error);
      throw error;
    }
  }

  private async getRealTimeSignals(userId: string, platform: string, niche?: string): Promise<any[]> {
    try {
      const results = await neuralBrowserService.executeAutomation(userId, [
        ...hunterGathererService['generateBrowserSteps']({
          platform: platform as any,
          objective: 'SEARCH_TRENDS',
          params: { query: niche }
        })
      ]) as any;

      // Extract listings based on platform
      if (platform === 'etsy') return results['.v2-listing-card'] || [];
      if (platform === 'fiverr') return results['.gig-card-layout'] || [];
      
      return [];
    } catch (e) {
      console.warn(`[DnaHunt] Real-time signal gathering failed for ${platform}:`, e);
      return [];
    }
  }

  private calculateWVI(target: any, platform: string): number {
    if (platform === 'etsy') {
      const bs = (target.isBestSeller && target.isBestSeller !== '') ? 1 : 0;
      const bcStr = target.inBasket || '0';
      const bcMatch = bcStr.match(/In\s+(\d+)\+?\s+people/i);
      const bc = bcMatch ? Math.min(parseInt(bcMatch[1]), 20) : 0;
      
      const rTotalMatch = (target.reviewsCount || '0').match(/(\d[\d,]*)/);
      const rTotal = rTotalMatch ? parseInt(rTotalMatch[1].replace(/,/g, '')) : 0;
      const r30 = Math.ceil(rTotal * 0.05); 
      
      let wvi = (bs * 40) + (bc * 2) + (r30 * 3) + (Math.log10(Math.max(rTotal, 1)) * 2);
      
      // Bonus for urgency signals
      if (target.inBasket?.toLowerCase().includes('popular now')) wvi += 10;
      if (target.inBasket?.toLowerCase().includes('rare find')) wvi += 5;

      return Math.min(Math.round(wvi), 100);
    }

    if (platform === 'fiverr') {
      const qMatch = (target.ordersInQueue || '0').match(/(\d+)/);
      const q = qMatch ? parseInt(qMatch[1]) : 0;
      
      const slStr = target.sellerLevel || '';
      let sl = 0;
      if (slStr.toLowerCase().includes('top rated')) sl = 3;
      else if (slStr.toLowerCase().includes('level 2')) sl = 2;
      else if (slStr.toLowerCase().includes('level 1')) sl = 1;
      
      const rating = parseFloat(target.rating) || 0;
      
      const rTotalMatch = (target.reviewsCount || '0').match(/(\d[\d,]*)/);
      const rTotal = rTotalMatch ? parseInt(rTotalMatch[1].replace(/,/g, '')) : 0;
      
      let wvi = (q * 5) + (sl * 10) + (rating * 5) + (Math.log10(Math.max(rTotal, 1)) * 2);
      
      // Bonus for Fiverr Choice
      if (target.isFiverrChoice && target.isFiverrChoice !== '') wvi += 15;

      return Math.min(Math.round(wvi), 100);
    }

    return target.performanceScore || 70;
  }

  private async researchPlatformPatterns(niche: string, platform: string): Promise<any[]> {
    try {
      const model = await resolveModelForUser(); 
      const masterBriefing = getMasterBriefing({ niche, goal: 'Market Trend Analysis', userTier: 'Trend Research Agent' });
      
      const template = `
        ${masterBriefing}
        
        CRITICAL MARKET INTEL CONTEXT (Etsy/Fiverr Viral Signals):
        - Etsy Winners: Digital planners, Notion templates, Canva kits ($3-$25). Look for "Bestseller" badges and "In X people's baskets" (>20 is viral).
        - Fiverr Winners: Custom Canva templates, ebook design, KDP planners. Look for high "Orders in Queue" (>13 is viral) and Top Rated/Level 2 sellers.
        
        Task: Analyze {platform} for the {niche} niche based on these viral signals.
        Identify top-performing patterns (best-sellers, viral hooks, high-converting layouts).
        
        Return JSON array of objects: 
        - title: Name of the trend/pattern
        - category: Broad category
        - subCategory: Narrow category
        - description: Strategic reasoning for why this works
        - performanceScore: 0-100 base score
        - manifest: JSON object containing 'dna_elements' (colors, keywords, flow)
        - viralMetrics: {
            "isBestseller": boolean,
            "basketCount": number,
            "ordersInQueue": number,
            "totalReviews": number,
            "rating": number,
            "sellerLevel": number
          }
      `;
      
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      const result = await chain.invoke({ niche, platform }) as any;
      return Array.isArray(result) ? result : [];
    } catch (e) {
      return [];
    }
  }

  private async extractDnaFromPattern(pattern: any, platform: string, niche?: string, performanceScore?: number): Promise<any> {
    try {
      const model = await resolveModelForUser();
      const masterBriefing = getMasterBriefing({ niche, goal: 'DNA Extraction', userTier: 'Intel Architect' });

      const template = `
        ${masterBriefing}
        
        Task: Extract the 'Core DNA' from the pattern: {title}.
        
        Anti-Copycat Guidelines:
        1. Identification: Identify what makes this pattern high-performing (palette, typography, layout).
        2. Synthesis: Create a technically unique 'Logic Manifest' that captures the conversion magic but shifts themes (e.g., if source is Boho, synthesis should be Minimalist or Brutalist).
        3. Perceptual Pivot: Ensure typography and layout grids are shuffled to avoid direct duplication.
        
        Return JSON: 
        - manifest: The logic manifest for remaking this (colors, fonts, layout complexity)
        - metadata: Technical details (tags, vibe)
        - synthesisPrompt: A text-to-image prompt to generate an ORIGINAL preview image for this DNA.
      `;
      
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      const enrichment = await chain.invoke({ title: pattern.title }) as any;
      
      return {
        category: pattern.category || 'layout',
        subCategory: pattern.subCategory,
        embedding: Array.from({ length: 128 }, () => Math.random()), // In production, generate real embedding
        manifest: enrichment.manifest || pattern.manifest,
        performanceScore: performanceScore || pattern.performanceScore || 70,
        sourcePlatform: platform,
        isSynthesized: true,
        synthesisPrompt: enrichment.synthesisPrompt,
        metadata: {
          ...enrichment.metadata,
          originalTitle: pattern.title,
          viralMetrics: pattern.viralMetrics || {},
          harvestedAt: new Date().toISOString()
        },
      };
    } catch (e) {
      return null;
    }
  }
}

export const dnaHuntOrchestrator = new DnaHuntOrchestrator();
