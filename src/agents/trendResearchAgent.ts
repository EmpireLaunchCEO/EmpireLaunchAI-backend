import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { researchService } from "../services/researchService.js";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { resolveModelForUser, resolveStudioReasoner } from "../utils/resolveModel.js";
import dotenv from 'dotenv';

dotenv.config();

export class TrendResearchAgent {
  private embeddings: GoogleGenerativeAIEmbeddings;

  constructor() {
    const apiKey = process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      console.warn('[TrendResearchAgent] No Google API key found. Agent will operate in reduced mode.');
      // Initialize with a dummy key to prevent crash if not used immediately
      this.embeddings = new GoogleGenerativeAIEmbeddings({
        apiKey: 'DUMMY_KEY',
        modelName: "embedding-001",
      });
    } else {
      this.embeddings = new GoogleGenerativeAIEmbeddings({
        apiKey: process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY,
        modelName: "embedding-001",
      });
    }
  }

  async analyzeTrends(goal: string, userId?: string) {
    if (!(process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY)) {
       console.error('[TrendResearchAgent] Cannot analyze trends: GOOGLE_API_KEY is missing.');
       return JSON.stringify({ trendingNiches: [], suggestedStrategy: "Market research requires a configured GOOGLE_API_KEY." });
    }
    console.log("Ingesting trend data...");
    const rawData = await researchService.getAllTrends();

    const docs = rawData.map(item => new Document({
      pageContent: `[${item.platform}] [ROI: ${item.roiPotential}] [Niche: ${item.niche}] ${item.content}`,
      metadata: { platform: item.platform, timestamp: item.timestamp, roi: item.roiPotential, niche: item.niche }
    }));

    console.log("Building vector store...");
    const vectorStore = await MemoryVectorStore.fromDocuments(docs, this.embeddings);

    console.log("Searching for relevant trends...");
    const relevantDocs = await vectorStore.similaritySearch(goal, 3);
    const context = relevantDocs.map((d: Document) => d.pageContent).join("\n");

    // Use High-Intelligence Studio Reasoner for trend analysis
    const model = await resolveStudioReasoner();

    const template = `
      You are a High-Intelligence Market Trend Analyst powered by Empire Studio.
      Your goal is to identify trending niches and products based on research data and user goals.

      User Goal: {goal}
      Research Data:
      {context}

      Analyze the data to find unique market gaps. We want "Better than ChatGPT" insights.
      Include ROI potential (0-100) and specific platform insights.
      
      Output JSON:
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
      model,
      new StringOutputParser(),
    ]);

    console.log("Generating high-intelligence trend analysis...");
    return await chain.invoke({
      goal,
      context,
    });
  }
}

export const trendResearchAgent = new TrendResearchAgent();
