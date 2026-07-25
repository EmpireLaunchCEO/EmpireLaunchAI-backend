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

    // Etsy search with trending keywords
    const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(niche) + '+trending'}&order=most_relevant`;
    await page.goto(searchUrl, { waitUntil: 'networkidle' });

    // Wait for listing cards to load
    try { await page.waitForSelector('[data-search-results] li, .v2-listing-card', { timeout: 8000 }); } catch {}

    // Extract product titles — try multiple selectors
    const titles: string[] = await page.$$eval(
      'a.listing-link h3, .v2-listing-card__info h2, .wt-text-body-01, [data-search-results] h2, [data-search-results] h3',
      (els) => els.slice(0, 15).map(el => (el as HTMLElement).innerText.trim()).filter(Boolean)
    );

    // Extract prices and seller info
    const prices: string[] = await page.$$eval(
      '.currency-value, .wt-screen-md .price',
      (els) => els.slice(0, 10).map(el => (el as HTMLElement).innerText.trim()).filter(Boolean)
    );

    await context.close();

    // Fallback: if no titles, extract page text
    if (titles.length === 0) {
      return {
        trendingThemes: [`"${niche}" is an active category on Etsy`],
        hotSellingItems: [`Browse Etsy trending in ${niche} for current bestsellers`],
        contentIdeas: [`Create ${niche} product listings optimized for Etsy SEO`],
      };
    }

    const itemsWithPrice = titles.slice(0, 7).map((t, i) => prices[i] ? `${t} (${prices[i]}, Etsy)` : `${t} (Etsy)`);

    return {
      hotSellingItems: itemsWithPrice,
      trendingThemes: titles.slice(0, 5).map(t => `${t} — trending in ${niche}`),
      lowCompetitionItems: titles.slice(7, 12).map(t => `Niche opportunity: ${t}`),
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
    await page.goto(searchUrl, { waitUntil: 'networkidle' });

    // Wait for pins to render
    try { await page.waitForSelector('[data-test-id="pin"], div[data-test-id="pinrep-image"]', { timeout: 8000 }); } catch {}

    // Extract pin titles — try multiple selectors
    const pins: string[] = await page.$$eval(
      '[data-test-id="pinrep-title"], div[data-test-id="pin"] a, [title], h2, h3',
      (els) => els.slice(0, 20).map(el => {
        const title = (el as HTMLElement).getAttribute('title');
        const text = (el as HTMLElement).innerText?.trim();
        return title || text || '';
      }).filter(Boolean)
    );

    await context.close();

    const unique = [...new Set(pins)].slice(0, 10);

    // Fallback if nothing extracted
    if (unique.length === 0) {
      return {
        trendingThemes: [`"${niche}" is trending on Pinterest`],
        contentIdeas: [`Create Pinterest pins for ${niche} ideas`],
        seasonalOpportunities: [`Seasonal ${niche} content performs well on Pinterest`],
      };
    }

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
