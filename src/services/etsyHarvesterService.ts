import axios from 'axios';
import { dnaVaultService, DnaStrand } from './dnaVaultService.js';
import { r2Storage } from './r2StorageService.js';
import { ETSY_NOT_CONFIGURED_REASON, buildEtsyHeaders, isEtsyConfigured } from './etsyCredentials.js';
import {
  ETSY_DAILY_LIMIT,
  getEtsyDailyUsage,
  getEtsyRateLimitStatus,
  isEtsyDailyLimitReached,
  runEtsyRequest,
  type EtsyRateLimitStatus,
} from './etsyRateLimits.js';

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

// Rate limits live in ONE place: ./etsyRateLimits.ts (the owner's 5/s, 5,000/day).
// There is deliberately no second copy of either number or of the limiter here.

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

// ─── Etsy Harvester Service ──────────────────────────────────────────────────

export class EtsyHarvesterService {
  private readonly baseUrl = 'https://openapi.etsy.com/v3';

  /** True only when BOTH halves of the Etsy key are present (see etsyCredentials.ts). */
  get isConfigured(): boolean {
    return isEtsyConfigured();
  }

  // ─── Daily Rate-Limit Tracking (the ONE counter, in etsyRateLimits.ts) ────

  /** Get current daily usage info. */
  getDailyUsage(): { count: number; limit: number; percent: number } {
    const usage = getEtsyDailyUsage();
    return { count: usage.count, limit: usage.limit, percent: usage.percent };
  }

  /** Check the rate-limit status: 'ok' | 'warning' | 'blocked'. */
  getRateLimitStatus(): EtsyRateLimitStatus {
    return getEtsyRateLimitStatus();
  }

  /** True when harvesting should be blocked entirely (the day's quota is spent). */
  get isRateLimited(): boolean {
    return isEtsyDailyLimitReached();
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
        const response = await runEtsyRequest(() =>
          axios.get<EtsySearchResponse>(
            `${this.baseUrl}/application/listings/active`,
            {
              params: {
                keywords: term,
                limit: 25,
                sort_on: 'score',
              },
              headers: buildEtsyHeaders(),
              timeout: 15000,
            },
          ),
        );

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
        const response = await runEtsyRequest(() =>
          axios.get<EtsySearchResponse>(
            `${this.baseUrl}/application/listings/active`,
            {
              params: {
                keywords: term,
                limit: 25,
                sort_on: 'score',
              },
              headers: buildEtsyHeaders(),
              timeout: 15000,
            },
          ),
        );

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
        errors: [ETSY_NOT_CONFIGURED_REASON],
        rateLimited: false,
        dailyCallsUsed: getEtsyDailyUsage().count,
        dailyCallsLimit: ETSY_DAILY_LIMIT,
      };
    }

    // Check rate limit before we even start
    const rateStatus = this.getRateLimitStatus();
    if (rateStatus === 'blocked') {
      const usage = this.getDailyUsage();
      console.warn(`[EtsyHarvester] BLOCKED — ${usage.count}/${usage.limit} calls used today (${usage.percent}%)`);
      return {
        success: false, strandsStored: 0, keywords: [], listingsFound: 0,
        errors: [`Etsy's ${usage.limit.toLocaleString('en-US')} requests-a-day limit is used up — trend data resumes tomorrow (UTC).`],
        rateLimited: true,
        dailyCallsUsed: usage.count,
        dailyCallsLimit: usage.limit,
      };
    }
    if (rateStatus === 'warning') {
      const usage = this.getDailyUsage();
      console.warn(`[EtsyHarvester] WARNING — approaching daily limit: ${usage.count}/${usage.limit} calls (${usage.percent}%)`);
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

    // ── 3. Persist harvest snapshot to R2 for durable storage ────────────
    this.persistToR2(niche, { keywords, listingsFound, strandsStored, errors }).catch(err =>
      console.warn('[EtsyHarvester] R2 persist failed:', err.message),
    );

    // ── 4. Clean up PG strands older than 7 days for Etsy ───────────────
    dnaVaultService.deleteStaleEtsyStrands().catch(err =>
      console.warn('[EtsyHarvester] PG cleanup failed:', err.message),
    );

    const usage = this.getDailyUsage();
    return {
      success: errors.length === 0,
      strandsStored,
      keywords,
      listingsFound,
      errors,
      rateLimited: rateStatus === 'warning',
      dailyCallsUsed: usage.count,
      dailyCallsLimit: usage.limit,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Persist harvest snapshot to R2 as JSON for durable cold storage. */
  private async persistToR2(niche: string, data: any): Promise<void> {
    if (!r2Storage.isAvailable) return;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const key = `dna-harvests/${today}/${niche.replace(/\s+/g, '_')}.json`;
    const json = JSON.stringify({
      niche,
      harvestedAt: new Date().toISOString(),
      ...data,
    });
    const result = await r2Storage.uploadBuffer(Buffer.from(json, 'utf-8'), key, 'application/json');
    if (result.success) {
      console.log(`[EtsyHarvester] Persisted harvest to R2: ${key}`);
    }
  }

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
