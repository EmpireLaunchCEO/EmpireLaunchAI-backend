import { reasoningEngine } from './reasoningEngine.js';
import { marketScraperService } from './marketScraperService.js';
import { dnaVaultService, DnaStrand } from './dnaVaultService.js';
import { etsyHarvesterService } from './etsyHarvesterService.js';
import { r2Storage } from './r2StorageService.js';

export interface IntelTrendsParams {
  niche?: string;
  angle?: string;
  targetCustomers?: string;
  businessGoals?: string;
}

export interface IntelTrendsResult {
  trendingThemes: string[];
  seasonalOpportunities: string[];
  hotSellingItems: string[];
  lowCompetitionItems: string[];
  contentIdeas: string[];
}

// Strands older than this trigger a fresh harvest
const STRAND_STALENESS_HOURS = 6;

function buildIntelPrompt(params: IntelTrendsParams, etsyContext?: string): string {
  const context: string[] = [];
  if (params.niche) context.push(`Business niche: ${params.niche}`);
  if (params.angle) context.push(`Business angle/approach: ${params.angle}`);
  if (params.targetCustomers) context.push(`Target customers: ${params.targetCustomers}`);
  if (params.businessGoals) context.push(`Business goals: ${params.businessGoals}`);

  const etsyBlock = etsyContext ? `\n\nRECENT ETSY MARKET DATA for ${params.niche || 'this niche'}:\n${etsyContext}\nUse this real Etsy data to ground your analysis.` : '';

  return `You are a real-time market intelligence analyst. Search the web for CURRENT, up-to-date trends, data, and opportunities. Do NOT use stale training data — find what is actually trending RIGHT NOW on platforms like Etsy, TikTok, Instagram, Pinterest, Amazon, and Google Trends.
${etsyBlock}
${context.join('\n')}

Based on your web research${etsyContext ? ' and the Etsy data above' : ''}, return a single valid JSON object (no markdown, no code fences, no surrounding text) with exactly these five keys. Each key must be an array of strings:

{
  "trendingThemes": ["exact trending theme 1", "exact trending theme 2", ...],
  "seasonalOpportunities": ["upcoming seasonal event or holiday opportunity 1", ...],
  "hotSellingItems": ["specific hot-selling product or content type 1", ...],
  "lowCompetitionItems": ["specific product/content idea with low competition and good profit 1", ...],
  "contentIdeas": ["specific content or design idea relevant to the niche 1", ...]
}

RULES:
- Every array must have at least 3 items. Aim for 5-7 items each.
- Each item must be specific and actionable, not generic.
- Focus on what is ACTUALLY selling/performing right now based on your web search${etsyContext ? ' and the real Etsy listing data provided' : ''}.
- Include numbers, stats, or platform names where relevant.
- Return ONLY the JSON object — no explanation, no markdown formatting.`;
}

