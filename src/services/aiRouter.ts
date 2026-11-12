import { reasoningEngine, isPlannerTimeout } from './reasoningEngine.js';

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
  /** Optional structured payload returned by specialized planners (for example scene scripts). */
  script?: any;
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
  /** Studio-launch action hint: the exact UI action the user should tap to start
   *  generation (e.g. "press Launch Project to generate your video" in the
   *  suppressWand Launch Project flow). Falls back to the classic wand copy. */
  actionHint?: string;
}

/** Closing line the consultant replies with when the user says "generate" /
 *  "let's go" / "I'm ready". Defaults to the classic wand copy; Studio Launch
 *  Project flows pass an actionHint so the reply names the REAL button the user
 *  should press (frontend sends it in suppressWand mode). Pure + unit-tested. */
export function consultGenerateReply(actionHint?: string): string {
  const hint = String(actionHint || '').trim();
  return hint.length > 0 ? hint : 'Great, tap the wand to generate!';
}
// ─── AI Router Service ───────────────────────────────────────────────────────

export class AiRouterService {

  /**
   * Route a user's natural language request to the correct AI pipeline.
   * Gemini 2.5 Flash is the sole entry point — it classifies, refines prompts,
   * and returns a structured routing decision. Never generates final media.
   */
  async route(request: RouterRequest): Promise<RouterDecision> {
    const systemPrompt = this.buildSystemPrompt(request.brandContext, request.mode, request.lockedFacts, request.actionHint);
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
      // A STALLED PROVIDER IS NOT AN ANSWER (audit 11 Nov, defect 5). In generate
      // mode this call IS the planner: a timeout must reach the pipeline as a
      // planning failure it can name in plain words ("the step that writes your
      // shot list could not be reached"), never be reshaped into a chat-shaped
      // decision that mislabels why the video was not made. Consult mode keeps
      // degrading to a conversational reply, because a chat is not a plan.
      if (request.mode !== 'consult' && isPlannerTimeout(err)) throw err;
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

  private buildSystemPrompt(brandContext?: RouterRequest['brandContext'], mode?: RouterRequest['mode'], lockedFacts?: Record<string, any>, actionHint?: string): string {
    const memoryBlock = lockedFacts && Object.keys(lockedFacts).length
      ? `\nSETTLED DECISIONS (do not re-ask — treat as already confirmed by the user):\n${Object.entries(lockedFacts)
          .filter(([,v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
          .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('\n')}\nDo NOT ask about these again. Only ask genuinely NEW questions when real info is still missing.`
      : '';
    const brandInfo = brandContext
      ? `\nBrand: ${brandContext.name || 'Unknown'}\nNiche: ${brandContext.niche || 'General'}\nTarget: ${brandContext.targetCustomers || 'General audience'}\nGoals: ${brandContext.businessGoals || 'Grow business'}`
      : '';

    const consultInstructions = mode === 'consult'
      ? `\nCONSULT MODE: You are chatting with the user to refine their idea before generation. CRITICAL RULES:\n- NEVER ask a clarifying question about anything already answered in the conversation history OR listed in SETTLED DECISIONS below. Those are locked facts.\n- Never ask about UI-set controls (duration, voice, tone, platform, aspect ratio). If the user or SETTLED DECISIONS already states a duration, voice, or tone, treat it as final — do NOT ask "how long?", "what voice?", etc. again.\n- Ask at most ONE genuinely new clarifying question per reply, and only when the info is truly missing and not decided.\n- WHAT THE USER DESCRIBES IS THE INSTRUCTION, NOT A SUGGESTION. Anything they state (subject, scene, background, colors, mood) is used EXACTLY as stated — never replaced by your own idea of what looks good.
- NEVER INVENT A SUBJECT OR BACKGROUND. If the user has not said what should be in the video (who or what is on screen, where it happens), ASK them — that is their decision, not yours. You may offer a concrete option, but it MUST be built out of THEIR OWN words and THEIR product/brand, with a 1-clause reason tied to what they told you. If their message gives you nothing to build on, ask an open question instead of offering an invented one.
- BANNED STOCK CLICHÉS (never offer, never fall back to): a man standing in front of a gold tower, a skyscraper, a businessperson in a suit, a handshake, a generic "cozy home-studio scene". These are the blandest possible answer and the user has explicitly rejected them.
- You may still offer a concrete pick for things they asked you to style (vibe, colors, font, effects) — one per message, with a 1-clause reason drawn from their message.\n- ONLY SKIP a question (and instead rely on what's already stated) when the user OR the client has SPECIFICALLY already given that answer — e.g. they already named the vibe, font style, colors, or background. Otherwise you ALWAYS ask — and any pick you offer alongside the question must come from THEIR message, never from a stock default.\n- Be proactive: make confident suggestions. "I think warm amber + a clean sans-serif would trend well — want me to apply that?"\n- Cover vibe/colors, fonts, CTA/text, effects — one area per message, and only if still undecided.\n- NEVER offer: voice-over, music, sound effects, audio, narration, specific actors. Videos are silent — visuals only.\n- When the user says "generate", "let's go", "I'm ready", or "yes that's good": reply "${consultGenerateReply(actionHint)}" and set needsRefinement=false.\n- Always classify as "ai_assistant" and fill the "response" field. NEVER classify as video_creation, image_creation, video_editing, image_editing, or final_rendering.`
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
- If the user says "you decide" or "whatever you think", DECIDE FROM THEIR MESSAGE: pick the option that follows from the product, audience and words they already gave you, and say in one line why it follows from what they said. Never answer "you decide" with a generic stock choice (no gold tower, no skyscraper, no suit, no handshake, no "cozy home-studio"). If their message genuinely gives you nothing to decide from, ask one short question about THEIR business instead of inventing an answer.
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
        // Specialized planner calls may return a structured script/scenes
        // payload instead of the normal router fields. Preserve it so the
        // caller does not silently fall back to a polluted raw chat transcript.
        // IMPORTANT: for the Scene hybrid director, the planner returns the FULL
        // object { soraContent, scenes:[{type:"sora"|"gpt-image",...}] }. The old
        // clause below kept ONLY {scenes:[...]} (dropping top-level soraContent),
        // which made parseScenePlan's hybrid gate always fail and silently fell
        // back to per-scene Sora (5 calls). Preserve the WHOLE parsed object when
        // it carries scenes (and/or soraContent) so the hybrid path can engage.
        script: parsed.script
          || parsed.parameters?.script
          || (Array.isArray(parsed.scenes) || parsed.soraContent ? parsed : undefined),
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
