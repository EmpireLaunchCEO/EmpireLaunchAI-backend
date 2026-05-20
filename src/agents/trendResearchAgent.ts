import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
// @ts-ignore
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { researchService } from "../services/researchService.js";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import dotenv from 'dotenv';

dotenv.config();

export class TrendResearchAgent {
  private model: ChatOpenAI;
  private embeddings: OpenAIEmbeddings;

  constructor() {
    this.model = new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
    this.embeddings = new OpenAIEmbeddings({
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  async analyzeTrends(goal: string) {
    console.log("Ingesting trend data...");
    const rawData = await researchService.getAllTrends();

    if (!process.env.OPENAI_API_KEY) {
      console.warn("OPENAI_API_KEY is missing. Returning mock trend analysis.");
      return JSON.stringify({
        trendingNiches: [
          { niche: "Minimalist Digital Planners", roi: 85, reason: "High search volume on Etsy" },
          { niche: "Productivity TikToks", roi: 90, reason: "Viral potential" }
        ],
        suggestedStrategy: "Create a bundle of student-focused digital planners with a minimalist aesthetic and market them on TikTok using 'productivity' hashtags."
      });
    }

    const docs = rawData.map(item => new Document({
      pageContent: `[${item.platform}] [ROI: ${item.roiPotential}] [Niche: ${item.niche}] ${item.content}`,
      metadata: { platform: item.platform, timestamp: item.timestamp, roi: item.roiPotential, niche: item.niche }
    }));

    console.log("Building vector store...");
    const vectorStore = await MemoryVectorStore.fromDocuments(docs, this.embeddings);

    console.log("Searching for relevant trends...");
    const relevantDocs = await vectorStore.similaritySearch(goal, 3);
    const context = relevantDocs.map((d: Document) => d.pageContent).join("\n");

    const template = `
      You are a Market Trend Analyst for the Bizrunner platform.
      Your goal is to identify trending niches and products based on the provided research data and the user's business goal.

      User Goal: {goal}

      Research Data:
      {context}

      Based on the data, identify the top trending niches or products that align with the user's goal.
      Include ROI potential (0-100) and specific platform insights.
      
      Output the result as a JSON object with the following structure:
      {{
        "trendingNiches": [
          {{ "niche": "string", "roi": number, "reason": "string", "platform": "string" }}
        ],
        "suggestedStrategy": "string"
      }}
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      this.model,
      new StringOutputParser(),
    ]);

    console.log("Generating trend analysis...");
    if (!process.env.OPENAI_API_KEY) {
      console.warn("OPENAI_API_KEY is missing. Returning mock trend analysis.");
      return "Based on current trends, minimalist digital planners and aesthetic office setups are highly popular. Strategy: Create a bundle of student-focused digital planners with a minimalist aesthetic and market them on TikTok using 'productivity' hashtags.";
    }
    const result = await chain.invoke({
      goal,
      context,
    });

    return result;
  }
}

export const trendResearchAgent = new TrendResearchAgent();
