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
import { neuralBrowserService } from './neuralBrowserService.js';
import { neuralBrowserQueue } from './queueService.js';
import { dnaVaultService } from './dnaVaultService.js';
import { dnaLabService } from './dnaLabService.js';
import { marketIntelligenceService } from './marketIntelligenceService.js';
import { visualProxyService } from './visualProxyService.js';
import { uniquenessService } from './uniquenessService.js';
import { resolveModelForUser } from '../utils/resolveModel.js';
import { getMasterBriefing } from './strategicDirective.js';
import axios from 'axios';
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

      // 2. Scrape real-time signals via MarketIntelligence
      const realSignals = await this.getRealTimeSignals(userId, platform, niche);

      let storedCount = 0;

      // Process combined patterns and real signals
      const allTargets = [...discoveredPatterns, ...realSignals];

      for (const target of allTargets) {
        try {
          // 3. Anti-Copycat validation (dHash)
          if (target.imageUrl) {
            try {
              const response = await axios.get(target.imageUrl, { responseType: 'arraybuffer' });
              const buffer = Buffer.from(response.data, 'binary');
              const hash = await uniquenessService.generatePHash(buffer);
              
              // Check similarity in designHashes table
              const similarity = await uniquenessService.checkDesignSimilarity(hash);
              if (similarity > 85) {
                console.log(`[DnaHunt] Skipping copycat target: ${target.title} (Similarity: ${similarity}%)`);
                continue;
              }
              
              // Store hash for future reference
              await db.insert(schema.designHashes).values({
                id: uuidv4(),
                platform,
                externalId: target.externalId || target.url || target.title,
                hash,
                createdAt: new Date()
              });
            } catch (imgErr: any) {
              console.warn(`[DnaHunt] Image processing failed for ${target.title}:`, imgErr.message);
            }
          }

          const wvi = this.calculateWVI(target, platform);
          
          // 4. Extract detailed Style DNA via DnaLab
          const extractedDna = await dnaLabService.extractMarketDna(userId, platform, target);
          
          if (extractedDna) {
            // 5. Save to Global DNA Pool
            await dnaLabService.saveGlobalHarvest(extractedDna, niche || target.subCategory || 'digital products', platform, wvi);
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
      const query = niche || 'digital products';
      
      if (platform === 'etsy') return await marketIntelligenceService.fetchEtsyBestSellers(query, userId);
      if (platform === 'figma_community') return await marketIntelligenceService.fetchFigmaCommunityTrends(query, userId);
      if (platform === 'kittl') return await marketIntelligenceService.fetchKittlTrends(query, userId);
      if (platform === 'behance') return await marketIntelligenceService.fetchBehanceTrends(query, userId);
      if (platform === 'redbubble') return await marketIntelligenceService.fetchRedbubbleTrends(query, userId);
      if (platform === 'artstation') return await marketIntelligenceService.fetchArtStationTrends(query, userId);
      if (platform === 'substack') return await marketIntelligenceService.fetchSubstackTrends(query, userId);
      
      // Fallback for others
      if (platform === 'fiverr') {
        const results = await neuralBrowserService.executeAutomation(userId, [
          ...hunterGathererService['generateBrowserSteps']({
            platform: platform as any,
            objective: 'SEARCH_TRENDS',
            params: { query }
          })
        ]) as any;
        return results['.gig-card-layout'] || [];
      }
      
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
      
      let wvi = 50 + (bs * 20) + (bc * 1.5) + (Math.min(rTotal, 500) / 20);
      return Math.min(Math.round(wvi), 100);
    }
    
    if (platform === 'figma_community') {
      const d = target.signals?.duplicates || 0;
      const l = target.signals?.likes || 0;
      let wvi = 60 + (Math.min(d, 5000) / 200) + (Math.min(l, 1000) / 50);
      return Math.min(Math.round(wvi), 100);
    }

    if (platform === 'kittl') {
      const u = target.signals?.duplicates || 0;
      let wvi = 65 + (Math.min(u, 2000) / 100);
      if (target.signals?.isStaffPick) wvi += 15;
      return Math.min(Math.round(wvi), 100);
    }

    if (platform === 'behance') {
      const l = target.signals?.likes || 0;
      let wvi = 55 + (Math.min(l, 5000) / 250);
      if (target.signals?.isCurated) wvi += 25;
      return Math.min(Math.round(wvi), 100);
    }

    if (platform === 'redbubble') {
      return target.isBestSeller ? 95 : 75;
    }

    if (platform === 'artstation') {
      const l = target.signals?.likes || 0;
      const v = target.signals?.views || 0;
      let wvi = 60 + (Math.min(l, 1000) / 40) + (Math.min(v, 10000) / 500);
      return Math.min(Math.round(wvi), 100);
    }

    if (platform === 'substack') {
      const sub = target.signals?.subscribers || '';
      return sub.toLowerCase().includes('thousands') ? 92 : 75;
    }

    if (platform === 'fiverr') {
      let wvi = 60;
      // Pro/Verified bonus
      if (target.isPro || target.isVerified) wvi += 20;
      // Reviews bonus
      const rCount = parseInt(target.reviewsCount) || 0;
      wvi += Math.min(rCount / 10, 15);
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
        CRITICAL MARKET INTEL CONTEXT (Viral Signals):
        - Etsy: Look for "Bestseller" and "In X people's baskets".
        - Figma: Look for high duplicate/like counts.
        - Kittl: Look for high remix/use counts and Staff Picks.
        - Behance: Look for high appreciations and "Featured" badges.
        - Redbubble: Look for "Best Seller" badges.
        - ArtStation: Look for high likes and trending views.
        - Substack: Look for publications in the "thousands of subscribers" tier.

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
