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
    if (!process.env.OPENAI_API_KEY) {
      console.warn("OPENAI_API_KEY is missing. Returning mock email draft.");
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
}

export const aiScriptingService = new AIScriptingService();
