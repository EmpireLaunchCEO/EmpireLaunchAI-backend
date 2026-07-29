import { reasoningEngine } from './reasoningEngine.js';
import { marketScraperService } from './marketScraperService.js';
import { dnaVaultService, DnaStrand } from './dnaVaultService.js';

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

    // If we couldn't extract anything at all, return null
    const hasAnyData = Object.values(result).some(arr => arr.length > 0);
    return hasAnyData ? result : null;
  }
}

export class IntelService {
  /**
   * Researches current market trends for the given business parameters.
   * Uses the existing ReasoningEngine (Gemini 2.5 Flash) for research.
   * Returns structured trend data or a fallback message on failure.
   */
  async researchTrends(params: IntelTrendsParams): Promise<{ data: IntelTrendsResult | null; fallbackMessage?: string }> {
    const niche = params.niche || 'general';

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

    // 2. Fetch Etsy DNA strands for this niche to ground Gemini analysis
    let etsyContext: string | undefined;
    try {
      const etsyStrands = await dnaVaultService.findBySource('etsy', undefined, 30);
      const nicheLower = niche.toLowerCase();

      // Filter strands relevant to this niche
      const relevantStrands = etsyStrands.filter(s => {
        const subcat = (s.subCategory || '').toLowerCase();
        const tags: string[] = s.metadata?.tags || [];
        const manifestNiche = s.manifest?.niche || '';
        return subcat.includes(nicheLower) ||
          tags.some(t => t.toLowerCase().includes(nicheLower)) ||
          manifestNiche.toLowerCase().includes(nicheLower) ||
          nicheLower === 'general';
      });

      if (relevantStrands.length > 0) {
        const keywords = new Set<string>();
        const titles: string[] = [];
        const prices: string[] = [];

        for (const strand of relevantStrands.slice(0, 15)) {
          if (strand.manifest?.keyword) keywords.add(strand.manifest.keyword as string);
          if (strand.manifest?.titlePattern) titles.push(strand.manifest.titlePattern as string);
          if (strand.manifest?.priceRange) prices.push(strand.manifest.priceRange as string);
          if (strand.metadata?.tags) {
            for (const t of strand.metadata.tags as string[]) {
              if (t.length > 2 && t !== nicheLower) keywords.add(t);
            }
          }
        }

        const lines: string[] = [];
        if (keywords.size > 0) lines.push(`Trending keywords: ${[...keywords].slice(0, 20).join(', ')}`);
        if (titles.length > 0) lines.push(`Top listing titles: ${titles.slice(0, 5).join(' | ')}`);
        if (prices.length > 0) lines.push(`Common price points: ${prices.slice(0, 5).join(', ')}`);
        etsyContext = lines.join('\n');
        console.log(`[IntelService] Injected ${relevantStrands.length} Etsy DNA strands for "${niche}"`);
      }
    } catch (etsyErr: any) {
      console.warn('[IntelService] Etsy DNA fetch failed:', etsyErr.message);
    }

    // 3. Fallback to Gemini (with Etsy context if available)
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
}

export const intelService = new IntelService();
