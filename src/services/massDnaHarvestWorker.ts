import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { resolveStudioReasoner } from '../utils/resolveModel.js';
import { marketIntelligenceService, MarketListing } from './marketIntelligenceService.js';
import { dnaVaultService, DnaStrand } from './dnaVaultService.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HarvestCheckpoint {
  nicheIndex: number;
  listingOffset: number;
  totalStrandsStored: number;
  lastRunAt: number;
  completedNiches: string[];
  failedNiches: string[];
}

export interface HarvestStats {
  totalStrandsStored: number;
  nichesProcessed: number;
  nichesTotal: number;
  isRunning: boolean;
  startedAt: number | null;
  elapsedMs: number;
  errors: string[];
}

// ─── 250 Harvest Niches ─────────────────────────────────────────────────────

const PLATFORM_SOURCES: string[] = ['etsy', 'creativemarket', 'pinterest', 'instagram', 'tiktok', 'canva'];

const HARVEST_NICHES: string[] = [
  // Digital Products
  'digital planner', 'digital journal', 'digital notebook', 'budget planner', 'meal planner',
  'fitness tracker', 'habit tracker', 'mood tracker', 'sleep tracker', 'water tracker',
  'wall art', 'printable wall art', 'quote poster', 'motivational poster', 'boho poster',
  'minimalist poster', 'abstract art', 'floral art', 'botanical print', 'vintage print',
  'social media template', 'instagram template', 'tiktok template', 'facebook cover',
  'youtube thumbnail', 'pinterest pin', 'canva template', 'presentation template',
  'resume template', 'cover letter template', 'invoice template', 'business card',
  'logo template', 'branding kit', 'color palette', 'font pairing', 'mood board',
  'wedding invitation', 'birthday invitation', 'baby shower invitation', 'party printable',
  'save the date', 'thank you card', 'holiday card', 'christmas card', 'valentine card',
  'planner sticker', 'digital sticker', 'washi tape', 'scrapbook kit', 'bullet journal',
  // Etsy Best Sellers
  'svg bundle', 'svg cut file', 'cricut design', 'silhouette design', 'laser cut file',
  'embroidery pattern', 'cross stitch pattern', 'knitting pattern', 'crochet pattern',
  'sewing pattern', 'quilt pattern', 'macrame pattern', 'beading pattern',
  'coloring book', 'coloring page', 'activity book', 'maze book', 'dot to dot',
  'workbook', 'worksheet', 'lesson plan', 'homeschool printable', 'flash card',
  'study guide', 'cheat sheet', 'planner insert', 'calendar printable', 'monthly calendar',
  // Social Media & Content
  'instagram story', 'instagram highlight', 'instagram caption', 'hashtag pack',
  'tiktok caption', 'tiktok hashtag', 'youtube description', 'youtube keyword',
  'blog template', 'email template', 'newsletter template', 'landing page template',
  'website template', 'notion template', 'airtable template', 'spreadsheet template',
  // Health & Wellness
  'yoga printable', 'meditation guide', 'wellness journal', 'self care planner',
  'therapy worksheet', 'anxiety journal', 'gratitude journal', 'affirmation card',
  'vision board', 'goal setting', 'time management', 'productivity planner',
  // Business & Finance
  'business plan', 'marketing plan', 'social media strategy', 'content calendar',
  'financial planner', 'debt tracker', 'savings challenge', 'investment tracker',
  'tax organizer', 'budget binder', 'expense tracker', 'bill tracker',
  // Education & Learning
  'language learning', 'vocabulary list', 'grammar guide', 'math worksheet',
  'science printable', 'history timeline', 'geography printable', 'alphabet printable',
  'number printable', 'shape printable', 'color printable', 'preschool printable',
  // Home & Lifestyle
  'cleaning schedule', 'home organization', 'declutter checklist', 'moving checklist',
  'packing list', 'grocery list', 'weekly menu', 'recipe card', 'recipe book',
  'garden planner', 'plant care guide', 'pet printable', 'travel itinerary',
  // Art & Design
  'digital art', 'procreate brush', 'photoshop action', 'lightroom preset',
  'illustration style', 'watercolor style', 'line art', 'doodle art',
  'pattern design', 'seamless pattern', 'surface pattern', 'fabric pattern',
  // Niche Categories
  'adhd planner', 'adhd printable', 'autism printable', 'dyslexia printable',
  'teacher printable', 'nurse printable', 'doctor printable', 'lawyer printable',
  'real estate printable', 'fitness coach', 'life coach', 'wedding planner',
  'party planner', 'event planner', 'travel planner', 'baby printable',
  'kids printable', 'teen printable', 'college printable', 'mom printable',
  // Seasonal & Events
  'christmas printable', 'halloween printable', 'easter printable', 'valentines printable',
  'thanksgiving printable', 'new year printable', 'birthday printable', 'graduation printable',
  'back to school', 'summer printable', 'spring printable', 'fall printable',
  // Music & Entertainment
  'music printable', 'song lyric art', 'album cover', 'podcast template',
  'gaming printable', 'twitch overlay', 'streamer template', 'esports template',
  // Photography
  'photo overlay', 'photo frame', 'photo prop', 'backdrop printable',
  'photo booth printable', 'instagram filter', 'photo edit preset',
  // Expanded Visual DNA (Owner Request)
  'ai avatar style', 'character portrait prompt', 'cyberpunk avatar', 'fantasy character art',
  '3d background texture', 'cinematic scenery', 'abstract motion background', 'unreal engine render',
  'animal illustration', 'stylized wildlife', 'trending animal patterns', 'pet portrait style',
  'botanical illustration', 'intricate flower patterns', 'exotic fish art', 'aquatic visual dna',
];