function parseIntelResponse(raw: string): IntelTrendsResult | null {
  let cleaned = raw.trim();

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      trendingThemes: Array.isArray(parsed.trendingThemes) ? parsed.trendingThemes : [],
      seasonalOpportunities: Array.isArray(parsed.seasonalOpportunities) ? parsed.seasonalOpportunities : [],
      hotSellingItems: Array.isArray(parsed.hotSellingItems) ? parsed.hotSellingItems : [],
      lowCompetitionItems: Array.isArray(parsed.lowCompetitionItems) ? parsed.lowCompetitionItems : [],
      contentIdeas: Array.isArray(parsed.contentIdeas) ? parsed.contentIdeas : [],
    };
  } catch {
    console.warn('[IntelService] Failed to parse JSON response, attempting regex extraction');

    // Fallback: regex extraction
    const extract = (key: string): string[] => {
      const regex = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`, 'i');
      const match = cleaned.match(regex);
      if (!match || !match[1]) return [];
      return match[1]
        .split(',')
        .map(s => s.replace(/^["'\s]+|["'\s]+$/g, '').trim())
        .filter(Boolean);
    };

    const result: IntelTrendsResult = {
      trendingThemes: extract('trendingThemes'),
      seasonalOpportunities: extract('seasonalOpportunities'),
      hotSellingItems: extract('hotSellingItems'),
      lowCompetitionItems: extract('lowCompetitionItems'),
      contentIdeas: extract('contentIdeas'),
    };

    const hasAnyData = Object.values(result).some(arr => arr.length > 0);
    return hasAnyData ? result : null;
  }
}

/**
 * Extract a human-readable Etsy context string from a set of DNA strands.
 */
function buildEtsyContextFromStrands(strands: DnaStrand[]): string {
  const keywords = new Set<string>();
  const titles: string[] = [];
  const prices: string[] = [];

  for (const strand of strands.slice(0, 15)) {
    if (strand.manifest?.keyword) keywords.add(strand.manifest.keyword as string);
    if (strand.manifest?.titlePattern) titles.push(strand.manifest.titlePattern as string);
    if (strand.manifest?.priceRange) prices.push(strand.manifest.priceRange as string);
    if (strand.metadata?.tags) {
      for (const t of strand.metadata.tags as string[]) {
        if (t.length > 2) keywords.add(t);
      }
    }
  }

  const lines: string[] = [];
  if (keywords.size > 0) lines.push(`Trending keywords: ${[...keywords].slice(0, 20).join(', ')}`);
  if (titles.length > 0) lines.push(`Top listing titles: ${titles.slice(0, 5).join(' | ')}`);
  if (prices.length > 0) lines.push(`Common price points: ${prices.slice(0, 5).join(', ')}`);
  return lines.join('\n');
}

/**
 * Check whether a set of DNA strands is stale (oldest strand > STALENESS hours).
 */
function areStrandsStale(strands: DnaStrand[]): boolean {
  if (strands.length === 0) return true;
  const cutoff = Date.now() - STRAND_STALENESS_HOURS * 60 * 60 * 1000;

  // Consider strands stale if the majority were harvested before the cutoff
  let staleCount = 0;
  for (const s of strands) {
    const harvestedAt = s.manifest?.harvestedAt as string;
    if (harvestedAt) {
      if (new Date(harvestedAt).getTime() < cutoff) staleCount++;
    } else {
      // Strands without a timestamp are considered stale
      staleCount++;
    }
  }
  return staleCount > strands.length / 2;
}

export class IntelService {
  /**
   * Researches current market trends for the given business parameters.
   *
   * Flow:
   * 1. Try real web scraping first (marketScraperService)
   * 2. Fetch cached Etsy DNA strands from the vault
   * 3. If strands are stale/missing, trigger on-demand Etsy harvest
   * 4. Inject real Etsy data into the Gemini prompt for grounded analysis
   */
  async researchTrends(params: IntelTrendsParams): Promise<{ data: IntelTrendsResult | null; fallbackMessage?: string }> {
    const niche = params.niche || 'general';
    const nicheLower = niche.toLowerCase();

    // 1. Try real web scraping first
    try {
      const scraped = await marketScraperService.scrapeAll(niche);
      const hasAnyData = Object.values(scraped).some(arr => arr.length > 0);
      if (hasAnyData) {
        return { data: scraped };
      }
    } catch (err: any) {
      console.warn('[IntelService] Market scraping failed, falling back to Gemini:', err.message);
    }

    // 2. Fetch cached Etsy DNA strands for this niche
    let etsyContext: string | undefined;
    try {
      const allEtsyStrands = await dnaVaultService.findBySource('etsy', undefined, 50);

      // Filter strands relevant to this niche
      const relevantStrands = allEtsyStrands.filter(s => {
        const subcat = (s.subCategory || '').toLowerCase();
        const tags: string[] = s.metadata?.tags || [];
        const manifestNiche = s.manifest?.niche || '';
        return subcat.includes(nicheLower) ||
          tags.some(t => t.toLowerCase().includes(nicheLower)) ||
          manifestNiche.toLowerCase().includes(nicheLower) ||
          nicheLower === 'general';
      });

      // 3. If strands are stale or missing, trigger on-demand harvest
      if (areStrandsStale(relevantStrands) && nicheLower !== 'general' && etsyHarvesterService.isConfigured) {
        console.log(`[IntelService] Etsy strands stale/missing for "${niche}" — triggering on-demand harvest`);

        const harvestResult = await etsyHarvesterService.runHarvest(
          '00000000-0000-0000-0000-000000000000', // system user
          niche,
        );

        if (harvestResult.rateLimited) {
          console.warn(`[IntelService] Etsy harvest rate-limited — using whatever strands are available (${harvestResult.dailyCallsUsed}/${harvestResult.dailyCallsLimit} calls today)`);
        } else if (harvestResult.success) {
          console.log(`[IntelService] On-demand harvest complete: ${harvestResult.strandsStored} strands for "${niche}"`);
        }

        // Re-fetch strands to include the fresh harvest
        const updatedStrands = await dnaVaultService.findBySource('etsy', undefined, 50);
        const updatedRelevant = updatedStrands.filter(s => {
          const subcat = (s.subCategory || '').toLowerCase();
          const tags: string[] = s.metadata?.tags || [];
          const manifestNiche = s.manifest?.niche || '';
          return subcat.includes(nicheLower) ||
            tags.some(t => t.toLowerCase().includes(nicheLower)) ||
            manifestNiche.toLowerCase().includes(nicheLower) ||
            nicheLower === 'general';
        });

        if (updatedRelevant.length > 0) {
          etsyContext = buildEtsyContextFromStrands(updatedRelevant);
          console.log(`[IntelService] Injected ${updatedRelevant.length} Etsy DNA strands for "${niche}" (fresh harvest)`);
        }
      } else if (relevantStrands.length > 0) {
        etsyContext = buildEtsyContextFromStrands(relevantStrands);
        console.log(`[IntelService] Injected ${relevantStrands.length} cached Etsy DNA strands for "${niche}"`);
      } else {
        console.log(`[IntelService] No Etsy DNA strands for "${niche}" in PG — trying R2 fallback`);
        etsyContext = await this.tryR2Fallback(niche);
        if (etsyContext) {
          console.log(`[IntelService] Loaded Etsy data from R2 cold storage for "${niche}"`);
        }
      }
    } catch (etsyErr: any) {
      console.warn('[IntelService] Etsy DNA pipeline failed:', etsyErr.message);
    }

    // 4. Fallback to Gemini (with Etsy context if available)
    const prompt = buildIntelPrompt(params, etsyContext);

    try {
      const raw = await reasoningEngine.reason(prompt, {
        temperature: 0.3,
        maxTokens: 2048,
      });

      const parsed = parseIntelResponse(raw);
      if (parsed) {
        return { data: parsed };
      }

      console.warn('[IntelService] Could not parse AI response into structured trends');
    } catch (err: any) {
      console.error('[IntelService] reasoningEngine.reason() failed:', err.message);
    }

    return {
      data: null,
      fallbackMessage: 'Unable to research trends at this time. Please try again later.',
    };
  }

  /**
   * Try to load today's Etsy harvest from R2 cold storage when PG has no strands.
   * Returns a human-readable context string, or undefined if nothing is found.
   */
  private async tryR2Fallback(niche: string): Promise<string | undefined> {
    if (!r2Storage.isAvailable) return undefined;
    const today = new Date().toISOString().slice(0, 10);
    const key = `dna-harvests/${today}/${niche.replace(/\s+/g, '_')}.json`;

    try {
      const buffer = await r2Storage.downloadBuffer(key);
      if (!buffer) {
        // Try yesterday's as well — maybe harvest ran late
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const altKey = `dna-harvests/${yesterday}/${niche.replace(/\s+/g, '_')}.json`;
        const altBuffer = await r2Storage.downloadBuffer(altKey);
        if (!altBuffer) return undefined;
        const data = JSON.parse(altBuffer.toString('utf-8'));
        return this.buildFallbackContext(data);
      }

      const data = JSON.parse(buffer.toString('utf-8'));
      return this.buildFallbackContext(data);
    } catch (err: any) {
      console.warn(`[IntelService] R2 fallback failed for "${niche}":`, err.message);
      return undefined;
    }
  }

  /** Build a simple context string from R2 harvest JSON. */
  private buildFallbackContext(data: any): string {
    const lines: string[] = [];
    if (data.keywords?.length > 0) {
      lines.push(`Trending keywords: ${data.keywords.slice(0, 20).join(', ')}`);
    }
    if (data.listingsFound) {
      lines.push(`Listings analyzed: ${data.listingsFound}`);
    }
    if (data.harvestedAt) {
      lines.push(`Harvested: ${data.harvestedAt}`);
    }
    return lines.length > 0 ? lines.join('\n') : `Etsy harvest data for ${data.niche || 'this niche'}.`;
  }
}

export const intelService = new IntelService();
