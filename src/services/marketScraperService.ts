import { chromium, Browser, Page } from 'playwright';

export interface IntelTrendsResult {
  trendingThemes: string[];
  seasonalOpportunities: string[];
  hotSellingItems: string[];
  lowCompetitionItems: string[];
  contentIdeas: string[];
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const TIMEOUT_MS = 10_000;

async function scrapeEtsy(niche: string): Promise<Partial<IntelTrendsResult>> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: randomUA() });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    // Etsy search for the niche
    const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(niche)}&order=most_relevant`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

    // Extract product titles
    const titles: string[] = await page.$$eval(
      '.v2-listing-card__info h2, .listing-link .text-body',
      (els) => els.slice(0, 12).map(el => (el as HTMLElement).innerText.trim()).filter(Boolean)
    );

    // Extract bestseller / popular tags
    const tags: string[] = await page.$$eval(
      '.wt-badge, .search-badge, .v2-listing-card__badge',
      (els) => els.slice(0, 8).map(el => (el as HTMLElement).innerText.trim()).filter(Boolean)
    );

    await context.close();

    return {
      hotSellingItems: titles.slice(0, 7).map(t => `${t} (Etsy)`),
      trendingThemes: tags.slice(0, 5).map(t => `${t} trend in ${niche}`),
      lowCompetitionItems: titles.slice(7).map(t => `Niche: ${t}`),
    };
  } catch (err: any) {
    console.warn('[MarketScraper] Etsy scrape failed:', err.message);
    return {};
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function scrapePinterest(niche: string): Promise<Partial<IntelTrendsResult>> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: randomUA() });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(niche)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

    // Extract pin titles and descriptions
    const pins: string[] = await page.$$eval(
      '[data-test-id="pinrep-title"], .pinTitle, [title]',
      (els) => els.slice(0, 15).map(el => (el as HTMLElement).getAttribute('title') || (el as HTMLElement).innerText).filter(Boolean)
    );

    await context.close();

    const unique = [...new Set(pins)].slice(0, 10);
    return {
      trendingThemes: unique.slice(0, 5).map(p => `Pinterest trend: ${p}`),
      contentIdeas: unique.slice(5).map(p => `Content idea: ${p}`),
      seasonalOpportunities: unique.slice(0, 3).map(p => `Seasonal: ${p}`),
    };
  } catch (err: any) {
    console.warn('[MarketScraper] Pinterest scrape failed:', err.message);
    return {};
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function scrapeGoogleTrends(niche: string): Promise<Partial<IntelTrendsResult>> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: randomUA() });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    // Google Trends daily search
    const trendsUrl = `https://trends.google.com/trends/explore?q=${encodeURIComponent(niche)}`;
    await page.goto(trendsUrl, { waitUntil: 'domcontentloaded' });

    // Try to extract related queries
    const queries: string[] = await page.$$eval(
      '.related-queries-item-label, .label-text',
      (els) => els.slice(0, 10).map(el => (el as HTMLElement).innerText.trim()).filter(Boolean)
    );

    await context.close();

    if (queries.length === 0) {
      return {
        trendingThemes: [`"${niche}" is actively searched on Google Trends`],
        seasonalOpportunities: [`Monitor ${niche} interest peaks throughout the year`],
        contentIdeas: [`Create content around rising ${niche} search terms`],
      };
    }

    return {
      trendingThemes: queries.slice(0, 5).map(q => `Rising: ${q}`),
      seasonalOpportunities: queries.slice(5).map(q => `Opportunity: ${q}`),
      contentIdeas: queries.map(q => `Trend-based idea: ${q}`),
    };
  } catch (err: any) {
    console.warn('[MarketScraper] Google Trends scrape failed:', err.message);
    return {};
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── 5-minute cache ──────────────────────────────────────────────────────
const cache = new Map<string, { data: IntelTrendsResult; expires: number }>();

function emptyResult(): IntelTrendsResult {
  return { trendingThemes: [], seasonalOpportunities: [], hotSellingItems: [], lowCompetitionItems: [], contentIdeas: [] };
}

export class MarketScraperService {
  async scrapeAll(niche: string): Promise<IntelTrendsResult> {
    const cacheKey = niche.toLowerCase().trim();
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      console.log('[MarketScraper] Cache hit for:', niche);
      return cached.data;
    }

    console.log('[MarketScraper] Scraping for:', niche);

    // Run all scrapers in parallel
    const [etsy, pinterest, google] = await Promise.all([
      scrapeEtsy(niche),
      scrapePinterest(niche),
      scrapeGoogleTrends(niche),
    ]);

    const result: IntelTrendsResult = {
      trendingThemes: [...(etsy.trendingThemes || []), ...(pinterest.trendingThemes || []), ...(google.trendingThemes || [])],
      seasonalOpportunities: [...(etsy.seasonalOpportunities || []), ...(pinterest.seasonalOpportunities || []), ...(google.seasonalOpportunities || [])],
      hotSellingItems: [...(etsy.hotSellingItems || []), ...(pinterest.hotSellingItems || []), ...(google.hotSellingItems || [])],
      lowCompetitionItems: [...(etsy.lowCompetitionItems || []), ...(pinterest.lowCompetitionItems || []), ...(google.lowCompetitionItems || [])],
      contentIdeas: [...(etsy.contentIdeas || []), ...(pinterest.contentIdeas || []), ...(google.contentIdeas || [])],
    };

    // Deduplicate
    for (const key of Object.keys(result) as (keyof IntelTrendsResult)[]) {
      result[key] = [...new Set(result[key])].slice(0, 10);
    }

    // Cache for 5 minutes
    cache.set(cacheKey, { data: result, expires: Date.now() + 5 * 60 * 1000 });

    return result;
  }
}

export const marketScraperService = new MarketScraperService();
