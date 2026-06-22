import sharp from 'sharp';
import blockhash from 'blockhash';
import { db, schema } from '../db/index.js';
import { and, eq, sql } from 'drizzle-orm';
import { resolveStudioReasoner } from '../utils/resolveModel.js';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { JsonOutputParser } from '@langchain/core/output_parsers';

export interface UniquenessResult {
  isUnique: boolean;
  geometricScore: number; // 0 to 100, 100 = identical
  semanticScore: number;  // 0 to 100
  reasoning: string;
}

export class UniquenessService {
  /**
   * Triple-Gate Uniqueness Validation:
   * 1. Geometric (dHash): Structural similarity check.
   * 2. Semantic (Context): Checks if the "idea" is too similar to existing vault assets.
   * 3. Content (LLM): Final high-reasoning check for "anti-copycat" compliance.
   */
  async validateUniqueness(params: {
    userId: string;
    niche: string;
    content: string;
    imageBuffer?: Buffer;
    vaultStrandsUsed: string[];
  }): Promise<UniquenessResult> {
    let geometricScore = 0;

    // Gate 1: Geometric Check (if image provided)
    if (params.imageBuffer) {
      geometricScore = await this.checkGeometricSimilarity(params.imageBuffer);
      if (geometricScore > 90) {
        return {
          isUnique: false,
          geometricScore,
          semanticScore: 0,
          reasoning: 'Geometric similarity too high (>90%). Likely a direct copy or minor variation.',
        };
      }
    }

    // Gate 2 & 3: Semantic & Content Check via Gemini
    const intelResult = await this.runIntelligenceCheck(params);
    
    const isUnique = geometricScore < 85 && intelResult.semanticScore < 80;

    return {
      isUnique,
      geometricScore,
      semanticScore: intelResult.semanticScore,
      reasoning: intelResult.reasoning,
    };
  }

  /**
   * dHash implementation for structural similarity.
   */
  private async checkGeometricSimilarity(imageBuffer: Buffer): Promise<number> {
    try {
      // 1. Normalize image
      const { data, info } = await sharp(imageBuffer)
        .resize(8, 8, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      // 2. Generate Hash
      // blockhash.blockhashData returns a hex string
      const hash = blockhash.blockhashData({
        data: new Uint8ClampedArray(data),
        width: info.width,
        height: info.height
      }, 8, 1); // 1 = bmvbhash_even

      // 3. Compare with Vault assets (Simplified for now: query recent assets)
      const recentAssets = await db.select()
        .from(schema.masterAssets)
        .limit(20);

      let maxSimilarity = 0;
      for (const asset of recentAssets) {
        if (asset.styleDna?.pHash) {
          const distance = blockhash.hammingDistance(hash, asset.styleDna.pHash);
          // Hamming distance of 0 = 100% similar. For 8x8 (64 bits), distance 10 ~ 85% similar.
          const similarity = Math.max(0, 100 - (distance * 1.5));
          if (similarity > maxSimilarity) maxSimilarity = similarity;
        }
      }

      return maxSimilarity;
    } catch (e) {
      console.warn('[UniquenessService] Geometric check failed:', (e as Error).message);
      return 0;
    }
  }

  /**
   * LLM-powered Semantic & Content Uniqueness Check (Gemini).
   */
  private async runIntelligenceCheck(params: {
    niche: string;
    content: string;
    vaultStrandsUsed: string[];
  }): Promise<{ semanticScore: number; reasoning: string }> {
    try {
      const model = await resolveStudioReasoner();
      const template = `
        You are the Empire Studio Anti-Copycat Officer.
        Task: Evaluate if the following content is a "copycat" of existing market patterns or vault designs.
        Niche: {niche}
        Proposed Content: {content}
        Vault Strands Used: {vaultStrands}
        
        Rules:
        1. If the content is almost identical to common niche templates, semanticScore should be high (>80).
        2. If it brings a unique angle or "DNA synthesis" that feels fresh, semanticScore should be low (<40).
        3. Be strict. We want "Better than ChatGPT" level of originality.

        Return JSON:
        - semanticScore: number (0-100)
        - reasoning: string (Detailed explanation of why it is or isn't unique)
      `;
      
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      
      const result = await chain.invoke({
        niche: params.niche,
        content: params.content,
        vaultStrands: params.vaultStrandsUsed.join(', '),
      }) as any;

      return {
        semanticScore: result.semanticScore || 50,
        reasoning: result.reasoning || 'Standard uniqueness profile.',
      };
    } catch (e) {
      console.warn('[UniquenessService] Intel check failed:', (e as Error).message);
      return { semanticScore: 0, reasoning: 'Intelligence check bypassed due to error.' };
    }
  }

  /**
   * Utility to generate a pHash for storage.
   */
  async generatePHash(imageBuffer: Buffer): Promise<string> {
    const { data, info } = await sharp(imageBuffer)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return blockhash.blockhashData({
      data: new Uint8ClampedArray(data),
      width: info.width,
      height: info.height
    }, 8, 1);
  }

  /**
   * Checks similarity against known market best-sellers (design_hashes).
   */
  async checkDesignSimilarity(hash: string): Promise<number> {
    try {
      const existingHashes = await db.select()
        .from(schema.designHashes)
        .limit(100);

      let maxSimilarity = 0;
      for (const entry of existingHashes) {
        const distance = blockhash.hammingDistance(hash, entry.hash);
        // Hamming distance of 0 = 100% similar. For 8x8 (64 bits), distance 10 ~ 85% similar.
        const similarity = Math.max(0, 100 - (distance * 1.5));
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }
      return maxSimilarity;
    } catch (e) {
      console.warn('[UniquenessService] Design similarity check failed:', (e as Error).message);
      return 0;
    }
  }
}

export const uniquenessService = new UniquenessService();
