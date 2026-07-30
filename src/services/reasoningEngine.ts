import { getModelConfig } from '../utils/resolveModel.js';
import { stylePreviewService } from './stylePreviewService.js';
import { getMasterBriefing } from './strategicDirective.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

// Maximum conversation history messages to keep context under 128K tokens
const MAX_HISTORY_MESSAGES = 12;

export class ReasoningEngine {

  /**
   * Primary AI call: GPT 5.2 first, Gemini 2.5 Flash fallback.
   * Used by consult(), reasonDesign(), and synthesizeDNA().
   */
  private async callAI(systemPrompt: string, userMessage: string): Promise<string> {
    // 1. Try GPT 5.2 (primary)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`
          },
          body: JSON.stringify({
            model: 'gpt-5.2',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage }
            ],
            temperature: 0.5,
            max_completion_tokens: 8192
          })
        });
        if (response.ok) {
          const data = await response.json();
          const text = data?.choices?.[0]?.message?.content;
          if (text) {
            console.log('[ReasoningEngine] GPT 5.2 succeeded');
            return text;
          }
        }
        const errBody = await response.text().catch(() => '');
        console.warn(`[ReasoningEngine] GPT 5.2 failed: ${response.status} — ${errBody.slice(0, 200)}`);
      } catch (err) {
        console.warn('[ReasoningEngine] GPT 5.2 error, falling back to Gemini:', (err as Error).message);
      }
    }

    // 2. Fallback to Gemini 2.5 Flash
    const geminiKey = process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
    if (geminiKey) {
      const result = await this.tryGeminiModel('gemini-2.5-flash', `${systemPrompt}\n\n${userMessage}`, 0.5, 8192, geminiKey);
      if (result) return result;
    }

    throw new Error('AI services temporarily unavailable — both GPT 5.2 and Gemini are down.');
  }

  /**
   * Try a single Gemini model. Returns the response text, or null if it failed.
   * On 429 (rate limit), waits 1s and retries once before giving up.
   */
  private async tryGeminiModel(model: string, prompt: string, temp: number, maxTokens: number, geminiKey: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
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
            console.log(`[ReasoningEngine] Gemini ${model} succeeded`);
            return text;
          }
          console.warn(`[ReasoningEngine] Gemini ${model} returned OK but no text`);
        } else if (response.status === 429 && attempt === 0) {
          console.warn(`[ReasoningEngine] Gemini ${model} rate limited (429), waiting 1s...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        } else {
          const errBody = await response.text().catch(() => '');
          console.warn(`[ReasoningEngine] Gemini ${model} HTTP ${response.status} — ${errBody.slice(0, 200)}`);
        }
      } catch (err) {
        console.warn(`[ReasoningEngine] Gemini ${model} error:`, (err as Error).message);
      }
      return null;
    }
    return null;
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
      return await this.callAI(systemPrompt, `You are acting as the Design Reasoner. Create a multi-step execution plan for this specific goal: ${goal}`);
    } catch (err) {
      console.error('[ReasoningEngine] reasonDesign AI call failed:', (err as Error).message);
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
      const text = await this.callAI(systemPrompt, JSON.stringify(dnaStrands));
      return JSON.parse(text);
    } catch {
      return dnaStrands;
    }
  }

  /**
   * Simple reason method — takes a prompt and returns a text response.
   * Used by handle extraction and other lightweight AI tasks.
   *
   * Primary: GPT 5.2 → Fallback: Gemini 2.5 Flash
   */
  async reason(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    try {
      const temp = options?.temperature ?? 0.5;
      const maxTokens = options?.maxTokens ?? 8192;

      // 1. Try GPT 5.2 (primary)
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        try {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openaiKey}`
            },
            body: JSON.stringify({
              model: 'gpt-5.2',
              messages: [{ role: 'user', content: prompt }],
              temperature: temp,
              max_completion_tokens: maxTokens
            })
          });
          if (response.ok) {
            const data = await response.json();
            const text = data?.choices?.[0]?.message?.content;
            if (text) {
              console.log('[ReasoningEngine] GPT 5.2 succeeded (reason)');
              return text;
            }
          }
          const errBody = await response.text().catch(() => '');
          console.warn(`[ReasoningEngine] GPT 5.2 failed (reason): ${response.status} — ${errBody.slice(0, 200)}`);
        } catch (err) {
          console.warn('[ReasoningEngine] GPT 5.2 error (reason), falling back to Gemini:', (err as Error).message);
        }
      }

      // 2. Fallback to Gemini
      const geminiKey = process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
      if (geminiKey) {
        const result = await this.tryGeminiModel('gemini-2.5-flash', prompt, temp, maxTokens, geminiKey);
        if (result) return result;
      }

      throw new Error('AI services temporarily unavailable — both GPT 5.2 and Gemini are down.');
    } catch (err) {
      console.error('[ReasoningEngine] reason failed:', (err as Error).message);
      throw err;
    }
  }

  async consult(userId: string, message: string, niche?: string, history?: Array<{ role: string; content: string }>): Promise<{ message: string; stylePreviews?: any[] }> {
    // Fetch user's archetype from active goal
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

    // Cap conversation history to prevent 128K context threshold (4x cost jump)
    let recentHistory = history || [];
    if (recentHistory.length > MAX_HISTORY_MESSAGES) {
      console.log(`[ReasoningEngine] Truncating history from ${recentHistory.length} to ${MAX_HISTORY_MESSAGES} messages (128K context guard)`);
      recentHistory = recentHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    const conversationContext = recentHistory.length > 0
      ? '\n\nCONVERSATION SO FAR:\n' + recentHistory.map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`).join('\n')
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
      content = await this.callAI(systemPrompt, message);
    } catch (err) {
      console.error('[ReasoningEngine] callAI failed:', (err as Error).message);
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
