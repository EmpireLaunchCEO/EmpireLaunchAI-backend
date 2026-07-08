import { getModelConfig } from '../utils/resolveModel.js';
import { stylePreviewService } from './stylePreviewService.js';
import { getMasterBriefing } from './strategicDirective.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

export class ReasoningEngine {

  private async callGeminiDirect(systemPrompt: string, userMessage: string): Promise<string> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY not configured');
    }

    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] }
        ],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 1024
        }
      })
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Gemini API error: ${response.status} ${errorBody}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Gemini returned empty response');
    }
    return text;
  }

  async reasonDesign(userId: string, goal: string, niche?: string): Promise<string> {
    const config = await getModelConfig(userId);

    const [goalRow] = await db.select({ archetype: schema.goals.archetype }).from(schema.goals).where(eq(schema.goals.userId, userId)).limit(1);
    const archetype = (goalRow as any)?.archetype || 'creator';

    const systemPrompt = getMasterBriefing({
      userTier: config.modelName,
      goal,
      niche,
      archetype
    });

    try {
      return await this.callGeminiDirect(systemPrompt, `You are acting as the Design Reasoner. Create a multi-step execution plan for this specific goal: ${goal}`);
    } catch (err) {
      console.error('[ReasoningEngine] reasonDesign Gemini call failed:', (err as Error).message);
      return 'Unable to generate design reasoning at this time.';
    }
  }

  async synthesizeDNA(userId: string, niche: string, dnaStrands: any[]): Promise<any> {
    const [goalRow] = await db.select({ archetype: schema.goals.archetype }).from(schema.goals).where(eq(schema.goals.userId, userId)).limit(1);
    const archetype = (goalRow as any)?.archetype || 'creator';

    const systemPrompt = getMasterBriefing({
      niche,
      goal: `Synthesize DNA for niche: ${niche}`,
      archetype
    }) + `\n\nYou are the DNA Synthesis Engine. Take the provided DNA strands and synthesize a NEW style manifest.`;

    try {
      const text = await this.callGeminiDirect(systemPrompt, JSON.stringify(dnaStrands));
      return JSON.parse(text);
    } catch {
      return dnaStrands;
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

    const systemPrompt = `You are a sharp, no-fluff creative director for short-form video. You know what performs on TikTok, YouTube Shorts, and Instagram Reels — hooks, pacing, colors, trending transitions.

RULES:
- Keep EVERY response VERY SHORT — 2-3 sentences max.
- Propose a complete, ready-to-go video concept based on market trends.
- Ask ONE question at a time — never list multiple questions.
- If the user confirms with "yes", "ready", "go ahead", or "generate", end with "[GENERATE]" in your response.
- If the user changes direction, adapt and follow what they want.
- Identify niche with [NICHE: name] if you discover a specific one.
- Be direct, strategic, and concise. No paragraphs. No fluff.`;

    let content: string;
    try {
      content = await this.callGeminiDirect(systemPrompt, message);
    } catch (err) {
      console.error('[ReasoningEngine] Gemini call failed:', (err as Error).message);
      return { message: "I'm here to help! Tell me more about what you're looking to create — what niche, visual style, or type of content are you thinking about?" };
    }
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
