import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser, JsonOutputParser } from "@langchain/core/output_parsers";
import { resolveModelForUser, resolveStudioReasoner, getDefaultModel } from "../utils/resolveModel.js";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import dotenv from 'dotenv';

dotenv.config();

export interface ScriptingContext {
  customerInquiry: string;
  businessNiche: string;
  userGoal: string;
  productName?: string;
  tone?: string;
  userId?: string;
}

export class AIScriptingService {
  /**
   * Generates a professional email draft for customer support.
   */
  async generateEmailDraft(context: ScriptingContext): Promise<string> {
    const model = context.userId ? await resolveModelForUser(context.userId) : getDefaultModel();

    const template = `
      You are an expert Customer Success Agent for a {businessNiche} business.
      Your goal is to draft a professional and helpful email response to a customer inquiry.
      
      User Goal: {userGoal}
      Business Niche: {businessNiche}
      Product Name: {productName}
      Tone: {tone}
      
      Customer Inquiry:
      {customerInquiry}
      
      Draft a complete email including a subject line and body. 
      Ensure the response aligns with the user's goal and business niche.
      If a tone is specified, use that tone. Otherwise, be professional and friendly.
      
      IMPORTANT: All generated emails MUST include the following placeholder for legal compliance at the end:
      [SENDER_IDENTITY_PLACEHOLDER]
      [UNSUBSCRIBE_LINK_PLACEHOLDER]
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      model,
      new StringOutputParser(),
    ]);

    return await chain.invoke({
      businessNiche: context.businessNiche,
      userGoal: context.userGoal,
      productName: context.productName || "our latest offering",
      tone: context.tone || "professional and friendly",
      customerInquiry: context.customerInquiry,
    });
  }

  /**
   * Creates a comprehensive Design Blueprint using High-Intelligence reasoning.
   * Uses Gemini 3 Flash logic for problem solving.
   */
  async generateDesignBlueprint(context: ScriptingContext): Promise<string> {
    const model = await resolveStudioReasoner();

    const template = `
      You are the Empire Studio Intelligence Layer (High-Reasoning Designer).
      Task: Create a comprehensive Design Blueprint for a product called "{productName}" in the {businessNiche} niche.
      
      Target Audience Context: {customerInquiry}
      Specific Goal: {userGoal}
      
      Provide a structured blueprint including:
      1. Recommended Visual Style (Colors, Typography, Mood)
      2. Template Keywords (to search for in tools like Kittl or Canva)
      3. Content Strategy (What text goes where)
      4. Anti-Copycat Modifications (Specific ways to make this design technically unique from best-sellers)
      5. Step-by-Step Execution Plan (prioritizing free-tier tools and assets)
      
      Analyze the problem step-by-step. Use your high-intelligence reasoning to find unique market gaps.
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      model,
      new StringOutputParser(),
    ]);

    return await chain.invoke({
      businessNiche: context.businessNiche,
      productName: context.productName || "Unspecified Product",
      customerInquiry: context.customerInquiry,
      userGoal: context.userGoal,
    });
  }

  /**
   * Generates high-converting marketplace SEO data.
   */
  async generateListingSEO(niche: string, bestSellers: any[]): Promise<any> {
    const model = await resolveStudioReasoner();

    const template = `
      You are an expert Marketplace SEO Specialist powered by Empire Studio Intelligence.
      Analyze the following best-selling products in the {niche} niche:
      {bestSellersData}
      
      Generate optimized listing data for a "similar but unique" product that avoids copyright issues and copycatting.
      
      Return JSON:
      - title: high-traction Title (max 140 chars)
      - description: engaging Description focusing on benefits
      - tags: string[] (exactly 13 relevant tags)
      - price: suggested price in cents (integer)
      - competitiveEdge: 1 sentence explaining why this listing will beat the competition
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      model,
      new JsonOutputParser(),
    ]);

    return await chain.invoke({
      niche,
      bestSellersData: JSON.stringify(bestSellers.map(b => ({ title: b.title, description: b.description }))),
    });
  }
}

export const aiScriptingService = new AIScriptingService();
