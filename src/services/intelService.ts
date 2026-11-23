import axios from 'axios';
import { etsyService } from './etsyService.js';
import { ETSY_NOT_CONFIGURED_REASON } from './etsyCredentials.js';
import { ETSY_DAILY_LIMIT, isEtsyDailyLimitReached } from './etsyRateLimits.js';

/**
 * INTEL — real, sourced market signal only.
 *
 * Owner direction (23 Nov): the five Home Base boxes must give REAL information in
 * her niche. The old path asked a model to "search the web" (it has no web access,
 * so it invented plausible-sounding trends) and scraped Pinterest/Etsy HTML (which
 * emitted a login wall — "Pinterest trend — your not signed in" — as if it were data).
 *
 * This file therefore has exactly TWO sources, both real:
 *   1. Google search suggestions (keyless autocomplete) — what people actually type.
 *   2. Etsy API v3 via the existing client — real listings, real prices, real counts.
 *
 * Hard rules baked in here:
 *   - No LLM anywhere in this path. A model may never be the source of a trend.
 *   - Nothing is fabricated. If a source is unavailable the array is empty and
 *     `sources` says why; a failure in one source never empties the other.
 *   - No sign-in/login text may ever leave this service (there is no page to be
 *     signed in to any more — the scraping path is gone).
 */

export interface IntelItem {
  text: string;
  detail?: string;
  url?: string;
  source: 'google' | 'etsy';
}

export interface IntelTrendsResult {
  trendingThemes: IntelItem[];
  seasonalOpportunities: IntelItem[];
  hotSellingItems: IntelItem[];
  lowCompetitionItems: IntelItem[];
  contentIdeas: IntelItem[];
  sources: {
    google: 'ok' | 'error';
    etsy: 'ok' | 'not_configured' | 'error';
    /** A plain reason whenever Etsy is not 'ok'. Never a sign-in message. */
    etsyReason?: string;
  };
  generatedAt: string; // ISO
}

export interface IntelTrendsParams {
  niche?: string;
  angle?: string;
  targetCustomers?: string;
  businessGoals?: string;
  /**
   * Owner direction (23 Nov): Intel refreshes each time she opens the app.
   * `fresh` skips BOTH 45-minute source caches for this one request (the
   * `fresh=1` query flag on /api/agent/intel/trends). It never skips the Etsy
   * limiter — that lives in etsyService, below this cache.
   */
  fresh?: boolean;
}

export interface IntelTrendsResponse {
  data: IntelTrendsResult;
  fallbackMessage?: string;
}

/** Injected in tests; the default really does hit the network. */
export type IntelHttpGetJson = (url: string, headers?: Record<string, string>) => Promise<unknown>;

export interface IntelEtsyClient {
  isConfigured(): boolean;
  searchActiveListings(keywords: string, limit: number): Promise<{ count: number; results: any[] }>;
}

export interface IntelServiceDeps {
  httpGetJson?: IntelHttpGetJson;
  etsy?: IntelEtsyClient;
  now?: () => Date;
}

export const GOOGLE_SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';
const GOOGLE_TIMEOUT_MS = 8_000;
/** Owner rule: cache each source per niche for ~30-60 minutes so a refresh cannot hammer Google/Etsy. */
const CACHE_TTL_MS = 45 * 60 * 1000;
const MAX_TRENDING_THEMES = 7;
const MAX_CONTENT_IDEAS = 6;
/** Owner: at least five usable hooks every time, however few suggestions came back. */
export const MIN_CONTENT_IDEAS = 5;
const MAX_HOT_ITEMS = 6;
const MAX_LOW_COMPETITION = 5;
const MAX_SEASONAL = 3;

/** Anything matching this must never reach the client (owner: no sign-in text at all). */
const SIGN_IN_TEXT = /\b(sign(?:ed)?[\s-]?in|signin|log(?:ged)?[\s-]?in|login)\b/i;

function defaultHttpGetJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  return axios
    .get(url, {
      headers,
      timeout: GOOGLE_TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 300,
    })
    .then((r) => r.data);
}

const defaultEtsyClient: IntelEtsyClient = {
  isConfigured: () => etsyService.isConfigured,
  searchActiveListings: async (keywords: string, limit: number) => {
    const res = await etsyService.findAllActiveListingsByKeywords(keywords, limit);
    return { count: res.count, results: res.results };
  },
};

// ─── Source caches (per query / per keyword, ~45 minutes) ──────────────────
interface CacheEntry<T> {
  value: T;
  expires: number;
}
const suggestionsCache = new Map<string, CacheEntry<string[]>>();
const etsySearchCache = new Map<string, CacheEntry<{ count: number; results: any[] }>>();

