import { db, schema } from '../db/index.js';
const { nicheDnaRepository } = schema;
import { originalityService } from './originalityService.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { resolveStudioReasoner } from "../utils/resolveModel.js";
import dotenv from 'dotenv';

dotenv.config();

export interface NicheDna {
  niche: string;
  dnaElements: string[];
  marketGaps: string[];
}

export class NeuralMarketDiscoveryService {
  constructor() {}

  /**
   * Scans a niche to extract success DNA and identify market gaps.
   */
  async discoverNicheDna(niche: string) {
    console.log(`[NeuralMarketDiscovery] Extracting DNA for niche: ${niche}`);

    const model = await resolveStudioReasoner();

    const template = `
      You are the "Neural Market Discovery" Agent for EmpireLaunchAI.
      Analyze the successful products and trends in the specified niche.
      
      Niche: {niche}
      
      Task:
      1. Extract "DNA Elements" (success factors like "Minimalist layout", "Pastel palette", "High-contrast typography").
      2. Identify "Market Gaps" (what is underserved or missing).
      
      Return ONLY a JSON object.
      
      JSON Format:
      {{
        "dnaElements": ["string"],
        "marketGaps": ["string"]
      }}
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      model,
      new JsonOutputParser(),
    ]);

    try {
      const result = await chain.invoke({ niche }) as any;
      
      // Save/Update in repository
      const [existing] = await db.select().from(nicheDnaRepository).where(eq(nicheDnaRepository.niche, niche)).limit(1);
      
      if (existing) {
        await db.update(nicheDnaRepository)
          .set({
            dnaElements: result.dnaElements,
            marketGaps: result.marketGaps,
            updatedAt: new Date()
          })
          .where(eq(nicheDnaRepository.niche, niche));
      } else {
        await db.insert(nicheDnaRepository).values({
          id: uuidv4(),
          niche,
          dnaElements: result.dnaElements,
          marketGaps: result.marketGaps,
          updatedAt: new Date()
        });
      }

      return result as NicheDna;
    } catch (error: any) {
      console.error("[NeuralMarketDiscovery] Discovery failed:", error.message);
      throw error;
    }
  }

  /**
   * Generates a "Neural Remix" - a unique product concept based on DNA elements and a unique pivot.
   */
  async generateNeuralRemix(niche: string, userId: string) {
    const dna = await this.discoverNicheDna(niche);
    
    console.log(`[NeuralMarketDiscovery] Generating Neural Remix for user ${userId} in ${niche}`);

    const model = await resolveStudioReasoner();

    const template = `
      You are the "Neural Remix" Architect.
      Create a unique product concept by combining successful DNA elements with a "Unique Pivot".
      
      DNA Elements: {dnaElements}
      Market Gaps: {marketGaps}
      
      Rules:
      1. Combine at least 2 DNA elements.
      2. Address at least 1 market gap.
      3. Create a "Unique Pivot" that differentiates the product.
      4. Ensure it's original and better than generic AI ideas.
      
      Return ONLY a JSON object.
      
      JSON Format:
      {{
        "title": "string",
        "concept": "string",
        "visualStyle": "string",
        "uniquePivot": "string",
        "reasoning": "string"
      }}
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      model,
      new JsonOutputParser(),
    ]);

    const remix = await chain.invoke({
      dnaElements: dna.dnaElements.join(", "),
      marketGaps: dna.marketGaps.join(", ")
    });
    
    return {
      remix,
      dnaUsed: dna.dnaElements,
      intelligenceLevel: 'Strategic Intellect v1'
    };
  }
}

export const neuralMarketDiscoveryService = new NeuralMarketDiscoveryService();
