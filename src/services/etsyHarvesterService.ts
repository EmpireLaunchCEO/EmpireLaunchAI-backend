import axios from 'axios';
import { dnaVaultService, DnaStrand } from './dnaVaultService.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HarvestResult {
  success: boolean;
  strandsStored: number;
  keywords: string[];
  listingsFound: number;
  errors: string[];
  rateLimited?: boolean;
  dailyCallsUsed?: number;
  dailyCallsLimit?: number;
}

interface EtsyListingV3 {
  listing_id: number;
  title: string;
  description: string;
  price: { amount: number; divisor: number; currency_code: string };
  url: string;
  views: number;
  num_favorers: number;
  creation_tsz: number;
  taxonomy_path?: string[];
  images?: Array<{ url_570xN: string }>;
  tags?: string[];
  materials?: string[];
}

interface EtsySearchResponse {
  count: number;
  results: EtsyListingV3[];
}

// ─── Rate Limits ────────────────────────────────────────────────────────────

const DAILY_API_LIMIT = 5000;   // Etsy's 5K calls/day quota
const WARNING_THRESHOLD = 4000; // 80% — log warning
const BLOCK_THRESHOLD = 4500;   // 90% — stop harvesting entirely

type RateLimitStatus = 'ok' | 'warning' | 'blocked';

// ─── Etsy Categories (popular taxonomy nodes) ───────────────────────────────

const NICHE_CATEGORIES: Record<string, string> = {
  'digital': 'digital_downloads',
  'printable': 'printables',
  'wall art': 'wall_art',
  'planner': 'planners_and_trackers',
  'clipart': 'clipart_and_graphic_design',
  'svg': 'svgs',
  'template': 'templates',
  'resume': 'resume_templates',
  'invitation': 'invitations',
  'logo': 'logos_and_branding',
  'social media': 'social_media_templates',
  'business card': 'business_cards',
  'sticker': 'stickers_and_labels',
  'jewelry': 'jewelry',
  'clothing': 'clothing',
  'home decor': 'home_and_garden',
  'accessory': 'accessories',
};

// ─── Per-Second Rate Limiter ────────────────────────────────────────────────

class EtsyRateLimiter {
  private lastCall: number = 0;
  private minInterval: number = 200; // 5 QPS limit (5K QPD)

  async wait(): Promise<void> {
    const now = Date.now();
    const waitTime = Math.max(0, this.minInterval - (now - this.lastCall));
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this.lastCall = Date.now();
  }
}

const rateLimiter = new EtsyRateLimiter();

// ─── Etsy Harvester Service ──────────────────────────────────────────────────

export class EtsyHarvesterService {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://openapi.etsy.com/v3';

  // Daily rate-limit tracking
  private dailyCallCount: number = 0;
  private dailyResetDay: number = 0; // UTC day-of-year

