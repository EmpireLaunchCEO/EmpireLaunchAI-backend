import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser, JsonOutputParser } from "@langchain/core/output_parsers";
import { marketIntelligenceService } from "../services/marketIntelligenceService.js";
import { resolveStudioReasoner } from "../utils/resolveModel.js";
import dotenv from 'dotenv';

dotenv.config();

export class MarketIntelligenceAgent {
  async generateProductBrief(goal: string) {
    console.log(`Generating High-Intelligence Market Brief for goal: ${goal}`);
    
    // 1. Fetch data
    const bestSellers = await marketIntelligenceService.fetchEtsyBestSellers(goal);
    const visualTrends = await marketIntelligenceService.fetchVisualTrends(goal);

    // 2. Resolve High-Intelligence Model (Gemini)
    const model = await resolveStudioReasoner();

    // 3. Synthesize data using LLM
    const template = `
      You are the Market Intelligence Officer for Empire Studio.
      Your task is to analyze competitive data and visual trends to inform the creation of a new, unique product.
      We follow a strict "Anti-Copycat" policy.

      User Goal: {goal}

      Market Context (Etsy Best Sellers):
      {bestSellers}

      Visual Trend Context (Social Media):
      {visualTrends}

      Based on this data, generate a comprehensive "Product Brief" for a new product that is "Similar but Technically Unique" from top sellers.
      
      Return JSON:
      - suggestedTitle: Suggested SEO Title (Max 140 chars)
      - suggestedPrice: number (Suggested Pricing in USD)
      - targetStyle: string (Target Visual Style DNA)
      - keyFeatures: string[] (Unique features to include)
      - competitiveKeywords: string[] (Top 10 Keywords for SEO)
      - uniquenessAngle: 1 sentence explaining why this isn't a copycat
      - reasoning: 1-2 sentences on the strategic choices
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      model,
      new JsonOutputParser(),
    ]);

    return await chain.invoke({
      goal,
      bestSellers: JSON.stringify(bestSellers),
      visualTrends: JSON.stringify(visualTrends),
    });
  }
}

export const marketIntelligenceAgent = new MarketIntelligenceAgent();
