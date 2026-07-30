import { getModelConfig } from '../utils/resolveModel.js';
import { stylePreviewService } from './stylePreviewService.js';
import { getMasterBriefing } from './strategicDirective.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

export class ReasoningEngine {

  private async callGeminiDirect(systemPrompt: string, userMessage: string): Promise<string> {
    // Try Gemini first
    const geminiKey = process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
    if (geminiKey) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] }
            ],
            generationConfig: { temperature: 0.5, maxOutputTokens: 8192 }
          })
        });

        if (response.ok) {
          const data = await response.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) return text;
        }
        const errorBody = await response.text().catch(() => '');
        console.warn('[ReasoningEngine] Gemini failed:', response.status, errorBody.slice(0, 200));
      } catch (err) {
        console.warn('[ReasoningEngine] Gemini error, trying OpenAI fallback:', (err as Error).message);
      }
    }

    // Fallback to OpenAI
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error('Neither GOOGLE_API_KEY nor OPENAI_API_KEY configured');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.5,
        max_tokens: 8192
      })
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`OpenAI API error: ${response.status} ${errorBody}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('OpenAI returned empty response');
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

  /**
   * Try a single Gemini model. Returns the response text, or null if it failed.
   */
  private async tryGeminiModel(model: string, prompt: string, temp: number, maxTokens: number, geminiKey: string): Promise<string | null> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${geminiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: temp, maxOutputTokens: maxTokens }
        })
      });
      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          console.log(`[ReasoningEngine] ${model} succeeded`);
          return text;
        }
        console.warn(`[ReasoningEngine] ${model} returned OK but no text — raw:`, JSON.stringify(data).slice(0, 300));
      } else {
        const errBody = await response.text().catch(() => '');
        console.warn(`[ReasoningEngine] ${model} HTTP ${response.status} — ${errBody.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[ReasoningEngine] ${model} error:`, (err as Error).message);
    }
    return null;
  }

  /**
   * Simple reason method — takes a prompt and returns a text response.
   * Used by handle extraction and other lightweight AI tasks.
   *
   * Fallback chain: gemini-2.5-flash → gemini-1.5-flash → OpenAI → throw
   */
  async reason(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    try {
      const temp = options?.temperature ?? 0.5;
      const maxTokens = options?.maxTokens ?? 8192;

      const geminiKey = process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
      if (geminiKey) {
        // 1. Try gemini-2.5-flash
        let result = await this.tryGeminiModel('gemini-2.5-flash', prompt, temp, maxTokens, geminiKey);
        if (result) return result;

        // 2. Fallback: gemini-1.5-flash (separate rate limit)
        result = await this.tryGeminiModel('gemini-1.5-flash', prompt, temp, maxTokens, geminiKey);
        if (result) return result;
      }

      // 3. Fallback to OpenAI
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: temp,
            max_tokens: maxTokens
          })
        });
        if (response.ok) {
          const data = await response.json();
          const text = data?.choices?.[0]?.message?.content;
          if (text) return text;
        }
      }

      // All providers failed
      console.error('[ReasoningEngine] All AI providers failed (gemini-2.5-flash, gemini-1.5-flash, OpenAI)');
      throw new Error('AI services temporarily unavailable — please try again in a moment.');
    } catch (err) {
      console.error('[ReasoningEngine] reason failed:', (err as Error).message);
      throw err;
    }
  }

  async consult(userId: string, message: string, niche?: string, history?: Array<{ role: string; content: string }>): Promise<{ message: string; stylePreviews?: any[] }> {
    // Fetch user's archetype from active goal — gracefully handle missing/invalid userId
    let archetype = 'creator';
    let businessName = '';
    let businessNiche = '';
    try {
      const [goal] = await db.select({ archetype: schema.goals.archetype }).from(schema.goals).where(eq(schema.goals.userId, userId)).limit(1);
      archetype = (goal as any)?.archetype || 'creator';
    } catch (err) {
      console.warn('[ReasoningEngine] Could not fetch archetype, defaulting to creator:', (err as Error).message);
    }
    try {
      const [settings] = await db.select({ businessNiche: schema.userSettings.businessNiche, businessAngle: schema.userSettings.businessAngle }).from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).limit(1);
      if (settings) {
        businessNiche = (settings as any)?.businessNiche || '';
        businessName = (settings as any)?.businessAngle || '';
      }
    } catch (err) {
      console.warn('[ReasoningEngine] Could not fetch user settings:', (err as Error).message);
    }

    const conversationContext = history && history.length > 0
      ? '\n\nCONVERSATION SO FAR:\n' + history.map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`).join('\n')
      : '';

    const systemPrompt = `You are a short-form video creative director. Be FAST and STRUCTURED. Never write paragraphs.

RULES:
- Give 3 numbered options max per response (e.g. "1. Hook: ... 2. Hook: ... 3. Hook: ...")
- Keep each option to 1-2 sentences. No fluff.
- After they pick, move to the next element: Hook → Visuals → CTA
- Never re-ask about things already decided
- Once Hook, Visuals, and CTA are all picked, give a quick recap of all three choices, then say exactly: "Ready to create! Tap the wand."

USER'S BUSINESS:${businessName ? `\n- Business: ${businessName}` : ''}${businessNiche ? `\n- Niche: ${businessNiche}` : ''}${niche ? `\n- Topic: ${niche}` : ''}${conversationContext}`;

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
