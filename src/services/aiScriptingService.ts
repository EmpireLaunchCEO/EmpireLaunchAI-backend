import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser, JsonOutputParser } from "@langchain/core/output_parsers";
import { resolveModelForUser, resolveStudioReasoner, getDefaultModel } from "../utils/resolveModel.js";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getMasterBriefing } from "./strategicDirective.js";
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

    const masterBriefing = getMasterBriefing({
      niche: context.businessNiche,
      goal: context.userGoal,
      userTier: 'Customer Success Specialist'
    });

    const template = `
      ${masterBriefing}
      
      Task: Draft a professional and helpful email response to a customer inquiry.
      
      Product Name: {productName}
      Tone: {tone}
      
      Customer Inquiry:
      {customerInquiry}
      
      Draft a complete email including a subject line and body. 
      Ensure the response aligns with the master strategic directives.
      
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
      productName: context.productName || "our latest offering",
      tone: context.tone || "professional and friendly",
      customerInquiry: context.customerInquiry,
    });
  }

  /**
   * Creates a comprehensive Design Blueprint using High-Intelligence reasoning.
   */
  async generateDesignBlueprint(context: ScriptingContext): Promise<string> {
    const model = await resolveStudioReasoner();

    const masterBriefing = getMasterBriefing({
      niche: context.businessNiche,
      goal: context.userGoal,
      userTier: 'High-Reasoning Designer'
    });

    const template = `
      ${masterBriefing}
      
      Task: Create a comprehensive Design Blueprint for a product called "{productName}".
      
      Target Audience Context: {customerInquiry}
      
      Provide a structured blueprint including:
      1. Recommended Visual Style (Colors, Typography, Mood)
      2. Template Keywords (to search for in tools like Kittl or Canva)
      3. Content Strategy (What text goes where)
      4. Anti-Copycat Modifications (Specific ways to make this design technically unique from best-sellers)
      5. Step-by-Step Execution Plan (prioritizing free-tier tools and assets)
      
      Analyze the problem step-by-step according to the Strategic Directive.
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      model,
      new StringOutputParser(),
    ]);

    return await chain.invoke({
      productName: context.productName || "Unspecified Product",
      customerInquiry: context.customerInquiry,
    });
  }

  /**
   * Generates high-converting marketplace SEO data.
   */
  async generateListingSEO(niche: string, bestSellers: any[]): Promise<any> {
    const model = await resolveStudioReasoner();

    const masterBriefing = getMasterBriefing({
      niche,
      goal: "Generate high-traction SEO data for a marketplace listing.",
      userTier: 'Marketplace SEO Specialist'
    });

    const template = `
      ${masterBriefing}
      
      Analyze the following best-selling products in the {niche} niche:
      {bestSellersData}
      
      Generate optimized listing data for a "similar but unique" product that avoids copyright issues and copycatting.
      
      Return JSON:
      - title: high-traction Title (max 140 chars)
      - description: engaging Description focusing on benefits
      - tags: string[] (exactly 13 relevant tags)
      - price: suggested price in cents (integer)
      - competitiveEdge: 1 sentence explaining why this listing will beat the competition (Strategic Reasoning)
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

  /**
   * Generates a 30-day email sequence based on niche and Style DNA.
   */
  async generateEmailSequence(userId: string, niche: string, dnaStrands: any[]): Promise<any[]> {
    const model = await resolveModelForUser(userId);

    const masterBriefing = getMasterBriefing({
      niche,
      goal: "Generate a 30-day high-conversion email sequence.",
      userTier: 'Growth Marketing Architect'
    });

    const template = `
      \${masterBriefing}
      
      Task: Create a 30-day automated email sequence for a business in the {niche} niche.
      
      Style DNA context:
      {dnaContext}
      
      Requirements:
      1. Define 4 key emails (Day 1, Day 7, Day 14, Day 30).
      2. Ensure the tone matches the typography and brand vibe from the DNA.
      3. Focus on "Success-Share" value (helpful content first, sales second).
      
      Return JSON array:
      [
        { "day": number, "subject": "string", "content": "string" }
      ]
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);

    const result = await chain.invoke({
      masterBriefing,
      niche,
      dnaContext: JSON.stringify(dnaStrands.slice(0, 5).map(s => ({ category: s.category, subCategory: s.subCategory, manifest: s.manifest }))),
    });

    return Array.isArray(result) ? result : [];
  }
}

export const aiScriptingService = new AIScriptingService();