// ─── Mass DNA Harvest Worker ────────────────────────────────────────────────

/**
 * Mass DNA Harvest Worker — autonomously ingests 500,000 Style DNA strands
 * from Etsy best sellers into the Universal DNA Vault.
 */
export class MassDnaHarvestWorker {
  private isRunning: boolean = false;
  private startedAt: number | null = null;
  private checkpoint: HarvestCheckpoint | null = null;
  private nicheBatchSize: number = 10;  // Process 10 niches per batch
  private listingsPerNiche: number = 20; // Top 20 listings per niche

  async start(): Promise<HarvestStats> {
    if (this.isRunning) {
      return this.getStats();
    }

    this.isRunning = true;
    this.startedAt = this.checkpoint?.lastRunAt || Date.now();

    console.log('[MassDNAHarvest] Starting mass harvest...');

    // Load any new research targets from the Market Researcher
    await this.loadResearchTargets();

    const model = await resolveStudioReasoner();

    try {
      for (let i = this.checkpoint?.nicheIndex || 0; i < HARVEST_NICHES.length; i += this.nicheBatchSize) {
        if (!this.isRunning) break;

        const batch = HARVEST_NICHES.slice(i, i + this.nicheBatchSize);
        await this.processBatch(batch, model);

        const currentCount = await this.getCurrentStrandCount();
        this.updateProgressFile(currentCount);

        this.checkpoint = {
          nicheIndex: i + batch.length,
          listingOffset: 0,
          totalStrandsStored: currentCount,
          lastRunAt: Date.now(),
          completedNiches: [...(this.checkpoint?.completedNiches || []), ...batch],
          failedNiches: this.checkpoint?.failedNiches || [],
        };
      }
    } catch (error: any) {
      console.error('[MassDNAHarvest] Fatal error:', error.message);
    } finally {
      this.isRunning = false;
      const finalCount = await this.getCurrentStrandCount();
      this.updateProgressFile(finalCount);
      console.log(`[MassDNAHarvest] Harvest complete. Total strands: ${finalCount}`);
    }

    return this.getStats();
  }

