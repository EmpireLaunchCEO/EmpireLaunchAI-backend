import { reasoningEngine } from './reasoningEngine.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Classification =
  | 'ai_assistant'
  | 'image_creation'
  | 'image_editing'
  | 'video_creation'
  | 'video_editing'
  | 'final_rendering';

export interface RouterParameters {
  platform?: string;       // 'tiktok', 'etsy', 'shopify', 'instagram', etc.
  aspectRatio?: string;    // '9:16', '1:1', '16:9', '4:5'
  duration?: number;       // seconds for video
  brandName?: string;
  brandColors?: string[];
  [key: string]: any;
}

export interface RouterDecision {
  classification: Classification;
  prompt: string;                     // Refined prompt for downstream AI service
  parameters: RouterParameters;
  requiresSourceImages?: boolean;     // Video needs GPT Image 2 first
  requiresNewVisualContent?: boolean; // Video editing needs AI generation
  response?: string;                  // Natural language response (ai_assistant / interactive)
  needsRefinement?: boolean;          // If true, return to user for more input
}

export interface RouterRequest {
  userId: string;
  request: string;
  brandContext?: {
    name?: string;
    niche?: string;
    targetCustomers?: string;
    businessGoals?: string;
    archetype?: string;
  };
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// ─── AI Router Service ───────────────────────────────────────────────────────

export class AiRouterService {

  /**
   * Route a user's natural language request to the correct AI pipeline.
   * Gemini 2.5 Flash is the sole entry point — it classifies, refines prompts,
   * and returns a structured routing decision. Never generates final media.
   */
  async route(request: RouterRequest): Promise<RouterDecision> {
    const systemPrompt = this.buildSystemPrompt(request.brandContext);
    const userMessage = this.buildUserMessage(request);

    try {
      const raw = await reasoningEngine.reason(`${systemPrompt}\n\n${userMessage}`, {
        temperature: 0.3,
        maxTokens: 1024,
      });

      return this.parseDecision(raw);
    } catch (err: any) {
      console.error('[AiRouter] Gemini routing failed:', err.message);
      // Fallback: classify as ai_assistant and return error message
      return {
        classification: 'ai_assistant',
        prompt: '',
        parameters: {},
        response: "I'm sorry, I had trouble understanding that. Could you rephrase what you'd like to create?",
        needsRefinement: true,
      };
    }
  }

  private buildSystemPrompt(brandContext?: RouterRequest['brandContext']): string {
    const brandInfo = brandContext
      ? `\nBrand: ${brandContext.name || 'Unknown'}\nNiche: ${brandContext.niche || 'General'}\nTarget: ${brandContext.targetCustomers || 'General audience'}\nGoals: ${brandContext.businessGoals || 'Grow business'}`
      : '';

    return `You are the EmpireLaunch AI Router — a smart dispatcher that classifies user creative requests and routes them to the correct AI pipeline.

${brandInfo}

YOUR ROLE: Classify the user's request and produce a refined prompt for the downstream AI service. You NEVER generate final images or videos yourself.

CLASSIFICATION OPTIONS:
- "ai_assistant" — Brainstorming, captions, hashtags, titles, product descriptions, campaign planning, content ideas. Return conversational response.
- "image_creation" — Product mockups, Etsy/Shopify listing images, social media graphics, marketing graphics, logos, banners, product scenes. Route to GPT Image 2.
- "image_editing" — Background replacement, color adjustments, edits to existing images. Route to GPT Image 2 with edit instructions.
- "video_creation" — Text-to-video, product commercials, TikTok/Reels/Facebook/Pinterest videos, promotional videos, seasonal campaigns, AI twin videos. Route through: source images (if needed) → Sora 2 → FFmpeg packaging.
- "video_editing" — Captions, trims, resizing, logo overlays on existing video. Route to FFmpeg render service. If new visual content is needed, flag requiresNewVisualContent.
- "final_rendering" — Platform optimization, format conversion, branding/packaging of existing content.

RULES:
- If the request is vague ("I want to make something"), set needsRefinement=true and ask clarifying questions.
- For ai_assistant, return response directly — do not route to any service.
- For video_creation that needs source images, set requiresSourceImages=true.
- For video_editing needing new visuals, set requiresNewVisualContent=true.
- Always infer platform from context ("TikTok", "Instagram", "Etsy").
- Output MUST be valid JSON only — no markdown, no explanation.`;
  }

  private buildUserMessage(request: RouterRequest): string {
    const history = request.conversationHistory?.length
      ? `\nConversation history:\n${request.conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}`
      : '';

    return `User request: "${request.request}"${history}

Return ONLY a JSON object with this exact structure:
{
  "classification": "one of the six options",
  "prompt": "refined prompt for the downstream AI service",
  "parameters": { "platform": "...", "aspectRatio": "...", "duration": number or null },
  "requiresSourceImages": boolean or null,
  "requiresNewVisualContent": boolean or null,
  "response": "natural language response for ai_assistant or refinement questions",
  "needsRefinement": boolean
}`;
  }

  private parseDecision(raw: string): RouterDecision {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned);
      return {
        classification: this.validateClassification(parsed.classification),
        prompt: parsed.prompt || '',
        parameters: {
          platform: parsed.parameters?.platform,
          aspectRatio: parsed.parameters?.aspectRatio,
          duration: parsed.parameters?.duration,
          brandName: parsed.parameters?.brandName,
          brandColors: parsed.parameters?.brandColors,
          ...parsed.parameters,
        },
        requiresSourceImages: parsed.requiresSourceImages || false,
        requiresNewVisualContent: parsed.requiresNewVisualContent || false,
        response: parsed.response,
        needsRefinement: parsed.needsRefinement || false,
      };
    } catch {
      console.warn('[AiRouter] Failed to parse Gemini JSON, treating as ai_assistant');
      return {
        classification: 'ai_assistant',
        prompt: '',
        parameters: {},
        response: cleaned.slice(0, 500),
        needsRefinement: false,
      };
    }
  }

  private validateClassification(raw: string): Classification {
    const valid: Classification[] = [
      'ai_assistant', 'image_creation', 'image_editing',
      'video_creation', 'video_editing', 'final_rendering',
    ];
    return valid.includes(raw as Classification) ? (raw as Classification) : 'ai_assistant';
  }
}

export const aiRouter = new AiRouterService();
