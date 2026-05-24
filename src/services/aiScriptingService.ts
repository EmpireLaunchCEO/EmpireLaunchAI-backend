import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import dotenv from 'dotenv';

dotenv.config();

export interface ScriptingContext {
  customerInquiry: string;
  businessNiche: string;
  userGoal: string;
  productName?: string;
  tone?: string;
}

export class AIScriptingService {
  private model: ChatOpenAI;

  constructor() {
    this.model = new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0.7,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateEmailDraft(context: ScriptingContext): Promise<string> {
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key') {
      console.warn("OPENAI_API_KEY is missing or invalid. Returning mock email draft.");
      return `Subject: Re: ${context.customerInquiry.substring(0, 20)}...\n\nHi there,\n\nThank you for reaching out regarding ${context.productName || 'our products'}. As a ${context.businessNiche} business, we aim to ${context.userGoal}.\n\nBest regards,\nBizrunner AI`;
    }

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
      this.model,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      businessNiche: context.businessNiche,
      userGoal: context.userGoal,
      productName: context.productName || "our latest offering",
      tone: context.tone || "professional and friendly",
      customerInquiry: context.customerInquiry,
    });

    return result;
  }

  async generateDesignBlueprint(context: ScriptingContext): Promise<string> {
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key') {
      console.warn("OPENAI_API_KEY is missing or invalid. Returning mock blueprint.");
      return `### Design Blueprint for ${context.productName}\n\n1. Use a minimalist layout.\n2. Choose primary colors from ${context.businessNiche} palette.\n3. Ensure text is readable.`;
    }

    const template = `
      You are a High-Intelligence Design Architect specializing in digital products for {businessNiche}.
      Your task is to create a comprehensive Design Blueprint for a product called "{productName}".
      
      Target Audience: {customerInquiry}
      Specific Goal: {userGoal}
      
      Provide a structured blueprint including:
      1. Recommended Visual Style (Colors, Typography, Mood)
      2. Template Keywords (to search for in tools like Kittl or Canva)
      3. Content Strategy (What text goes where)
      4. Anti-Copycat Modifications (Specific ways to make this design technically unique from best-sellers)
      5. Step-by-Step Execution Plan (prioritizing free-tier tools and assets)
      
      Be extremely analytical and precise. Use "Intellect Layer" thinking to find unique angles that boost sales traction.
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      this.model,
      new StringOutputParser(),
    ]);

    return await chain.invoke({
      businessNiche: context.businessNiche,
      productName: context.productName || "Unspecified Product",
      customerInquiry: context.customerInquiry,
      userGoal: context.userGoal,
    });
  }

  async generateListingSEO(niche: string, bestSellers: any[]): Promise<any> {
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key') {
      return {
        title: `Premium ${niche} Digital Product`,
        description: `This high-quality ${niche} product is designed for success.`,
        tags: [niche, 'digital', 'quality'],
        price: 999
      };
    }

    const template = `
      You are an expert Marketplace SEO Specialist. 
      Analyze the following best-selling products in the {niche} niche:
      {bestSellersData}
      
      Generate a set of SEO-optimized listing data for a "similar but unique" product:
      1. A high-traction Title (max 140 chars)
      2. An engaging Description focusing on benefits
      3. 13 relevant Tags for marketplace search
      4. A suggested Price in cents (integer)
      
      Return as a JSON object with keys: title, description, tags, price.
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      this.model,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      niche,
      bestSellersData: JSON.stringify(bestSellers.map(b => ({ title: b.title, description: b.description }))),
    });

    try {
      return JSON.parse(result);
    } catch (e) {
      // Fallback if AI didn't return perfect JSON
      return {
        title: result.substring(0, 140),
        description: result,
        tags: [niche],
        price: 1500
      };
    }
  }
}

export const aiScriptingService = new AIScriptingService();