  constructor() {
    this.apiKey = process.env.ETSY_CLIENT_ID || '';
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  // ─── Daily Rate-Limit Tracking ────────────────────────────────────────────

  /** Reset the daily counter if we've crossed into a new UTC day. */
  private resetDailyCounterIfNeeded(): void {
    const now = new Date();
    const todayKey = this.utcDayOfYear(now);
    if (todayKey !== this.dailyResetDay) {
      if (this.dailyCallCount > 0) {
        console.log(`[EtsyRateLimit] New UTC day — resetting counter from ${this.dailyCallCount} calls`);
      }
      this.dailyCallCount = 0;
      this.dailyResetDay = todayKey;
    }
  }

  private utcDayOfYear(date: Date): number {
    // Simple: year * 1000 + day-of-year for a unique daily key
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const diff = date.getTime() - start;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  /** Record a single API call against the daily quota. */
  recordApiCall(): void {
    this.resetDailyCounterIfNeeded();
    this.dailyCallCount++;
  }

  /** Get current daily usage info. */
  getDailyUsage(): { count: number; limit: number; percent: number } {
    this.resetDailyCounterIfNeeded();
    return {
      count: this.dailyCallCount,
      limit: DAILY_API_LIMIT,
      percent: Math.round((this.dailyCallCount / DAILY_API_LIMIT) * 100),
    };
  }

  /** Check the rate-limit status: 'ok' | 'warning' | 'blocked'. */
  getRateLimitStatus(): RateLimitStatus {
    this.resetDailyCounterIfNeeded();
    if (this.dailyCallCount >= BLOCK_THRESHOLD) return 'blocked';
    if (this.dailyCallCount >= WARNING_THRESHOLD) return 'warning';
    return 'ok';
  }

  /** True when harvesting should be blocked entirely (90%+ of quota). */
  get isRateLimited(): boolean {
    return this.getRateLimitStatus() === 'blocked';
  }

  // ─── Harvesting Methods ───────────────────────────────────────────────────

  /**
   * Fetch trending keywords related to a niche from top Etsy listings.
   * Extracts tags, taxonomy paths, and title keywords.
   */
  async harvestTrendingSearches(niche: string): Promise<{
    keywords: string[];
    listings: EtsyListingV3[];
  }> {
    const keywords: Set<string> = new Set();
    const listings: EtsyListingV3[] = [];

    const searchTerms = [niche, ...this.expandNiche(niche)];
    for (const term of searchTerms.slice(0, 3)) {
      // Check rate limit before each call
      if (this.isRateLimited) {
        console.warn(`[EtsyHarvester] Skipping trending search "${term}" — daily limit reached`);
        break;
      }

      try {
        await rateLimiter.wait();
        const response = await axios.get<EtsySearchResponse>(
          `${this.baseUrl}/application/listings/active`,
          {
            params: {
              keywords: term,
              limit: 25,
              sort_on: 'score',
            },
            headers: { 'x-api-key': this.apiKey },
            timeout: 15000,
          },
        );
        this.recordApiCall();

        for (const listing of response.data.results) {
          listings.push(listing);

          if (listing.tags) {
            for (const tag of listing.tags) {
              keywords.add(tag.toLowerCase().trim());
            }
          }

          const titleWords = listing.title
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'this'].includes(w));

          for (const word of titleWords.slice(0, 5)) {
            keywords.add(word);
          }
        }
      } catch (err: any) {
        console.warn(`[EtsyHarvester] Search failed for "${term}": ${err.message}`);
      }
    }

    return { keywords: [...keywords].slice(0, 50), listings };
  }