export function clearIntelCaches(): void {
  suggestionsCache.clear();
  etsySearchCache.clear();
}

// ─── Google search suggestions ─────────────────────────────────────────────

/**
 * The client's own words become the seed queries. Nothing here is invented: a seed
 * is a real phrase derived from the client's niche/angle/audience, and every item
 * we show is a suggestion Google actually returned for it.
 */
export function buildSeedQueries(params: IntelTrendsParams, now: Date): string[] {
  const niche = (params.niche || '').trim();
  if (!niche) return [];

  const year = now.getFullYear();
  const seeds: string[] = [niche, `best ${niche}`, `${niche} gift`, `${niche} ideas`, `trending ${niche} ${year}`];

  const angle = (params.angle || '').trim();
  if (angle && angle.toLowerCase() !== niche.toLowerCase()) seeds.push(`${niche} ${angle}`);

  const audience = (params.targetCustomers || '').trim();
  if (audience && audience.toLowerCase() !== niche.toLowerCase()) seeds.push(`${niche} for ${audience}`);

  // Dedupe (case-insensitive), cap so one uncached niche costs at most 6 calls.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of seeds) {
    const key = s.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out.slice(0, 6);
}

/** Parses the `client=firefox` autocomplete payload: `[query, [suggestions], [], {...}]`. */
export function parseGoogleSuggestions(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  const list = payload[1];
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 1);
}

export interface SuggestionHit {
  suggestion: string;
  seed: string;
}

// ─── Seasonal windows (calendar facts only — never invented data) ───────────
interface SeasonalWindow {
  /** Calendar months (0-11) in which this window is worth planning for. */
  months: number[];
  name: string;
  /** A plain calendar fact. No numbers about demand, ever. */
  fact: string;
}

const SEASONAL_WINDOWS: SeasonalWindow[] = [
  { months: [9, 10], name: 'Christmas gifting', fact: 'Christmas is 25 December and gift searches start climbing in October' },
  { months: [10], name: 'Black Friday', fact: 'Black Friday is the fourth Friday of November, with deal searches building the week before' },
  { months: [11], name: 'Last-minute gifting', fact: 'postal cut-offs for 25 December land mid-December, so last-minute searches peak in the second week' },
  { months: [11, 0], name: 'New year reset', fact: 'planner, goal and reset searches peak between Christmas and mid-January' },
  { months: [0], name: 'New Year goals', fact: 'goal-setting purchases concentrate in the first two weeks of January' },
  { months: [1], name: "Valentine's Day", fact: "Valentine's Day is 14 February, and personalised gift searches build through the first two weeks" },
  { months: [2, 3], name: 'Spring occasions', fact: 'UK Mothering Sunday falls in March and Easter moves between late March and April' },
  { months: [4], name: "Mother's Day (US)", fact: "US Mother's Day is the second Sunday of May" },
  { months: [4, 5, 6, 7], name: 'Wedding season', fact: 'wedding season runs May to September in the northern hemisphere' },
  { months: [5], name: "Father's Day (US)", fact: "US Father's Day is the third Sunday of June" },
  { months: [7, 8], name: 'Back to school', fact: 'back-to-school buying runs from August into early September' },
];

export function buildSeasonalWindows(now: Date): SeasonalWindow[] {
  const month = now.getMonth();
  const upcoming = new Set([month, (month + 1) % 12, (month + 2) % 12]);
  const picked = SEASONAL_WINDOWS.filter((w) => w.months.some((m) => upcoming.has(m)));
  // Prefer windows active this month first, then the next two.
  return picked
    .sort((a, b) => Number(!a.months.includes(month)) - Number(!b.months.includes(month)))
    .slice(0, MAX_SEASONAL);
}

// ─── Content hooks (phrased from a real suggestion, never invented) ─────────
/**
 * Owner direction (23 Nov): Content Ideas must always give her at least five usable
 * hooks, every one about HER business — naming her niche and speaking to her
 * audience — never a generic marketing line. The hook is only ever a frame around a
 * phrase Google actually returned, so no claim is invented: a question asks, a
 * "mistake"/"myth"/"nobody tells you" line names a pattern to talk about without
 * asserting a fact, and the numbered list promises what to check, not what is true.
 */
type HookTemplate = (phrase: string, niche: string, audience: string) => string;

