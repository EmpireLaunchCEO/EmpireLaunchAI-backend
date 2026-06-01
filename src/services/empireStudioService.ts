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
 * Supported social platforms for distribution.
 */
export type SocialPlatform = 'tiktok' | 'instagram' | 'youtube' | 'facebook';

/**
 * Strategy for creating the master asset.
 * Defaults to free-tier tools first (Canva Free), falls back to Hunter-Gatherer.
 */
export type CreationStrategy = 'canva_api' | 'canva_browser' | 'manual' | 'openai';

export class EmpireStudioService {
  // ─── PUBLIC API ────────────────────────────────────────────────────────

  /**
   * Full creation pipeline:
   * 1. Accept StyleDNA + campaign info
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
    styleDna: StyleDNA;
    platforms: SocialPlatform[];
    title?: string;
    description?: string;
    price?: number;          // in cents
    scheduleInMinutes?: number; // minutes from now to schedule
  }) {
    const {
      userId, campaignId: existingCampaignId, niche, angle, styleDna,
      platforms, title, description, price, scheduleInMinutes
    } = params;

    const assetId = uuidv4();
    const campaignId = existingCampaignId || uuidv4();

    // Notify user that creation is starting
    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🎬 Empire Studio: Creating master asset for "${niche}" with DNA injection...`
    });

    // Step 1: Generate the master asset (single source of truth)
    const masterResult = await this.generateMasterAsset(userId, {
      niche, angle, styleDna, assetId, title: title || `${niche} - ${angle}`
    });

    // Step 2: Persist the master asset record with style DNA
    const assetData: any = {
      id: assetId,
      userId,
      campaignId,
      styleDna,
      assetType: masterResult.assetType,
      status: 'completed',
      masterVideoUrl: masterResult.videoUrl || null,
      masterImageUrl: masterResult.imageUrl || null,
      masterPdfUrl: masterResult.pdfUrl || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

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

    // Step 3: Ensure campaign exists
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

    // Step 4: Queue distribution for each platform
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

    // Step 5: Notify user
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
      queueResults,
      scheduledFor,
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
    }
  ): Promise<{
    videoUrl?: string;
    imageUrl?: string;
    pdfUrl?: string;
    assetType: 'video' | 'image' | 'pdf';
    strategy: CreationStrategy;
  }> {
    const { niche, angle, styleDna, title } = params;

    // Check if Canva API is available
    const canvaCreds = await integrationService.getCredentials(userId, 'canva');

    if (canvaCreds && canvaCreds.accessToken) {
      try {
        return await this.generateViaCanvaAPI(userId, { niche, angle, styleDna, title });
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
    params: { niche: string; angle: string; styleDna: StyleDNA; title: string }
  ): Promise<{
    imageUrl?: string;
    pdfUrl?: string;
    assetType: 'image' | 'pdf';
    strategy: CreationStrategy;
  }> {
    const { niche, styleDna, title } = params;

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
      styleDna.tone,
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
   * For videos, this signals that a manual-assisted CapCut flow is needed.
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

  /**
   * Creates a scheduled post record and enqueues a distribution job.
   * If a platform needs browser interaction (e.g. TikTok), the job payload
   * includes a `browserSequence` hint for the Neural Browser Worker.
   */
  private async enqueueDistribution(params: {
    userId: string;
    campaignId: string;
    assetId: string;
    platform: SocialPlatform;
    masterResult: {
      videoUrl?: string;
      imageUrl?: string;
      pdfUrl?: string;
      assetType: string;
    };
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
      // Single video source — same asset shared across all platforms
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

    // Determine if this platform needs browser-based distribution.
    // TikTok and Facebook may need browser fallback if API scopes are limited.
    const requiresBrowser = platform === 'tiktok' || platform === 'facebook';

    // Enqueue distribution job. The distributionWorker will attempt API first,
    // then pivot to Neural Browser Worker (Hunter-Gatherer).
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

  /**
   * Provides browser automation hints for platforms that don't have full API support.
   * Used by the Neural Browser Worker / Hunter-Gatherer.
   */
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
    return { required: false, steps: [] };
  }

  // ─── READ & QUERY ─────────────────────────────────────────────────────

  /**
   * Get all master assets for a user's campaign.
   */
  async getCampaignAssets(userId: string, campaignId: string) {
    return db.select()
      .from(schema.masterAssets)
      .where(and(
        eq(schema.masterAssets.userId, userId),
        eq(schema.masterAssets.campaignId, campaignId)
      ))
      .orderBy(desc(schema.masterAssets.createdAt));
  }

  /**
   * Get all assets for a user (across all campaigns).
   */
  async getUserAssets(userId: string) {
    return db.select()
      .from(schema.masterAssets)
      .where(eq(schema.masterAssets.userId, userId))
      .orderBy(desc(schema.masterAssets.createdAt));
  }

  /**
   * Get a single asset by ID.
   */
  async getAssetById(assetId: string) {
    const [asset] = await db.select()
      .from(schema.masterAssets)
      .where(eq(schema.masterAssets.id, assetId))
      .limit(1);
    return asset || null;
  }
}

export const empireStudioService = new EmpireStudioService();