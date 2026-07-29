import axios from 'axios';
import { dnaVaultService, DnaStrand } from './dnaVaultService.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HarvestResult {
  success: boolean;
  strandsStored: number;
  keywords: string[];
  listingsFound: number;
  errors: string[];
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

// ─── Rate Limiter ────────────────────────────────────────────────────────────

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

  constructor() {
    this.apiKey = process.env.ETSY_CLIENT_ID || '';
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

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

    // Search niche directly
    const searchTerms = [niche, ...this.expandNiche(niche)];
    for (const term of searchTerms.slice(0, 3)) {
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

        for (const listing of response.data.results) {
          listings.push(listing);

          // Extract keywords from tags
          if (listing.tags) {
            for (const tag of listing.tags) {
              keywords.add(tag.toLowerCase().trim());
            }
          }

          // Extract keywords from title
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
   */
  async runHarvest(userId: string, niche: string): Promise<HarvestResult> {
    const errors: string[] = [];
    let strandsStored = 0;
    let keywords: string[] = [];
    let listingsFound = 0;

    if (!this.isConfigured) {
      return { success: false, strandsStored: 0, keywords: [], listingsFound: 0, errors: ['ETSY_CLIENT_ID not configured'] };
    }

    // Harvest trending searches → niche_pattern strands
    try {
      const trending = await this.harvestTrendingSearches(niche);
      keywords = trending.keywords;
      listingsFound = trending.listings.length;

      // Store trending keywords as niche_pattern DNA
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

    // 3. Harvest top listings → layout + palette strands
    try {
      const topListings = await this.harvestTopListings(niche);

      for (const listing of topListings) {
        // Extract layout pattern from listing structure
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
    } catch (err: any) {
      errors.push(`Top listings harvest failed: ${err.message}`);
    }

    // 4. Store palette inspiration from top listing materials/tags
    try {
      const topListings = await this.harvestTopListings(niche);
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
    } catch (err: any) {
      errors.push(`Palette harvest failed: ${err.message}`);
    }

    return {
      success: errors.length === 0,
      strandsStored,
      keywords,
      listingsFound,
      errors,
    };
  }

  /**
   * Global harvest — same as runHarvest but skips user integration check.
   * Used by the 2x daily scheduler for populating the Global DNA Pool.
   */
  async runGlobalHarvest(niche: string): Promise<HarvestResult> {
    return this.harvestCore(niche, undefined);
  }

  /**
   * Core harvest logic shared by runHarvest and runGlobalHarvest.
   */
  private async harvestCore(niche: string, userId?: string): Promise<HarvestResult> {
    const errors: string[] = [];
    let strandsStored = 0;
    let keywords: string[] = [];
    let listingsFound = 0;

    if (!this.isConfigured) {
      return { success: false, strandsStored: 0, keywords: [], listingsFound: 0, errors: ['ETSY_CLIENT_ID not configured'] };
    }

    // 1. Harvest trending searches
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

    // 2. Harvest top listings
    try {
      const topListings = await this.harvestTopListings(niche);
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
    } catch (err: any) {
      errors.push(`Top listings harvest failed: ${err.message}`);
    }

    // 3. Palette extraction
    try {
      const topListings = await this.harvestTopListings(niche);
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
    } catch (err: any) {
      errors.push(`Palette harvest failed: ${err.message}`);
    }

    return {
      success: errors.length === 0,
      strandsStored,
      keywords,
      listingsFound,
      errors,
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

    // Fallback: just add generic terms
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
