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
  mode?: 'consult' | 'generate';
  brandContext?: {
    name?: string;
    niche?: string;
    targetCustomers?: string;
    businessGoals?: string;
    archetype?: string;
  };
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Durable locked facts from prior sessions (see memoryService.ts). */
  lockedFacts?: Record<string, any>;
}

// ─── AI Router Service ───────────────────────────────────────────────────────

export class AiRouterService {

  /**
   * Route a user's natural language request to the correct AI pipeline.
   * Gemini 2.5 Flash is the sole entry point — it classifies, refines prompts,
   * and returns a structured routing decision. Never generates final media.
   */
  async route(request: RouterRequest): Promise<RouterDecision> {
    const systemPrompt = this.buildSystemPrompt(request.brandContext, request.mode, request.lockedFacts);
    const userMessage = this.buildUserMessage(request);

    try {
      const raw = await reasoningEngine.reason(`${systemPrompt}\n\n${userMessage}`, {
        temperature: 0.3,
        maxTokens: 4096,
      });

      console.log('[AiRouter] Raw AI response:', raw.slice(0, 300));
      return this.applyDeterministicOverrides(this.parseDecision(raw), request);
    } catch (err: any) {
      console.error('[AiRouter] AI routing failed:', err.message);
      // Preserve explicit generation intent even when the model is unavailable.
      return this.applyDeterministicOverrides({
        classification: 'ai_assistant',
        prompt: '',
        parameters: {},
        response: `AI router error: ${err.message}`,
        needsRefinement: true,
      }, request);
    }
  }

  /**
   * The model occasionally treats an explicit video request as a conversation.
   * Generation requests must never be downgraded to chat: the studio route
   * only starts Sora after receiving video_creation. Keep consult mode purely
   * conversational, while providing a deterministic safety net for the wand.
   */
  private applyDeterministicOverrides(decision: RouterDecision, request: RouterRequest): RouterDecision {
    if (request.mode === 'consult' || decision.classification !== 'ai_assistant') return decision;

    const text = request.request.toLowerCase();
    const hasGenerationVerb = /\b(create|make|generate|produce|build|turn)\b/.test(text);
    const hasVideoIntent = /\b(video|promo(?:tional)?|reel|tiktok|commercial|shorts?|ad(?:vertisement)?)\b/.test(text);
    const asksToEdit = /\b(edit|editing|trim|caption(?:s|ed)?|resize|cut|merge|overlay)\b/.test(text);

    // Do not turn a request explicitly about editing existing media into a
    // fresh generation job merely because it mentions a video.
    if (!hasGenerationVerb || !hasVideoIntent || asksToEdit) return decision;

    return {
      ...decision,
      classification: 'video_creation',
      prompt: decision.prompt || request.request,
      needsRefinement: false,
      response: undefined,
    };
  }

  private buildSystemPrompt(brandContext?: RouterRequest['brandContext'], mode?: RouterRequest['mode'], lockedFacts?: Record<string, any>): string {
    const memoryBlock = lockedFacts && Object.keys(lockedFacts).length
      ? `\nSETTLED DECISIONS (do not re-ask — treat as already confirmed by the user):\n${Object.entries(lockedFacts)
          .filter(([,v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
          .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('\n')}\nDo NOT ask about these again. Only ask genuinely NEW questions when real info is still missing.`
      : '';
    const brandInfo = brandContext
      ? `\nBrand: ${brandContext.name || 'Unknown'}\nNiche: ${brandContext.niche || 'General'}\nTarget: ${brandContext.targetCustomers || 'General audience'}\nGoals: ${brandContext.businessGoals || 'Grow business'}`
      : '';

    const consultInstructions = mode === 'consult'
      ? `\nCONSULT MODE: You are chatting with the user to refine their idea before generation. CRITICAL RULES:\n- NEVER ask a clarifying question about anything already answered in the conversation history OR listed in SETTLED DECISIONS below. Those are locked facts.\n- Never ask about UI-set controls (duration, voice, tone, platform, aspect ratio). If the user or SETTLED DECISIONS already states a duration, voice, or tone, treat it as final — do NOT ask "how long?", "what voice?", etc. again.\n- Ask at most ONE genuinely new clarifying question per reply, and only when the info is truly missing and not decided.\n- OFFER A CONCRETE SUGGESTED DEFAULT OPTION ON EVERY clarifying question you ask (vibe, colors, font, background, effects) — a ready-made pick the user can accept in one tap, with a 1-clause reason. Examples: "vibe: I'd suggest energetic & bold for this", "colors: I'd suggest warm amber + creams", "font: I'd suggest a bold rounded sans (Poppins)", "background: I'd suggest a cozy home-studio scene". NEVER ask an open question with no offered option.\n- ONLY SKIP a question (and instead rely on what's already stated) when the user OR the client has SPECIFICALLY already given that answer — e.g. they already named the vibe, font style, colors, or background. Otherwise you ALWAYS offer the suggested option.\n- Be proactive: make confident suggestions. "I think warm amber + a clean sans-serif would trend well — want me to apply that?"\n- Cover vibe/colors, fonts, CTA/text, effects — one area per message, and only if still undecided.\n- NEVER offer: voice-over, music, sound effects, audio, narration, specific actors. Videos are silent — visuals only.\n- When the user says "generate", "let's go", "I'm ready", or "yes that's good": reply "Great, tap the wand to generate!" and set needsRefinement=false.\n- Always classify as "ai_assistant" and fill the "response" field. NEVER classify as video_creation, image_creation, video_editing, image_editing, or final_rendering.`
      : '';

    return `You are the EmpireLaunch AI Router — a smart dispatcher that classifies user creative requests and routes them to the correct AI pipeline.

${brandInfo}${consultInstructions}${memoryBlock}

YOUR ROLE: Classify the user's request and produce a refined prompt for the downstream AI service. You NEVER generate final images or videos yourself.

CLASSIFICATION OPTIONS:
- "ai_assistant" — Brainstorming, captions, hashtags, titles, product descriptions, campaign planning, content ideas. Return conversational response.
- "image_creation" — Product mockups, Etsy/Shopify listing images, social media graphics, marketing graphics, logos, banners, product scenes. Route to GPT Image 2.
- "image_editing" — Background replacement, color adjustments, edits to existing images. Route to GPT Image 2 with edit instructions.
- "video_creation" — Text-to-video, product commercials, TikTok/Reels/Facebook/Pinterest videos, promotional videos, seasonal campaigns, AI twin videos. Route through: source images (if needed) → Sora 2 → FFmpeg packaging.
- EXPLICIT GENERATION RULE: In generate mode, if the user asks to create/make/generate/produce a video, promo, reel, TikTok, commercial, short, or ad (especially with a duration or format), you MUST classify as "video_creation", never "ai_assistant".
- "video_editing" — Captions, trims, resizing, logo overlays on existing video. Route to FFmpeg render service. If new visual content is needed, flag requiresNewVisualContent.
- "final_rendering" — Platform optimization, format conversion, branding/packaging of existing content.

RULES:
- If the request is vague ("I want to make something"), set needsRefinement=true and ask clarifying questions one at a time.
- **Be concise**: Keep responses short and focused. No long paragraphs or walls of text.
- If the user says "you decide" or "whatever you think", confidently pick trending options and explain briefly why.
- **No copycat designs**: All image and video prompts must produce original work. Avoid replicating specific brands, trademarked characters, or copying existing designs. Create inspired-by, not duplicates.
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
      console.warn('[AiRouter] Failed to parse AI JSON. Raw text:', cleaned.slice(0, 200));
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
