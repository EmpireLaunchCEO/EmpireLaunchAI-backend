import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
import { eq, desc, and, sql } from 'drizzle-orm';
import { canvaService } from './canvaService.js';
import { hunterGathererService } from './hunterGathererService.js';
import { integrationService } from './integrationService.js';
import { notificationService } from './notificationService.js';
import { webSocketService } from './websocketService.js';
import { neuralBrowserQueue } from './queueService.js';
import { distributionQueue } from './queueService.js';
import { dnaVaultService } from './dnaVaultService.js';
import { aiScriptingService } from './aiScriptingService.js';
import { resolveModelForUser, getModelConfig, resolveStudioReasoner } from '../utils/resolveModel.js';
import { uniquenessService } from './uniquenessService.js';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * StyleDNA — parameterizes AI generation across all creative tools.
 * Colors, Fonts, Pacing, Hooks define the "vibe" of the empire.
 */
export interface StyleDNA {
  colors: string[];        // e.g. ['#1a1a2e', '#16213e', '#0f3460']
  fonts: string[];         // e.g. ['Playfair Display', 'Inter']
  pacing: 'fast' | 'moderate' | 'slow';
  hooks: string[];         // e.g. ['Stop scrolling if...', 'You won\'t believe...']
  keywords: string[];      // SEO/hashtag keywords
  tone: string;            // 'professional' | 'playful' | 'aggressive' | 'minimalist'
}

/**
 * Supported social and marketplace platforms for distribution.
 */
export type SocialPlatform = 'tiktok' | 'instagram' | 'youtube' | 'facebook' | 'etsy' | 'fiverr' | 'shopify';

/**
 * Strategy for creating the master asset.
 * Defaults to free-tier tools first (Canva Free), falls back to Hunter-Gatherer.
 */
export type CreationStrategy = 'canva_api' | 'canva_browser' | 'manual' | 'openai' | 'vault_synthesis';

export class EmpireStudioService {
  // ─── PUBLIC API ────────────────────────────────────────────────────────

