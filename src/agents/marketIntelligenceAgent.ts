import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { marketIntelligenceService } from "../services/marketIntelligenceService.js";
import dotenv from 'dotenv';

dotenv.config();

export class MarketIntelligenceAgent {
  private model: ChatOpenAI;

  constructor() {
    this.model = new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateProductBrief(goal: string) {
    console.log(`Generating Market Intelligence for goal: ${goal}`);
    
    // 1. Fetch data
    const bestSellers = await marketIntelligenceService.fetchEtsyBestSellers(goal);
    const visualTrends = await marketIntelligenceService.fetchVisualTrends(goal);

    if (!process.env.OPENAI_API_KEY) {
      console.warn("OPENAI_API_KEY is missing. Returning mock product brief.");
      return JSON.stringify({
        suggestedTitle: `Premium ${goal} - Minimalist Aesthetic`,
        suggestedPrice: 11.99,
        targetStyle: "Minimalist",
        keyFeatures: ["Daily Schedule", "Budget Tracker", "Customizable Colors"],
        competitiveKeywords: ["digital planner", "minimalist style", "productivity tool"],
        reasoning: "High traction on Etsy for minimalist designs and daily student layouts."
      });
    }

    // 2. Synthesize data using LLM
    const template = `
      You are the Market Intelligence Sub-Agent for Bizrunner.
      Your task is to analyze competitive data and visual trends to inform the creation of a new product.

      User Goal: {goal}

      Etsy Best Sellers:
      {bestSellers}

      Visual Trends (Social Media):
      {visualTrends}

      Based on this data, generate a "Product Brief" for a new product that is "similar but distinct" from top sellers.
      Include:
      1. Suggested SEO Title (Max 140 chars)
      2. Suggested Pricing (Benchmark against competitors)
      3. Target Visual Style
      4. Key Features to include
      5. Top 10 Keywords for SEO
      6. Brief Reasoning for these choices

      Output the result as a JSON object.
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      this.model,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      goal,
      bestSellers: JSON.stringify(bestSellers),
      visualTrends: JSON.stringify(visualTrends),
    });

    return result;
  }
}

export const marketIntelligenceAgent = new MarketIntelligenceAgent();
