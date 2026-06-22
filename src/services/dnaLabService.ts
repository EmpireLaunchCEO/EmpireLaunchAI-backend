import { db, schema } from '../db/index.js';
const { dnaStrands, stylePreviews } = schema;
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { resolveModelForUser, getDefaultModel } from '../utils/resolveModel.js';
import { getMasterBriefing } from './strategicDirective.js';
import { dnaVaultService } from './dnaVaultService.js';
import dotenv from 'dotenv';

dotenv.config();

export class DnaLabService {
  private async getModel(userId?: string): Promise<BaseChatModel> {
    return userId ? await resolveModelForUser(userId) : getDefaultModel();
  }

  /**
   * Analyzes video transcripts and engagement data to extract "Narrative DNA".
   */
  async extractNarrativeDna(userId: string, transcript: string, pacing: string = 'dynamic') {
    console.log(`[DnaLab] Extracting Narrative DNA for user ${userId}`);
    const activeModel = await this.getModel(userId);

    const template = `
      You are the Empire Studio Script Architect.
      Analyze this video transcript and extract its "Narrative DNA".
      
      Transcript: {transcript}
      Pacing Preference: {pacing}

      Return ONLY a JSON object:
      {{
        "hook_style": "direct_question | visual_shock | story_start",
        "cta_pattern": "link_in_bio | follow_for_more | check_comments",
        "pacing_curve": "high_start_stable_mid | consistent_high | slow_build"
      }}
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      activeModel,
      new JsonOutputParser(),
    ]);

    try {
      return await chain.invoke({ transcript, pacing });
    } catch (error) {
      console.error('[DnaLab] Narrative analysis failed, using default');
      return {
        hook_style: "story_start",
        cta_pattern: "link_in_bio",
        pacing_curve: "high_start_stable_mid"
      };
    }
  }

  /**
   * Processes a market listing/gig to extract Style DNA based on viral signals.
   */
  async extractMarketDna(userId: string, platform: string, rawData: any) {
    console.log(`[DnaLab] Extracting Market DNA for user ${userId} on ${platform}`);
    const activeModel = await this.getModel(userId);
    const masterBriefing = getMasterBriefing({ niche: rawData.niche || 'digital products', goal: 'Market Style Extraction', userTier: 'Intel Architect' });

    const template = `
      ${masterBriefing}
      Task: Extract high-fidelity Style DNA from this ${platform} listing:
      Title: {title}
      Raw Data: {rawData}

      Requirements:
      1. Identify the core color palette (hex codes).
      2. Identify typography (header/body fonts).
      3. Categorize layout complexity.
      4. Extract key copywriting triggers.

      CRITICAL: Apply the Anti-Copycat Rule.
      - The goal is to capture the "conversion magic" but ensure the resulting DNA manifest is technically unique.
      - If the source uses a "Boho" style, the synthesis should pivot to "Minimalist" or "Brutalist".
      - Shuffle layout grids and typography pairings to avoid direct replication.

      Return ONLY a JSON object matching this schema:
      {{
        "colorPalette": ["#hex1", "#hex2", "#hex3"],
        "typography": {{ "headerFont": "string", "bodyFont": "string", "fontVibe": "string" }},
        "layoutComplexity": "minimalist | structured_grid | organic_boho | retro_maximalist",
        "keyCopywritingTriggers": ["string"]
      }}
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([prompt, activeModel, new JsonOutputParser()]);

    try {
      const styleDna = await chain.invoke({ title: rawData.title, rawData: JSON.stringify(rawData) });
      return styleDna;
    } catch (error) {
      console.error('[DnaLab] Market DNA extraction failed:', error);
      throw error;
    }
  }

  /**
   * Processes viral content URL to extract comprehensive DNA profile.
   */
  async processViralContent(userId: string, platform: string, url: string) {
    console.log(`[DnaLab] Processing viral content DNA from ${url} for user ${userId}`);
    // This is a placeholder for the actual implementation which would use computer vision/audio analysis
    return {
      dnaProfile: {
        visual_identity: {
          primary_palette: ['#FF5733', '#C70039', '#900C3F'],
          typography_signature: { family: 'Montserrat', weight: 'bold' },
          pacing: 'medium'
        },
        narrative_dna: {
          hook_style: 'visual_shock',
          cta_pattern: 'link_in_bio'
        }
      }
    };
  }

  /**
   * Persists extracted Market DNA with a global visibility flag.
   */
  async saveGlobalHarvest(dna: any, niche: string, platform: string, performanceScore: number = 85, externalId?: string) {
    console.log(`[DnaLab] Saving global harvest for niche ${niche} from ${platform}`);
    
    const strand = {
      category: 'layout' as any, // Defaulting to layout for market DNA
      subCategory: niche,
      embedding: Array.from({ length: 128 }, () => Math.random()), // Mock embedding for prototype
      manifest: dna,
      performanceScore,
      sourcePlatform: platform,
      externalId,
      isGlobal: true,
      isSynthesized: true,
      metadata: {
        harvestedAt: new Date().toISOString(),
        originalNiche: niche,
        type: 'market_harvest'
      }
    };

    return dnaVaultService.storeStrand(strand);
  }
}

export const dnaLabService = new DnaLabService();