  /**
   * Full creation pipeline:
   * 1. Accept StyleDNA + campaign info (or auto-resolve from Vault)
   * 2. Generate a single master video/image/PDF asset
   * 3. Store asset URL + StyleDNA in `master_assets` table
   * 4. Populate distribution queue for ALL selected platforms
   * 5. Return the campaign record with asset references
   */
  async createAndDistribute(params: {
    userId: string;
    campaignId?: string;
    niche: string;
    angle: string;
    styleDna?: StyleDNA;     // Optional — resolve from Vault if missing
    platforms: SocialPlatform[];
    title?: string;
    description?: string;
    price?: number;          // in cents
    scheduleInMinutes?: number; // minutes from now to schedule
    archetype?: string;
  }) {
    const {
      userId, campaignId: existingCampaignId, niche, angle,
      platforms, title, description, price, scheduleInMinutes, archetype
    } = params;

    const assetId = uuidv4();
    const campaignId = existingCampaignId || uuidv4();

    // Notify user that creation is starting
    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🎬 Empire Studio: Initializing design flow for "${niche}"...`
    });

    // Step 1: Resolve StyleDNA — either provided, or injected from Vault, or AI-generated
    const styleDna = params.styleDna || await this.resolveStyleDnaFromVault(userId, niche, angle, archetype);

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🧬 Studio DNA loaded: ${styleDna.colors.length} colors, ${styleDna.fonts.length} fonts, tone: ${styleDna.tone}`
    });

    // Step 2: Run the High-Intelligence Design Reasoner before generating
    const designReasoning = await this.runDesignReasoner(userId, {
      niche, angle, styleDna, title: title || `${niche} - ${angle}`, archetype
    });

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🧠 Design Intel: ${designReasoning.strategy} — ${designReasoning.reasoning}`
    });

    // Step 3: Generate the master asset using enriched DNA + reasoning
    const masterResult = await this.generateMasterAsset(userId, {
      niche, angle, styleDna, assetId, title: title || `${niche} - ${angle}`,
      designReasoning, archetype,
    });

    // Step 3.5: Anti-Copycat Uniqueness Gate
    const uniqueness = await uniquenessService.validateUniqueness({
      userId,
      niche,
      content: (title || niche) + " " + (description || angle),
      vaultStrandsUsed: designReasoning.vaultStrandsUsed,
    });

    if (!uniqueness.isUnique) {
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `🛡️ Anti-Copycat: Design pivot suggested. ${uniqueness.reasoning}`
      });
    }

    // Step 4: Persist the master asset record with style DNA + vault references
    const assetData: any = {
      id: assetId,
      userId,
      campaignId,
      styleDna: {
        ...styleDna,
        uniquenessScore: uniqueness.semanticScore,
      },
      assetType: masterResult.assetType,
      status: 'completed',
      masterVideoUrl: masterResult.videoUrl || null,
      masterImageUrl: masterResult.imageUrl || null,
      masterPdfUrl: masterResult.pdfUrl || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Track which DNA strands contributed
    if (designReasoning.vaultStrandsUsed && designReasoning.vaultStrandsUsed.length > 0) {
      assetData.styleDnaSource = 'vault';
      assetData.styleDnaStrandIds = designReasoning.vaultStrandsUsed;
    }

    // Upsert master asset
    const existing = await db.select().from(schema.masterAssets)
      .where(eq(schema.masterAssets.id, assetId)).limit(1);

    if (existing.length > 0) {
      await db.update(schema.masterAssets)
        .set({
          status: 'completed',
          masterVideoUrl: assetData.masterVideoUrl,
          masterImageUrl: assetData.masterImageUrl,
          masterPdfUrl: assetData.masterPdfUrl,
          styleDna,
          updatedAt: new Date(),
        })
        .where(eq(schema.masterAssets.id, assetId));
    } else {
      await db.insert(schema.masterAssets).values(assetData);
    }

    // Step 5: Ensure campaign exists
    const campaignExists = await db.select().from(schema.campaigns)
      .where(eq(schema.campaigns.id, campaignId)).limit(1);

    if (campaignExists.length === 0) {
      await db.insert(schema.campaigns).values({
        id: campaignId,
        userId,
        name: title || `${niche} Campaign`,
        tone: styleDna.tone,
        frequency: 'daily',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Step 6: Queue distribution for each platform
    const scheduledFor = new Date();
    if (scheduleInMinutes) {
      scheduledFor.setMinutes(scheduledFor.getMinutes() + scheduleInMinutes);
    }

    const queueResults: Array<{ platform: SocialPlatform; jobId: string; status: string }> = [];

    for (const platform of platforms) {
      const result = await this.enqueueDistribution({
        userId,
        campaignId,
        assetId,
        platform,
        masterResult,
        styleDna,
        title: title || `${niche} - ${angle}`,
        description,
        price,
        scheduledFor,
        niche,
        angle,
      });
      queueResults.push(result);
    }

    // Step 7: Notify user
    const platformNames = platforms.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');
    await notificationService.notifyUser(
      userId,
      `🎬 Empire Studio: Master asset created for "${niche}". Queued for distribution to ${platformNames}. Please review before posting.`,
      true
    );

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `✅ Empire Studio complete. Master asset created. Distribution queued for: ${platformNames}`
    });

    return {
      campaignId,
      assetId,
      masterAssetUrl: masterResult.videoUrl || masterResult.imageUrl || masterResult.pdfUrl,
      assetType: masterResult.assetType,
      styleDna,
      designReasoning: designReasoning.strategy,
      queueResults,
      scheduledFor,
    };
  }

  // ─── VAULT DNA INJECTION ──────────────────────────────────────────────

  /**
   * Resolves best-fit StyleDNA from the Universal Vault for a given niche.
   * Queries top-performing DNA strands and synthesizes them into a StyleDNA object.
   */
  private async resolveStyleDnaFromVault(userId: string, niche: string, angle: string, archetype: string = 'creator'): Promise<StyleDNA> {
    console.log(`[EmpireStudio] Resolving StyleDNA from Vault for "${niche}" (archetype: ${archetype})`);

    // Phase 1: Query the Vault for top-performing strands relevant to this niche
    const layoutStrands = await dnaVaultService.findTopPerformers('layout', 70, 5);
    const paletteStrands = await dnaVaultService.findTopPerformers('palette', 70, 5);
    const typographyStrands = await dnaVaultService.findTopPerformers('typography', 70, 5);
    const patternStrands = await dnaVaultService.findTopPerformers('niche_pattern', 70, 5);

    // Phase 2: AI-powered synthesis — combine vault data with niche intelligence
    try {
      const model = await resolveModelForUser(userId);

        const template = `
          You are a Style DNA Architect for the "{niche}" niche (angle: "{angle}").
          The business archetype is "{archetype}" (creator = product design, catalyst = marketing/viral growth).

          Available vault DNA strands:
          Layouts: {layoutStrands}
          Color Palettes: {paletteStrands}
          Typography: {typographyStrands}
          Niche Patterns: {patternStrands}

          Analyze these and generate an optimal StyleDNA object. Be analytical and specific.
          Use the vault data as inspiration but produce unique, high-converting combinations.
          For 'catalyst' archetype, prioritize high-contrast, high-energy palettes and aggressive/engaging hooks.
          For 'creator' archetype, prioritize professional/aesthetic layouts and niche-specific fonts.

          Return a JSON object:
          - colors: string[] (3 hex color codes — pick the best from palette strands or create)
          - fonts: string[] (2-3 Google Font names — pick from typography strands or create)
          - pacing: "fast" | "moderate" | "slow" (match the niche's ideal content pace)
          - hooks: string[] (3 attention-grabbing hooks tailored to {niche} and {angle})
          - keywords: string[] (8-10 SEO-optimized keywords for this niche)
          - tone: "professional" | "playful" | "aggressive" | "minimalist" (best fit for {angle})
          - vaultInspired: boolean (whether vault data influenced this DNA)

          Only respond with valid JSON.
        `;

        const prompt = PromptTemplate.fromTemplate(template);
        const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);

        const result = await chain.invoke({
          niche,
          angle,
          archetype,
          layoutStrands: JSON.stringify(layoutStrands.map(s => ({ category: s.category, subCategory: s.subCategory, score: s.performanceScore, manifest: s.manifest }))),
          paletteStrands: JSON.stringify(paletteStrands.map(s => ({ category: s.category, subCategory: s.subCategory, score: s.performanceScore, manifest: s.manifest }))),
          typographyStrands: JSON.stringify(typographyStrands.map(s => ({ category: s.category, subCategory: s.subCategory, score: s.performanceScore, manifest: s.manifest }))),
          patternStrands: JSON.stringify(patternStrands.map(s => ({ category: s.category, subCategory: s.subCategory, score: s.performanceScore, manifest: s.manifest }))),
        }) as any;

        if (result.colors && result.fonts && result.tone) {
          console.log(`[EmpireStudio] Vault-injected StyleDNA generated for "${niche}" (vaultInspired: ${!!result.vaultInspired})`);
          return {
            colors: result.colors,
            fonts: result.fonts,
            pacing: result.pacing || 'moderate',
            hooks: result.hooks || ['Discover the difference'],
            keywords: result.keywords || [niche, angle],
            tone: result.tone || 'professional',
          };
        }
        } catch (e) {
        console.warn('[EmpireStudio] Vault DNA synthesis failed:', (e as Error).message);
        }

    // Fallback: Synthesize directly from vault strands
    const fallbackColors = paletteStrands.length > 0
      ? this.extractColorsFromPaletteStrands(paletteStrands)
      : ['#1a1a2e', '#16213e', '#0f3460'];

    const fallbackFonts = typographyStrands.length > 0
      ? typographyStrands.map(s => s.manifest.fontFamily || s.manifest.pairWith).filter(Boolean).slice(0, 3)
      : ['Inter', 'Playfair Display'];

    const fallbackHooks = patternStrands.length > 0
      ? patternStrands.slice(0, 3).map(s => `${s.manifest.hookStyle || s.manifest.ctaStyle} for ${niche}`)
      : [`Stop scrolling if you want the best ${niche} solution`, `Transform your ${niche} journey today`];

    return {
      colors: fallbackColors,
      fonts: fallbackFonts.length > 0 ? fallbackFonts as string[] : ['Inter', 'Open Sans'],
      pacing: 'moderate',
      hooks: fallbackHooks,
      keywords: [niche, angle, 'digital', 'premium', 'design'],
      tone: 'professional',
    };
  }

  /**
   * Extract hex colors from palette strand manifests.
   */
  private extractColorsFromPaletteStrands(strands: any[]): string[] {
    const colors: string[] = [];
    for (const s of strands) {
      const m = s.manifest;
      if (m.primary) colors.push(m.primary);
      if (m.secondary) colors.push(m.secondary);
      if (m.accent) colors.push(m.accent);
      if (m.background && colors.length < 3) colors.push(m.background);
      if (m.colorPalette && Array.isArray(m.colorPalette)) {
        for (const c of m.colorPalette) {
          if (colors.length < 3) colors.push(c);
        }
      }
      if (colors.length >= 3) break;
    }
    return colors.length >= 3 ? colors.slice(0, 3) : ['#1a1a2e', '#16213e', '#0f3460'];
  }

  // ─── HIGH INTELLIGENCE DESIGN REASONER ──────────────────────────────

  /**
   * Runs a high-intelligence reasoning pass before generation.
   * Analyzes the niche, angle, and DNA to determine the optimal design strategy.
   * EMPIRE_MASTER users get deeper reasoning (gpt-4o).
   */
  private async runDesignReasoner(userId: string, params: {
    niche: string; angle: string; styleDna: StyleDNA; title: string; archetype?: string;
  }): Promise<{
    strategy: string;
    reasoning: string;
    templateStyle: string;
    suggestedHooks: string[];
    vaultStrandsUsed: string[];
  }> {
    // Get tier config to determine reasoning depth
    const modelConfig = await getModelConfig(userId);
    const isDeepReasoning = modelConfig.modelName === 'gemini-1.5-pro';
    const archetype = params.archetype || 'creator';

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🧠 Studio Intelligence: High-Reasoning Layer Activated (Gemini 3 Flash logic)`
    });

    // Query the vault for relevant strands to provide as context
    const relevantStrands = [
      ...(await dnaVaultService.findTopPerformers('niche_pattern', 60, 3)),
      ...(await dnaVaultService.findTopPerformers('layout', 75, 2)),
    ];

    // Run AI reasoning using the dedicated Studio Reasoner (Gemini)
    try {
      const model = await resolveStudioReasoner();

      const template = `
        You are the Empire Studio Intelligence Layer (High-Reasoning Designer).
        
        System Status: {reasoningTier}
        Business Archetype: {archetype} (creator = product design, catalyst = marketing/viral growth).
        
        Task: Design an optimal content strategy for:
        - Niche: {niche}
        - Angle: {angle}
        - Title: {title}
        - StyleDNA: {styleDna}

        Available Vault DNA (top-performing patterns in this space):
        {vaultContext}

        Analyze this problem step-by-step:
        1. What visual style will maximize conversion for {niche} and the given {archetype}?
        2. Which platforms will this perform best on, and why?
        3. What hook/CTA combination drives the most engagement?
        4. How should the DNA be optimized for {angle}?
        5. What anti-copycat measures make this unique (ensure no similarity to vault patterns)?

        Return JSON:
        - strategy: "Vault Synthesis" | "AI Generated" | "Template Match" 
        - reasoning: string (1-2 sentences explaining the approach)
        - templateStyle: string (e.g. "Minimalist Professional", "Bold Vibrant", "Earthy Natural")
        - suggestedHooks: string[] (2-3 hooks optimized for this niche)
        - vaultStrandsUsed: string[] (IDs of any vault strands that influenced this, empty if none)
      `;

      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);

      const result = await chain.invoke({
        reasoningTier: isDeepReasoning ? 'Premium Deep Reasoning' : 'Standard Intelligence',
        archetype,
        niche: params.niche,
        angle: params.angle,
        title: params.title,
        styleDna: JSON.stringify(params.styleDna),
        vaultContext: JSON.stringify(relevantStrands.map(s => ({
          id: s.id,
          category: s.category,
          subCategory: s.subCategory,
          score: s.performanceScore,
          manifest: s.manifest,
        }))),
      }) as any;

      return {
        strategy: result.strategy || 'AI Generated',
        reasoning: result.reasoning || 'Optimizing for niche engagement',
        templateStyle: result.templateStyle || 'Modern Professional',
        suggestedHooks: result.suggestedHooks || params.styleDna.hooks.slice(0, 3),
        vaultStrandsUsed: result.vaultStrandsUsed || [],
      };
    } catch (e) {
      console.warn('[EmpireStudio] Design reasoner failed:', (e as Error).message);
    }

    // Fallback reasoning
    return {
      strategy: 'AI Generated',
      reasoning: `Creating a high-impact asset for ${params.niche} using brand DNA`,
      templateStyle: params.styleDna.tone === 'professional' ? 'Minimalist Professional' : 'Bold Creative',
      suggestedHooks: params.styleDna.hooks.slice(0, 3),
      vaultStrandsUsed: relevantStrands.filter(s => s.performanceScore > 80).map(s => s.id || ''),
    };
  }

  // ─── MASTER ASSET GENERATION ──────────────────────────────────────────

  /**
   * Generates the SINGLE master asset using the free-first strategy:
   * 1. Try Canva API (free templates)
   * 2. Fallback: Canva Browser via Hunter-Gatherer
   * 3. Final fallback: generate asset metadata for manual/OpenAI creation
   */
  private async generateMasterAsset(
    userId: string,
    params: {
      niche: string;
      angle: string;
      styleDna: StyleDNA;
      assetId: string;
      title: string;
      designReasoning: any;
      archetype?: string;
    }
  ): Promise<{
    videoUrl?: string;
    imageUrl?: string;
    pdfUrl?: string;
    assetType: 'video' | 'image' | 'pdf';
    strategy: CreationStrategy;
  }> {
    const { niche, angle, styleDna, title, designReasoning } = params;

    // Check if Canva API is available
    const canvaCreds = await integrationService.getCredentials(userId, 'canva');

    if (canvaCreds && canvaCreds.accessToken) {
      try {
        webSocketService.notifyUser(userId, 'ai-log', {
          message: `🎨 Studio: Using Canva API with "${designReasoning.templateStyle}" style...`
        });
        return await this.generateViaCanvaAPI(userId, {
          niche, angle, styleDna, title,
          templateStyle: designReasoning.templateStyle,
        });
      } catch (apiError: any) {
        console.warn(`[EmpireStudio] Canva API failed: ${apiError.message}. Falling back to browser...`);
        webSocketService.notifyUser(userId, 'ai-log', {
          message: `⚠️ Canva API unavailable. Switching to free-tier browser mode...`
        });
      }
    }

    // Fallback: Canva Browser via Hunter-Gatherer
    try {
      return await this.generateViaBrowserFallback(userId, { niche, angle, styleDna, title });
    } catch (browserError: any) {
      console.error(`[EmpireStudio] Browser fallback failed: ${browserError.message}`);
    }

    // Last resort: return null URLs with a manual strategy marker
    webSocketService.notifyUser(userId, 'ai-log', {
      message: `ℹ️ Empire Studio: Cannot auto-generate asset. Please use the "Manual Assisted" flow in your dashboard.`
    });

    return {
      assetType: 'pdf',
      strategy: 'manual',
    };
  }

  /**
   * Canva API generation: search for free templates, autofill with DNA, export.
   */
  private async generateViaCanvaAPI(
    userId: string,
    params: { niche: string; angle: string; styleDna: StyleDNA; title: string; templateStyle: string }
  ): Promise<{
    imageUrl?: string;
    pdfUrl?: string;
    assetType: 'image' | 'pdf';
    strategy: CreationStrategy;
  }> {
    const { niche, styleDna, title, templateStyle } = params;

    // Construct the prompt/augmentation data using the StyleDNA
    const autofillData = {
      title,
      subtitle: `Your ${niche} solution`,
      colors: styleDna.colors,
      fonts: styleDna.fonts,
      keywords: styleDna.keywords.slice(0, 5).join(', '),
      hook: styleDna.hooks[0] || 'Discover the difference',
    };

    // Search for a template matching the niche + style DNA
    const templateIds = await canvaService.searchTemplates(
      userId,
      templateStyle || styleDna.tone,
      niche
    );

    if (templateIds.length === 0) {
      throw new Error('No matching Canva templates found');
    }

    // Autofill the first matching template
    const designId = await canvaService.autofillDesign(userId, templateIds[0], autofillData);

    // Export as PDF for marketplace listings
    const exportUrl = await canvaService.exportDesign(userId, designId);

    return {
      pdfUrl: exportUrl,
      assetType: 'pdf',
      strategy: 'canva_api',
    };
  }

  /**
   * Browser fallback: uses Hunter-Gatherer to navigate Canva and download a design.
   */
  private async generateViaBrowserFallback(
    userId: string,
    params: { niche: string; angle: string; styleDna: StyleDNA; title: string }
  ): Promise<{
    imageUrl?: string;
    assetType: 'image';
    strategy: CreationStrategy;
  }> {
    const harvestingResult = await hunterGathererService.triggerHarvesting(userId, {
      platform: 'canva',
      objective: 'DOWNLOAD_ASSET',
      params: {
        niche: params.niche,
        styleDna: params.styleDna,
        designId: 'NEW',
      },
    });

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🔍 Hunter-Gatherer dispatched to Canva browser for "${params.title}".`
    });

    return {
      imageUrl: harvestingResult.jobId ? `hunter-gatherer://${harvestingResult.jobId}` : undefined,
      assetType: 'image',
      strategy: 'canva_browser',
    };
  }

  // ─── DISTRIBUTION ENQUEUE ─────────────────────────────────────────────

  private async enqueueDistribution(params: {
    userId: string;
    campaignId: string;
    assetId: string;
    platform: SocialPlatform;
    masterResult: { videoUrl?: string; imageUrl?: string; pdfUrl?: string; assetType: string; };
    styleDna: StyleDNA;
    title: string;
    description?: string;
    price?: number;
    scheduledFor: Date;
    niche: string;
    angle: string;
  }): Promise<{ platform: SocialPlatform; jobId: string; status: string }> {
    const {
      userId, campaignId, assetId, platform, masterResult,
      styleDna, title, description, price, scheduledFor, niche, angle
    } = params;

    // Generate caption/hook from StyleDNA
    const hookText = styleDna.hooks.length > 0
      ? styleDna.hooks[Math.floor(Math.random() * styleDna.hooks.length)]
      : `Check out this ${niche} creation!`;

    const hashtags = styleDna.keywords.slice(0, 5).map(k => `#${k.replace(/\s+/g, '')}`).join(' ');
    const caption = `${hookText}\n\n${description || title}\n\n${hashtags}`;

    // Build the content payload for this platform
    const content: any = {
      title,
      caption,
      niche,
      angle,
      videoUrl: masterResult.videoUrl || null,
      imageUrl: masterResult.imageUrl || null,
      pdfUrl: masterResult.pdfUrl || null,
      styleDna,
      price,
      assetId,
    };

    // Create the scheduled post record
    const approvalId = uuidv4();
    const postId = uuidv4();

    await db.insert(schema.scheduledPosts).values({
      id: postId,
      campaignId,
      platform,
      content,
      scheduledFor,
      status: 'pending',
      approvalId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create an approval request for this post
    await db.insert(schema.approvals).values({
      id: approvalId,
      userId,
      type: 'content',
      payload: {
        postId,
        platform,
        title,
        caption,
        assetUrls: {
          videoUrl: masterResult.videoUrl,
          imageUrl: masterResult.imageUrl,
          pdfUrl: masterResult.pdfUrl,
        },
        scheduledFor,
      },
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const requiresBrowser = platform === 'tiktok' || platform === 'facebook';

    const job = await distributionQueue.add(
      `distribute-${platform}-${postId}`,
      {
        postId,
        userId,
        platform,
        content,
        requiresBrowser,
        browserSequenceHint: requiresBrowser ? this.getBrowserSequence(platform, content) : undefined,
      }
    );

    return {
      platform,
      jobId: job.id || 'local',
      status: 'queued',
    };
  }

  private getBrowserSequence(platform: SocialPlatform, content: any) {
    if (platform === 'tiktok') {
      return {
        steps: [
          { action: 'navigate', url: 'https://www.tiktok.com/upload' },
          { action: 'wait', selector: 'input[type="file"]' },
          { action: 'upload', selector: 'input[type="file"]', fileUrl: content.videoUrl },
          { action: 'type', selector: '.public-DraftEditor-content', value: content.caption },
          { action: 'click', selector: 'button[data-e2e="post-video-button"]' },
        ],
        required: true,
      };
    }
    if (platform === 'facebook') {
      return {
        steps: [
          { action: 'navigate', url: 'https://www.facebook.com' },
          { action: 'click', selector: '[aria-label="Create a post"]' },
          { action: 'type', selector: '[aria-label="What\'s on your mind?"]', value: content.caption },
          { action: 'click', selector: '[aria-label="Post"]' },
        ],
        required: true,
      };
    }
    if (platform === 'etsy') {
      return {
        steps: [
          { action: 'navigate', url: 'https://www.etsy.com/your/shops/me/listings/create' },
          { action: 'type', selector: '#title-input', value: content.title },
          { action: 'type', selector: '#description-input', value: content.caption },
          { action: 'type', selector: '#price-input', value: (content.price / 100).toString() },
          { action: 'click', selector: 'button[data-e2e="publish-button"]' },
        ],
        required: true,
      };
    }
    if (platform === 'fiverr') {
      return {
        steps: [
          { action: 'navigate', url: 'https://www.fiverr.com/start_selling' },
          { action: 'type', selector: 'input[name="gig_title"]', value: content.title },
          { action: 'type', selector: 'textarea[name="gig_description"]', value: content.caption },
          { action: 'click', selector: 'button[type="submit"]' },
        ],
        required: true,
      };
    }
    return { required: false, steps: [] };
  }

  // ─── READ & QUERY ─────────────────────────────────────────────────────

  async getCampaignAssets(userId: string, campaignId: string) {
    return db.select()
      .from(schema.masterAssets)
      .where(and(
        eq(schema.masterAssets.userId, userId),
        eq(schema.masterAssets.campaignId, campaignId)
      ))
      .orderBy(desc(schema.masterAssets.createdAt));
  }

  async getUserAssets(userId: string) {
    return db.select()
      .from(schema.masterAssets)
      .where(eq(schema.masterAssets.userId, userId))
      .orderBy(desc(schema.masterAssets.createdAt));
  }

  async getAssetById(assetId: string) {
    const [asset] = await db.select()
      .from(schema.masterAssets)
      .where(eq(schema.masterAssets.id, assetId))
      .limit(1);
    return asset || null;
  }
}

export const empireStudioService = new EmpireStudioService();