  /**
   * Harvest top-performing listings in a category/niche.
   * Returns listings with highest views + favorites.
   */
  async harvestTopListings(niche: string): Promise<EtsyListingV3[]> {
    const allListings: EtsyListingV3[] = [];
    const searchTerms = [niche, ...this.expandNiche(niche)];

    for (const term of searchTerms.slice(0, 3)) {
      if (this.isRateLimited) {
        console.warn(`[EtsyHarvester] Skipping top-listings search "${term}" — daily limit reached`);
        break;
      }

      try {
        await rateLimiter.wait();
        const response = await axios.get<EtsySearchResponse>(
          `${this.baseUrl}/application/listings/active`,
          {
            params: {
              keywords: term,
              limit: 25,
              sort_on: 'score',
            },
            headers: { 'x-api-key': this.apiKey },
            timeout: 15000,
          },
        );
        this.recordApiCall();

        for (const listing of response.data.results) {
          allListings.push(listing);
        }
      } catch (err: any) {
        console.warn(`[EtsyHarvester] Top listings failed for "${term}": ${err.message}`);
      }
    }

    // Sort by performance: favorers * 10 + views
    const scored = allListings.map(l => ({
      ...l,
      _score: (l.num_favorers || 0) * 10 + (l.views || 0),
    }));
    scored.sort((a, b) => (b._score || 0) - (a._score || 0));

    // Deduplicate by title similarity
    const seen = new Set<string>();
    return scored.filter(l => {
      const key = l.title.toLowerCase().replace(/[^a-z]/g, '').slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 30) as EtsyListingV3[];
  }

  /**
   * Full harvest cycle for a user's niche.
   * Stores results as global DNA strands in the Vault.
   * Checks daily rate limits before making API calls.
   */
  async runHarvest(userId: string, niche: string): Promise<HarvestResult> {
    return this.harvestCore(niche, userId);
  }

  /**
   * Core harvest logic. Shared by runHarvest and any on-demand triggers.
   * Calls harvestTopListings ONCE and reuses results for both layout and palette strands.
   */
  private async harvestCore(niche: string, userId?: string): Promise<HarvestResult> {
    const errors: string[] = [];
    let strandsStored = 0;
    let keywords: string[] = [];
    let listingsFound = 0;

    if (!this.isConfigured) {
      return {
        success: false, strandsStored: 0, keywords: [], listingsFound: 0,
        errors: ['ETSY_CLIENT_ID not configured'],
        rateLimited: false,
        dailyCallsUsed: this.dailyCallCount,
        dailyCallsLimit: DAILY_API_LIMIT,
      };
    }

    // Check rate limit before we even start
    const rateStatus = this.getRateLimitStatus();
    if (rateStatus === 'blocked') {
      const usage = this.getDailyUsage();
      console.warn(`[EtsyHarvester] BLOCKED — ${usage.count}/${DAILY_API_LIMIT} calls used today (${usage.percent}%)`);
      return {
        success: false, strandsStored: 0, keywords: [], listingsFound: 0,
        errors: ['Trend data temporarily limited — upgrading soon.'],
        rateLimited: true,
        dailyCallsUsed: usage.count,
        dailyCallsLimit: DAILY_API_LIMIT,
      };
    }
    if (rateStatus === 'warning') {
      const usage = this.getDailyUsage();
      console.warn(`[EtsyHarvester] WARNING — approaching daily limit: ${usage.count}/${DAILY_API_LIMIT} calls (${usage.percent}%)`);
    }

    // ── 1. Harvest trending searches → niche_pattern strands ──────────────
    try {
      const trending = await this.harvestTrendingSearches(niche);
      keywords = trending.keywords;
      listingsFound = trending.listings.length;

      for (const kw of keywords.slice(0, 20)) {
        const strand: DnaStrand = {
          userId,
          category: 'niche_pattern',
          subCategory: niche.toLowerCase(),
          performanceScore: 60,
          sourcePlatform: 'etsy',
          externalId: `etsy_trend_${kw.replace(/\s+/g, '_')}`,
          manifest: {
            keyword: kw,
            niche,
            source: 'etsy_trending',
            harvestedAt: new Date().toISOString(),
          },
          metadata: {
            tags: [kw, niche],
            brandTrait: 'trend_alignment',
            isSynthesized: true,
          },
          isSynthesized: true,
          isGlobal: true,
        };
        await dnaVaultService.storeStrand(strand);
        strandsStored++;
      }
    } catch (err: any) {
      errors.push(`Trending harvest failed: ${err.message}`);
    }

    // ── 2. Harvest top listings ONCE — used for both layout & palette ────
    let topListings: EtsyListingV3[] = [];
    try {
      topListings = await this.harvestTopListings(niche);
    } catch (err: any) {
      errors.push(`Top listings harvest failed: ${err.message}`);
    }

    // 2a. Store layout strands
    for (const listing of topListings) {
      const titleLength = listing.title.length;
      const layoutCategory = titleLength < 30 ? 'minimal' :
        titleLength < 60 ? 'descriptive' : 'keyword_rich';

      const layoutStrand: DnaStrand = {
        userId,
        category: 'layout',
        subCategory: layoutCategory,
        performanceScore: Math.min(95, (listing.num_favorers || 0) + (listing.views || 0) / 10),
        sourcePlatform: 'etsy',
        externalId: `etsy_listing_${listing.listing_id}`,
        manifest: {
          titlePattern: listing.title,
          estimatedLayout: layoutCategory,
          priceRange: listing.price ? `${listing.price.amount / listing.price.divisor} ${listing.price.currency_code}` : 'unknown',
          listingUrl: listing.url,
          tags: listing.tags || [],
        },
        metadata: {
          tags: listing.tags || [],
          brandTrait: 'layout_inspiration',
          isSynthesized: true,
          views: listing.views,
          favorers: listing.num_favorers,
        },
        isSynthesized: true,
        isGlobal: true,
      };
      await dnaVaultService.storeStrand(layoutStrand);
      strandsStored++;
    }

    // 2b. Store palette strands from the SAME listings
    const colorKeywords = new Set<string>();
    for (const listing of topListings.slice(0, 10)) {
      const text = `${listing.title} ${listing.description || ''} ${(listing.tags || []).join(' ')}`;
      const colors = this.extractColorKeywords(text);
      for (const c of colors) colorKeywords.add(c);
    }

    for (const color of [...colorKeywords].slice(0, 10)) {
      const strand: DnaStrand = {
        userId,
        category: 'palette',
        subCategory: color,
        performanceScore: 55,
        sourcePlatform: 'etsy',
        externalId: `etsy_color_${color}`,
        manifest: {
          colorTheme: color,
          niche,
          source: 'etsy_trending',
          harvestedAt: new Date().toISOString(),
        },
        metadata: {
          tags: [color, niche, 'color_trend'],
          brandTrait: 'color_inspiration',
          isSynthesized: true,
        },
        isSynthesized: true,
        isGlobal: true,
      };
      await dnaVaultService.storeStrand(strand);
      strandsStored++;
    }

    const usage = this.getDailyUsage();
    return {
      success: errors.length === 0,
      strandsStored,
      keywords,
      listingsFound,
      errors,
      rateLimited: rateStatus === 'warning',
      dailyCallsUsed: usage.count,
      dailyCallsLimit: DAILY_API_LIMIT,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Expand niche into related search terms */
  private expandNiche(niche: string): string[] {
    const expansions: Record<string, string[]> = {
      'digital': ['digital product', 'digital download', 'printable'],
      'printable': ['printable wall art', 'printable planner', 'digital download'],
      'wall art': ['wall art printable', 'wall decor', 'home decor printable'],
      'planner': ['planner template', 'digital planner', 'printable planner'],
      'clipart': ['clipart bundle', 'digital clipart', 'watercolor clipart'],
      'svg': ['svg bundle', 'svg file', 'cricut svg'],
      'template': ['template bundle', 'digital template', 'printable template'],
      'sticker': ['sticker sheet', 'digital sticker', 'printable sticker'],
      'jewelry': ['handmade jewelry', 'earrings', 'necklace'],
      'clothing': ['handmade clothing', 't-shirt', 'custom apparel'],
    };

    const key = niche.toLowerCase();
    for (const [k, v] of Object.entries(expansions)) {
      if (key.includes(k)) return v;
    }

    return [`${niche} printable`, `${niche} digital`, `${niche} template`];
  }

  /** Extract color keywords from text */
  private extractColorKeywords(text: string): string[] {
    const colorNames = [
      'neutral', 'beige', 'cream', 'white', 'black', 'gray', 'grey',
      'navy', 'blue', 'sage', 'green', 'mint', 'olive',
      'blush', 'pink', 'rose', 'coral', 'peach',
      'gold', 'mustard', 'yellow', 'rust', 'terracotta', 'orange', 'brown',
      'lavender', 'purple', 'violet', 'lilac',
      'teal', 'turquoise', 'aqua',
      'pastel', 'boho', 'vintage', 'minimalist', 'modern', 'floral',
      'monochrome', 'earthy', 'warm', 'cool', 'bright', 'dark', 'moody',
    ];

    const found = new Set<string>();
    const lower = text.toLowerCase();
    for (const color of colorNames) {
      if (lower.includes(color)) found.add(color);
    }
    return [...found];
  }
}

export const etsyHarvesterService = new EtsyHarvesterService();
