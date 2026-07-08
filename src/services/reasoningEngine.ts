import { resolveStudioReasoner, getModelConfig } from '../utils/resolveModel.js';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { stylePreviewService } from './stylePreviewService.js';
import { getMasterBriefing } from './strategicDirective.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

export class ReasoningEngine {
  private reasoner: BaseChatModel | null = null;

  private async getReasoner(): Promise<BaseChatModel> {
    if (!this.reasoner) {
      this.reasoner = await resolveStudioReasoner();
    }
    return this.reasoner;
  }

  async reasonDesign(userId: string, goal: string, niche?: string): Promise<string> {
    const config = await getModelConfig(userId);
    const model = await this.getReasoner();
    
    const [goalRow] = await db.select({ archetype: schema.goals.archetype }).from(schema.goals).where(eq(schema.goals.userId, userId)).limit(1);
    const archetype = (goalRow as any)?.archetype || 'creator';

    const systemPrompt = getMasterBriefing({
      userTier: config.modelName,
      goal,
      niche,
      archetype
    });

    const response = await model.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`You are acting as the Design Reasoner. Create a multi-step execution plan for this specific goal: ${goal}`)
    ]);

    return response.content as string;
  }

  async synthesizeDNA(userId: string, niche: string, dnaStrands: any[]): Promise<any> {
    const model = await this.getReasoner();
    
    const [goalRow] = await db.select({ archetype: schema.goals.archetype }).from(schema.goals).where(eq(schema.goals.userId, userId)).limit(1);
    const archetype = (goalRow as any)?.archetype || 'creator';

    const systemPrompt = getMasterBriefing({
      niche,
      goal: `Synthesize DNA for niche: ${niche}`,
      archetype
    }) + `\n\nYou are the DNA Synthesis Engine. Take the provided DNA strands and synthesize a NEW style manifest.`;
    
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

  async consult(userId: string, message: string, niche?: string): Promise<{ message: string; stylePreviews?: any[] }> {
    // Fetch user's archetype from active goal — gracefully handle missing/invalid userId
    let archetype = 'creator';
    try {
      const [goal] = await db.select({ archetype: schema.goals.archetype }).from(schema.goals).where(eq(schema.goals.userId, userId)).limit(1);
      archetype = (goal as any)?.archetype || 'creator';
    } catch (err) {
      console.warn('[ReasoningEngine] Could not fetch archetype, defaulting to creator:', (err as Error).message);
    }

    const systemPrompt = getMasterBriefing({
      niche,
      userTier: 'Empire Consultant',
      archetype
    }) + `\n\nYou are the Empire Studio Conversational Consultant. Identify niche with [NICHE: name] if you discover a specific one.`;

    let response;
    try {
      const model = await this.getReasoner();
      response = await model.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(message)
      ]);
    } catch (err) {
      console.error('[ReasoningEngine] Gemini call failed:', (err as Error).message);
      return { message: "I'm here to help! Tell me more about what you're looking to create — what niche, visual style, or type of content are you thinking about?" };
    }
    const content = response.content as string;
    let nicheMatch = content.match(/\[NICHE:\s*([^\]]+)\]/);
    let finalMessage = content.replace(/\[NICHE:\s*[^\]]+\]/, '').trim();
    let stylePreviews: any[] | undefined;
    if (nicheMatch) {
      stylePreviews = await stylePreviewService.getStylesForNiche(userId, nicheMatch[1].trim());
    }
    return { message: finalMessage, stylePreviews };
  }
}

export const reasoningEngine = new ReasoningEngine();