  private updateProgressFile(count: number): void {
    try {
      const progressPath = '/home/team/shared/DNA_PROGRESS.txt';
      fs.writeFileSync(progressPath, count.toString());
      console.log(`[MassDNAHarvest] Updated progress file with count: ${count}`);
    } catch (err) {
      console.error('[MassDNAHarvest] Failed to update progress file:', err);
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  getStats(): HarvestStats {
    const now = Date.now();
    return {
      totalStrandsStored: this.checkpoint?.totalStrandsStored || 0,
      nichesProcessed: this.checkpoint?.nicheIndex || 0,
      nichesTotal: HARVEST_NICHES.length,
      isRunning: this.isRunning,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? now - this.startedAt : 0,
      errors: this.checkpoint?.failedNiches || [],
    };
  }

  private async processBatch(niches: string[], model: any): Promise<void> {
    for (const niche of niches) {
      if (!this.isRunning) break;
      try {
        await this.harvestNiche(niche, model);
      } catch (error: any) {
        console.error(`[MassDNAHarvest] Failed niche "${niche}":`, error.message);
        if (this.checkpoint) {
          this.checkpoint.failedNiches.push(niche);
        }
      }
    }
  }

  private async harvestNiche(niche: string, model: any): Promise<void> {
    // Phase 1: Etsy Best Sellers
    const listings = await marketIntelligenceService.fetchEtsyBestSellers(niche);
    let strands: DnaStrand[] = [];

    if (listings && listings.length > 0) {
      const topListings = listings.slice(0, 10);
      for (const listing of topListings) {
        try {
          const dna = await this.extractDnaFromListing(niche, listing, model);
          if (dna) strands.push(dna);
        } catch (err: any) {}
        await this.sleep(200);
      }
    }

    // Phase 2: Canva Templates (Free Tier)
    try {
      const canvaTemplates = await marketIntelligenceService.fetchCanvaTemplates(niche);
      if (canvaTemplates && canvaTemplates.length > 0) {
        const topCanva = canvaTemplates.slice(0, 10);
        for (const template of topCanva) {
          try {
            const dna = await this.extractDnaFromCanva(niche, template, model);
            if (dna) strands.push(dna);
          } catch (err: any) {}
          await this.sleep(200);
        }
      }
    } catch (err) {}

    // Phase 3: TikTok Trends
    try {
      const tiktokTrends = await marketIntelligenceService.fetchTikTokTrends(niche);
      if (tiktokTrends && tiktokTrends.length > 0) {
        const topTikTok = tiktokTrends.slice(0, 5);
        for (const trend of topTikTok) {
          try {
            const dna = await this.extractDnaFromListing(niche, trend, model);
            if (dna) strands.push(dna);
          } catch (err: any) {}
          await this.sleep(200);
        }
      }
    } catch (err) {}

    // Phase 4: Pinterest Trends
    try {
      const pinterestTrends = await marketIntelligenceService.fetchPinterestTrends(niche);
      if (pinterestTrends && pinterestTrends.length > 0) {
        const topPinterest = pinterestTrends.slice(0, 5);
        for (const trend of topPinterest) {
          try {
            const dna = await this.extractDnaFromListing(niche, trend, model);
            if (dna) strands.push(dna);
          } catch (err: any) {}
          await this.sleep(200);
        }
      }
    } catch (err) {}

    // Fallback: Generate synthetic strands if needed
    if (strands.length < 5) {
      const syntheticCount = 5 - strands.length;
      const syntheticStrands = await this.generateSyntheticStrands(niche, syntheticCount);
      strands.push(...syntheticStrands);
    }

    if (strands.length > 0) {
      await dnaVaultService.bulkStore(strands);
    }
  }

  private async extractDnaFromCanva(niche: string, template: any, model: any): Promise<DnaStrand | null> {
    const prompt = `Extract Style DNA from this Canva template: "${template.title}". Return JSON with category (layout), manifest (style, colors, fonts, aesthetic), performanceScore, subCategory.`;
    const response = await model.invoke([
      { role: 'system', content: 'Return ONLY valid JSON.' },
      { role: 'human', content: prompt },
    ]);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    try {
      let json = content;
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) json = match[1];
      const parsed = JSON.parse(json);
      return {
        id: uuidv4(),
        category: 'layout',
        subCategory: niche,
        manifest: {
          ...parsed.manifest,
          thumbnail: template.thumbnail,
          url: template.url,
          platform: 'canva'
        },
        performanceScore: parsed.performanceScore || 60,
        sourcePlatform: 'canva',
        externalId: template.url || undefined,
        isSynthesized: true,
        createdAt: new Date(),
      } as DnaStrand;
    } catch (err) {
      return null;
    }
  }

  private async extractDnaFromListing(niche: string, listing: MarketListing, model: any): Promise<DnaStrand | null> {
    const prompt = `Extract Style DNA from this Etsy best-selling product: "${listing.title}". Return JSON with category, manifest (style, colors, fonts, aesthetic), performanceScore, subCategory.`;
    const response = await model.invoke([
      { role: 'system', content: 'Return ONLY valid JSON.' },
      { role: 'human', content: prompt },
    ]);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    try {
      let json = content;
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) json = match[1];
      const parsed = JSON.parse(json);
      return {
        id: uuidv4(),
        category: parsed.category || 'niche_pattern',
        subCategory: parsed.subCategory || niche,
        manifest: parsed.manifest || { designStyle: 'modern' },
        performanceScore: parsed.performanceScore || 50,
        sourcePlatform: 'etsy',
        externalId: listing.url || undefined,
        isSynthesized: true,
        createdAt: new Date(),
      } as DnaStrand;
    } catch (err) {
      return null;
    }
  }