const HOOK_TEMPLATES: HookTemplate[] = [
  // 1. Question — what the search actually means for her buyers.
  (p, n, a) => `What "${p}" really means for ${a} buying ${n}`,
  // 2. Numbered list — what to check before buying.
  (p, n, a) => `3 things ${a} should check before buying "${p}" in the ${n} niche`,
  // 3. Mistake — the pattern worth talking about.
  (p, n, a) => `The ${n} mistake ${a} keep making with "${p}"`,
  // 4. Myth — the belief worth correcting.
  (p, n, a) => `The "${p}" myth ${a} are told about ${n}`,
  // 5. "Nobody tells you" — the insider angle.
  (p, n, a) => `Nobody tells ${a} this about "${p}" in ${n}`,
  // 6. Before / after — the transformation she sells.
  (p, n, a) => `Before "${p}" and after: what changes for ${a} in ${n}`,
];

/** Her audience in her own words; if she did not give one, her buyers in her niche. */
export function resolveAudiencePhrase(params: IntelTrendsParams): string {
  const audience = (params.targetCustomers || '').trim();
  if (audience) return audience;
  const niche = (params.niche || '').trim();
  return niche ? `your ${niche} buyers` : 'your buyers';
}

export function buildContentHook(phrase: string, index: number, niche: string, audience?: string): string {
  const template = HOOK_TEMPLATES[index % HOOK_TEMPLATES.length];
  const n = (niche || '').trim();
  const a = (audience || '').trim() || resolveAudiencePhrase({ niche: n });
  return template(phrase, n, a);
}

/**
 * At least MIN_CONTENT_IDEAS hooks, up to MAX_CONTENT_IDEAS.
 *
 * The distinct hook patterns are cycled over the real suggestions, so two
 * suggestions still yield five different hooks (question, list, mistake, myth,
 * "nobody tells you") — never five rewordings of the same line, and never a hook
 * that fails to name her niche.
 */
export function buildContentIdeas(suggestions: string[], params: IntelTrendsParams): IntelItem[] {
  const niche = (params.niche || '').trim();
  const audience = resolveAudiencePhrase(params);

  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const raw of suggestions) {
    const phrase = (raw || '').replace(/\s+/g, ' ').trim();
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }
  if (phrases.length === 0) return [];

  const target = Math.min(MAX_CONTENT_IDEAS, Math.max(MIN_CONTENT_IDEAS, phrases.length));
  const ideas: IntelItem[] = [];
  for (let i = 0; i < target; i++) {
    const phrase = phrases[i % phrases.length];
    ideas.push({
      text: buildContentHook(phrase, i, niche, audience),
      detail: `From the real search suggestion "${phrase}"`,
      source: 'google' as const,
    });
  }
  return ideas;
}

// ─── Formatting helpers ────────────────────────────────────────────────────
function formatEtsyPrice(price: any): string | undefined {
  if (!price || typeof price.amount !== 'number') return undefined;
  const divisor = typeof price.divisor === 'number' && price.divisor > 0 ? price.divisor : 100;
  const currency = typeof price.currency_code === 'string' ? price.currency_code : 'USD';
  const value = price.amount / divisor;
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '';
  return `${symbol}${value.toFixed(2)}${symbol ? '' : ` ${currency}`}`;
}

function etsyListingUrl(listing: any): string | undefined {
  if (typeof listing?.url === 'string' && listing.url.startsWith('http')) return listing.url;
  if (typeof listing?.listing_id === 'number') return `https://www.etsy.com/listing/${listing.listing_id}`;
  return undefined;
}

function etsyShopName(listing: any): string | undefined {
  const name = listing?.shop?.shop_name ?? listing?.shop_name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined;
}

/** Last gate: no sign-in text, no empty text, ever. */
function cleanItems(items: IntelItem[]): IntelItem[] {
  return items.filter((item) => {
    const blob = `${item.text} ${item.detail ?? ''}`;
    if (!item.text || !item.text.trim()) return false;
    if (SIGN_IN_TEXT.test(blob)) {
      console.warn('[IntelService] Dropped an item containing sign-in text');
      return false;
    }
    return true;
  });
}

export class IntelService {
  private readonly httpGetJson: IntelHttpGetJson;
  private readonly etsy: IntelEtsyClient;
  private readonly now: () => Date;

  constructor(deps: IntelServiceDeps = {}) {
    this.httpGetJson = deps.httpGetJson ?? defaultHttpGetJson;
    this.etsy = deps.etsy ?? defaultEtsyClient;
    this.now = deps.now ?? (() => new Date());
  }

