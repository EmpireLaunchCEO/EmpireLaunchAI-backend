import { resolveStudioReasoner, getModelConfig } from '../utils/resolveModel.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

/**
 * Reasoning Engine Service
 * High-intelligence orchestration layer powered by Gemini 1.5 Flash.
 * Handles complex design decomposition and DNA synthesis.
 */
export class ReasoningEngine {
  private reasoner: BaseChatModel | null = null;

  private async getReasoner(): Promise<BaseChatModel> {
    if (!this.reasoner) {
      this.reasoner = await resolveStudioReasoner();
    }
    return this.reasoner;
  }

  /**
   * Design Reasoning Pass
   * Decomposes a business goal into a multi-step execution graph.
   */
  async reasonDesign(userId: string, goal: string): Promise<string> {
    const config = await getModelConfig(userId);
    const model = await this.getReasoner();

    // High-intelligence pass for complex product generation
    const systemPrompt = `You are the Empire Studio Design Reasoner. 
    Analyze the user's business goal and create a multi-step execution plan.
    
    User Tier: ${config.modelName}
    User Goal: ${goal}
    
    Steps to include:
    1. DNA Extraction (Market Research)
    2. Style Synthesis (Creating unique Visual DNA)
    3. Asset Generation (Journals, PDFs, Reels)
    4. Listing Automation (Etsy/Shopify)
    5. Promotion Strategy (TikTok/IG)`;

    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage("Generate the execution plan.")
    ]);

    return response.content as string;
  }

  /**
   * DNA Synthesis Pass
   * Combines multiple DNA strands into a harmonized Style Manifest.
   */
  async synthesizeDNA(userId: string, niche: string, dnaStrands: any[]): Promise<any> {
    const model = await this.getReasoner();
    
    const systemPrompt = `You are the DNA Synthesis Engine. 
    Take the provided DNA strands for the niche "${niche}" and synthesize a NEW, UNIQUE style manifest.
    
    Rules:
    - Zero-Copycat: Pivot palettes and layouts if they overlap > 85%.
    - Visual Harmony: Ensure color theory is applied.
    - Market Traction: Prioritize strands with high performance scores.`;

    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(JSON.stringify(dnaStrands))
    ]);

    try {
      return JSON.parse(response.content as string);
    } catch {
      return response.content;
    }
  }

  /**
   * Conversational Consultant Bridge
   * Translates natural language intent into Studio commands.
   */
  async consult(userId: string, message: string): Promise<string> {
    const model = await this.getReasoner();
    const systemPrompt = `You are the Empire Studio Conversational Consultant. 
    Talk to the user about their business goals. Suggest visual style directions (abstractly).
    NEVER show original source images. Only discuss synthesized styles.`;

    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(message)
    ]);

    return response.content as string;
  }
}

export const reasoningEngine = new ReasoningEngine();