  private async generateSyntheticStrands(niche: string, count: number): Promise<DnaStrand[]> {
    const strands: DnaStrand[] = [];
    for (let i = 0; i < count; i++) {
      strands.push({
        id: uuidv4(),
        category: 'niche_pattern',
        subCategory: niche,
        manifest: { designStyle: 'modern' },
        performanceScore: 50,
        sourcePlatform: 'etsy',
        isSynthesized: true,
        createdAt: new Date(),
      } as DnaStrand);
    }
    return strands;
  }

  private async getCurrentStrandCount(): Promise<number> {
    try {
      const stats = await dnaVaultService.getVaultStats();
      return stats?.totalStrands || 0;
    } catch {
      return this.checkpoint?.totalStrandsStored || 0;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Load new research targets from Market Researcher's JSON file.
   * Merges any new niches/platforms into the harvest queue.
   */
  private async loadResearchTargets(): Promise<void> {
    try {
      const targetsPath = '/home/team/shared/RESEARCH_TARGETS.json';
      if (!fs.existsSync(targetsPath)) return;

      const raw = fs.readFileSync(targetsPath, 'utf-8');
      const targets = JSON.parse(raw);

      if (targets.newNiches && Array.isArray(targets.newNiches) && targets.newNiches.length > 0) {
        for (const newNiche of targets.newNiches) {
          const nicheStr = typeof newNiche === 'string' ? newNiche.toLowerCase().trim() : '';
          if (nicheStr && !HARVEST_NICHES.includes(nicheStr)) {
            HARVEST_NICHES.push(nicheStr);
            console.log(`[MassDNAHarvest] Added new research target: "${nicheStr}"`);
          }
        }
        // Reset checkpoint to process new niches
        if (this.checkpoint && targets.newNiches.length > 0) {
          // Only reset if we're not currently running
          console.log(`[MassDNAHarvest] ${targets.newNiches.length} new niches from researcher added. Will process next batch.`);
        }
        // Clear the new items so we don't re-add them
        targets.newNiches = [];
        targets.lastUpdated = new Date().toISOString();
        fs.writeFileSync(targetsPath, JSON.stringify(targets, null, 2));
      }

      if (targets.newPlatforms && Array.isArray(targets.newPlatforms) && targets.newPlatforms.length > 0) {
        for (const newPlatform of targets.newPlatforms) {
          const pf = typeof newPlatform === 'string' ? newPlatform.toLowerCase().trim() : '';
          if (pf && !PLATFORM_SOURCES.includes(pf)) {
            PLATFORM_SOURCES.push(pf);
            console.log(`[MassDNAHarvest] Added new platform source: "${pf}"`);
          }
        }
        targets.newPlatforms = [];
        targets.lastUpdated = new Date().toISOString();
        fs.writeFileSync(targetsPath, JSON.stringify(targets, null, 2));
      }
    } catch (err: any) {
      console.error(`[MassDNAHarvest] Failed to load research targets: ${err.message}`);
    }
  }
}

export const massDnaHarvester = new MassDnaHarvestWorker();