  /** One autocomplete call, cached per seed query. Throws when Google is unreachable. */
  private async suggestionsFor(seed: string, fresh = false): Promise<string[]> {
    const key = seed.toLowerCase();
    const cached = suggestionsCache.get(key);
    // `fresh` (the fresh=1 flag) reads past the 45-minute cache for this request;
    // the value it fetches still refreshes the cache for the next caller.
    if (!fresh && cached && cached.expires > Date.now()) return cached.value;

    const url = `${GOOGLE_SUGGEST_URL}?client=firefox&q=${encodeURIComponent(seed)}`;
    const payload = await this.httpGetJson(url, {
      'User-Agent': 'Mozilla/5.0 (compatible; EmpireLaunchAI/1.0)',
      Accept: 'application/json',
    });
    const suggestions = parseGoogleSuggestions(payload);

    suggestionsCache.set(key, { value: suggestions, expires: Date.now() + CACHE_TTL_MS });
    return suggestions;
  }

  /** All distinct suggestions across the seeds, with the seed that produced each. */
  private async collectSuggestions(params: IntelTrendsParams): Promise<{ hits: SuggestionHit[]; ok: boolean }> {
    const seeds = buildSeedQueries(params, this.now());
    if (seeds.length === 0) return { hits: [], ok: false };

    const seedKeys = new Set(seeds.map((s) => s.toLowerCase().replace(/\s+/g, ' ')));
    const results = await Promise.all(
      seeds.map(async (seed) => {
        try {
          return { seed, suggestions: await this.suggestionsFor(seed, params.fresh === true) };
        } catch (err: any) {
          console.warn(`[IntelService] Google suggestions failed for "${seed}": ${err?.message ?? err}`);
          return { seed, suggestions: [] as string[], failed: true };
        }
      }),
    );

    const anyOk = results.some((r) => !('failed' in r && r.failed));
    const seen = new Set<string>();
    const hits: SuggestionHit[] = [];
    for (const r of results) {
      for (const suggestion of r.suggestions) {
        const key = suggestion.toLowerCase().replace(/\s+/g, ' ');
        if (seedKeys.has(key)) continue; // the seed itself is not a suggestion
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ suggestion, seed: r.seed });
      }
    }
    return { hits, ok: anyOk };
  }

  private async etsySearch(
    keywords: string,
    limit: number,
    fresh = false,
  ): Promise<{ count: number; results: any[] }> {
    const key = `${keywords.toLowerCase()}|${limit}`;
    const cached = etsySearchCache.get(key);
    // Only the in-memory cache is skipped. The call still goes through
    // etsyService, which owns the single 5 QPS / 5,000 QPD limiter.
    if (!fresh && cached && cached.expires > Date.now()) return cached.value;

    const value = await this.etsy.searchActiveListings(keywords, limit);
    etsySearchCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /**
   * Real Etsy listings for the niche: title, real price, real shop name, real URL.
   * Returns null when Etsy is configured but the call failed.
   */
  private async fetchHotSellingItems(niche: string, fresh = false): Promise<IntelItem[] | null> {
    try {
      const { results } = await this.etsySearch(niche, 12, fresh);
      const items: IntelItem[] = [];
      for (const listing of results.slice(0, MAX_HOT_ITEMS)) {
        const title = typeof listing?.title === 'string' ? listing.title.replace(/\s+/g, ' ').trim() : '';
        if (!title) continue;
        const price = formatEtsyPrice(listing?.price);
        const shop = etsyShopName(listing);
        const detailParts = [price, shop ? `by ${shop}` : undefined].filter(Boolean) as string[];
        items.push({
          text: title,
          detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
          url: etsyListingUrl(listing),
          source: 'etsy',
        });
      }
      return items;
    } catch (err: any) {
      console.warn(`[IntelService] Etsy listings failed for "${niche}": ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Keywords from the real suggestions whose Etsy active-listing count is low:
   * demand with less competition, and the real count is reported, never a guess.
   */
  private async fetchLowCompetitionItems(keywords: string[], fresh = false): Promise<IntelItem[] | null> {
    const candidates = keywords.slice(0, 5);
    if (candidates.length === 0) return [];

    const counted = await Promise.all(
      candidates.map(async (keyword) => {
        try {
          const { count } = await this.etsySearch(keyword, 1, fresh);
          return { keyword, count };
        } catch (err: any) {
          console.warn(`[IntelService] Etsy count failed for "${keyword}": ${err?.message ?? err}`);
          return null;
        }
      }),
    );

    const usable = counted.filter((c): c is { keyword: string; count: number } => c !== null && c.count > 0);
    if (usable.length === 0) return null; // configured, but nothing came back

    return usable
      .sort((a, b) => a.count - b.count)
      .slice(0, MAX_LOW_COMPETITION)
      .map(({ keyword, count }) => ({
        text: keyword,
        detail: `${count.toLocaleString('en-US')} active listings on Etsy`,
        url: `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`,
        source: 'etsy' as const,
      }));
  }

  /**
   * Real market signal for the given business parameters.
   * Never throws: an unavailable source empties its own boxes and says so.
   */
  async researchTrends(params: IntelTrendsParams): Promise<IntelTrendsResponse> {
    const now = this.now();
    const niche = (params.niche || '').trim();

    if (!niche) {
      return {
        data: {
          trendingThemes: [],
          seasonalOpportunities: [],
          hotSellingItems: [],
          lowCompetitionItems: [],
          contentIdeas: [],
          sources: { google: 'error', etsy: 'error' },
          generatedAt: now.toISOString(),
        },
        fallbackMessage: 'No niche given, so there is nothing to source.',
      };
    }

    const [{ hits, ok: googleOk }, etsyConfigured] = await Promise.all([
      this.collectSuggestions(params),
      Promise.resolve(this.etsy.isConfigured()),
    ]);

    // trendingThemes — the real suggestions themselves.
    const trendingThemes: IntelItem[] = hits.slice(0, MAX_TRENDING_THEMES).map((hit) => ({
      text: hit.suggestion,
      detail: `Google search suggestion for "${hit.seed}"`,
      source: 'google' as const,
    }));

    // contentIdeas — hook-shaped lines phrased from those same suggestions, with the
    // hook patterns cycled so two suggestions still give at least five hooks, each
    // naming her niche and speaking to her audience.
    const contentIdeas: IntelItem[] = buildContentIdeas(hits.map((h) => h.suggestion), params);

    // seasonalOpportunities — the calendar crossed with the niche's real searches.
    const seasonalOpportunities: IntelItem[] = buildSeasonalWindows(now).map((window, i) => {
      const related = hits[i]?.suggestion;
      return {
        text: `${window.name} — ${window.fact}`,
        detail: related ? `Niche search to build it around: "${related}"` : 'Calendar-based',
        source: 'google' as const,
      };
    });

    // hotSellingItems + lowCompetitionItems — real Etsy API data only.
    let hotSellingItems: IntelItem[] = [];
    let lowCompetitionItems: IntelItem[] = [];
    let etsyStatus: IntelTrendsResult['sources']['etsy'];
    let etsyReason: string | undefined;

    if (!etsyConfigured) {
      etsyStatus = 'not_configured';
      etsyReason = ETSY_NOT_CONFIGURED_REASON;
    } else if (isEtsyDailyLimitReached()) {
      // The day's quota is spent: stop calling, say why, never queue work that
      // cannot run until the UTC day rolls over.
      etsyStatus = 'error';
      etsyReason = `Etsy's ${ETSY_DAILY_LIMIT.toLocaleString('en-US')} requests-a-day limit is used up, so the Etsy boxes are empty until tomorrow (UTC).`;
    } else {
      const [hot, low] = await Promise.all([
        this.fetchHotSellingItems(niche, params.fresh === true),
        this.fetchLowCompetitionItems(hits.map((h) => h.suggestion), params.fresh === true),
      ]);
      hotSellingItems = hot ?? [];
      lowCompetitionItems = low ?? [];
      etsyStatus = hot === null && low === null ? 'error' : 'ok';
      if (etsyStatus === 'error') {
        etsyReason = isEtsyDailyLimitReached()
          ? `Etsy's ${ETSY_DAILY_LIMIT.toLocaleString('en-US')} requests-a-day limit is used up, so the Etsy boxes are empty until tomorrow (UTC).`
          : 'Etsy did not answer, so its two boxes are empty rather than filled with guesses.';
      }
    }

    const data: IntelTrendsResult = {
      trendingThemes: cleanItems(trendingThemes),
      seasonalOpportunities: cleanItems(seasonalOpportunities),
      hotSellingItems: cleanItems(hotSellingItems),
      lowCompetitionItems: cleanItems(lowCompetitionItems),
      contentIdeas: cleanItems(contentIdeas),
      sources: { google: googleOk ? 'ok' : 'error', etsy: etsyStatus, etsyReason },
      generatedAt: now.toISOString(),
    };

    return {
      data,
      fallbackMessage:
        data.sources.google === 'error' && data.sources.etsy !== 'ok'
          ? 'Live search suggestions and Etsy are both unavailable right now — nothing is being shown rather than something invented.'
          : undefined,
    };
  }
}

export const intelService = new IntelService();
