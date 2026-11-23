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
/**
 * Owner direction (23 Nov): "every hour or when they open their app … if they don't
 * open the app in the next hour, then it just falls back to when they open their app."
 * So the whole answer is cached for exactly one hour and the age is judged at request
 * time: open the app inside the hour and it is served instantly; open it after the
 * hour and a fresh check runs. The app already asks on every open, so this one number
 * gives her exactly that behaviour with no flag for a caller to remember.
 */
export const INTEL_ANSWER_TTL_MS = 60 * 60 * 1000;
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

// ─── Answer cache (the whole five-box answer, exactly one hour) ────────────
interface AnswerCacheEntry {
  response: IntelTrendsResponse;
  expiresAt: number;
}
const answerCache = new Map<string, AnswerCacheEntry>();

/** Same business, same answer: the key is everything she told us about the brand. */
export function intelAnswerCacheKey(params: IntelTrendsParams): string {
  return [params.niche, params.angle, params.targetCustomers, params.businessGoals]
    .map((part) => (part || '').replace(/\s+/g, ' ').trim().toLowerCase())
    .join('|');
}

export function clearIntelCaches(): void {
  suggestionsCache.clear();
  etsySearchCache.clear();
  answerCache.clear();
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

// ─── Niche relevance (a suggestion about something else is not her market) ──
/**
 * Owner direction (23 Nov, second pass): a suggestion that shares no word with her
 * niche is not about her business and must not reach a box. Live, her niche
 * "AI Powered Business Tool" came back with "most profitable ai companies", which
 * framed a hook she would never say. So a suggestion is kept only when it shares at
 * least one SIGNIFICANT token with the niche: a word of 3+ characters that is not a
 * stopword, compared singular/plural. Two-letter tokens ("ai") are not significant on
 * their own, and a niche with no significant token of its own filters nothing.
 */
const NICHE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'yours', 'our', 'you',
  'they', 'them', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'will', 'not',
  'but', 'his', 'her', 'its', 'all', 'any', 'one', 'two', 'out', 'how', 'why', 'what',
  'when', 'who', 'best', 'top', 'most', 'more', 'new', 'good', 'great', 'cheap',
  'free', 'buy', 'get', 'use', 'using', 'about', 'into', 'over', 'per', 'via', 'vs',
  'versus', '2024', '2025', '2026', '2027',
]);

function significantTokens(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !NICHE_STOPWORDS.has(t))
    // "tools" and "tool" are the same word to a buyer.
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

export function suggestionIsAboutNiche(suggestion: string, niche: string): boolean {
  const nicheTokens = new Set(significantTokens(niche));
  if (nicheTokens.size === 0) return true; // nothing to judge against → filter nothing
  return significantTokens(suggestion).some((t) => nicheTokens.has(t));
}

// ─── Content hooks (phrased from a real suggestion, never invented) ─────────
/**
 * Owner direction (23 Nov): Content Ideas must always give her at least five usable
 * hooks, every one about HER business — and each one a line she would actually say on
 * camera. The hook is only ever a frame around a phrase Google actually returned, so
 * no claim is invented: a question asks, a "mistake"/"myth"/"nobody tells you" line
 * names a pattern to talk about without asserting a fact, and the numbered list
 * promises what to check, not what is true.
 *
 * Owner direction (23 Nov, second pass): the hook TEXT never says the niche. A long
 * niche turned "The AI Powered Business Tool mistake to avoid with …" into a sentence
 * nobody would say, and the quoted real search already carries the niche — so the
 * niche lives on the `detail` line instead, and every template below reads naturally
 * at any niche length.
 */
type HookPhraseShape = 'question' | 'statement';

/**
 * Owner direction (23 Nov, third pass): a suggestion that starts with a question word
 * is a QUESTION — "how to build an ai tool", "what are the best ai tools" — and a
 * buying frame laid over it reads wrong: `Is "how to build an ai tool" worth it?` is
 * not a sentence she would say. So the shape of the phrase picks the frame.
 */
const QUESTION_OPENERS =
  /^(?:how|what|why|where|when|which|who|whose|should|can|could|do|does|did|is|are|will|would)\b/i;

export function hookPhraseShape(phrase: string): HookPhraseShape {
  return QUESTION_OPENERS.test((phrase || '').trim()) ? 'question' : 'statement';
}

interface HookTemplate {
  /** Stable identity, so one answer never repeats a frame while a fresh one fits. */
  id: string;
  /** The phrase shapes this frame may wrap. A buying frame never wraps a question. */
  shapes: HookPhraseShape[];
  build: (phrase: string) => string;
}

const ANY_SHAPE: HookPhraseShape[] = ['question', 'statement'];
/** "before you buy X" and "is X worth it?" only make sense over a product, not a question. */
const STATEMENT_ONLY: HookPhraseShape[] = ['statement'];

const HOOK_TEMPLATES: HookTemplate[] = [
  // 1. Question — what her buyers are really typing, and why.
  { id: 'why-searching', shapes: ANY_SHAPE, build: (p) => `Why people keep searching "${p}"` },
  // 2. Numbered list — what to check before buying (a product, never a question).
  { id: 'buy-checklist', shapes: STATEMENT_ONLY, build: (p) => `3 things to check before you buy "${p}"` },
  // 3. Mistake — the pattern worth talking about.
  { id: 'mistake', shapes: ANY_SHAPE, build: (p) => `The mistake most people make with "${p}"` },
  // 4. Myth — the belief worth correcting.
  { id: 'truth', shapes: ANY_SHAPE, build: (p) => `The truth about "${p}"` },
  // 5. "Nobody tells you" — the insider angle.
  { id: 'nobody-tells', shapes: ANY_SHAPE, build: (p) => `What nobody tells you about "${p}"` },
  // 6. Worth it? — the buying decision she sells around (a product, never a question).
  { id: 'worth-it', shapes: STATEMENT_ONLY, build: (p) => `Is "${p}" worth it?` },
  // 7. Unexplained part — the question-friendly insider angle.
  { id: 'nobody-explains', shapes: ANY_SHAPE, build: (p) => `The part of "${p}" nobody explains` },
];

/** The frames that may wrap a phrase of this shape, in cycle order (never below five). */
export function hookTemplatesForShape(shape: HookPhraseShape): HookTemplate[] {
  return HOOK_TEMPLATES.filter((t) => t.shapes.includes(shape));
}

/**
 * The niche is accepted for call-site compatibility but never enters the text.
 * `used` carries the frames already spent on this answer so no pattern repeats while
 * an unused one still fits the phrase's shape.
 */
export function buildContentHook(phrase: string, index: number, _niche?: string, used?: Set<string>): string {
  const p = (phrase || '').replace(/\s+/g, ' ').trim();
  const templates = hookTemplatesForShape(hookPhraseShape(p));
  const start = ((index % templates.length) + templates.length) % templates.length;
  let chosen = templates[start];
  if (used) {
    for (let step = 0; step < templates.length; step++) {
      const candidate = templates[(start + step) % templates.length];
      if (!used.has(candidate.id)) {
        chosen = candidate;
        break;
      }
    }
    used.add(chosen.id);
  }
  return chosen.build(p).replace(/\s+/g, ' ').trim();
}

/**
 * At least MIN_CONTENT_IDEAS hooks, up to MAX_CONTENT_IDEAS.
 *
 * Suggestions that share no significant token with the niche are dropped first, then
 * the distinct hook patterns are cycled over what is left — so two real suggestions
 * still yield five different hooks (question, list, mistake, truth, "nobody tells
 * you", worth it), never five rewordings of the same line. If nothing survives the
 * filter there are no hooks at all, because a hook must quote a real search.
 */
export function buildContentIdeas(suggestions: string[], params: IntelTrendsParams): IntelItem[] {
  const niche = (params.niche || '').replace(/\s+/g, ' ').trim();

  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const raw of suggestions) {
    const phrase = (raw || '').replace(/\s+/g, ' ').trim();
    if (!phrase) continue;
    // A suggestion about something else is not her market (owner, 23 Nov).
    if (!suggestionIsAboutNiche(phrase, niche)) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }
  if (phrases.length === 0) return [];

  const target = Math.min(MAX_CONTENT_IDEAS, Math.max(MIN_CONTENT_IDEAS, phrases.length));
  const ideas: IntelItem[] = [];
  // Frames already spent on this answer: five ideas, five different patterns.
  const usedFrames = new Set<string>();
  for (let i = 0; i < target; i++) {
    const phrase = phrases[i % phrases.length];
    ideas.push({
      text: buildContentHook(phrase, i, undefined, usedFrames),
      // Her niche moved here, where it reads naturally however long it is.
      detail: niche
        ? `From the real search suggestion "${phrase}" for ${niche}`
        : `From the real search suggestion "${phrase}"`,
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
  private async suggestionsFor(seed: string): Promise<string[]> {
    const key = seed.toLowerCase();
    const cached = suggestionsCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

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
          return { seed, suggestions: await this.suggestionsFor(seed) };
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
        // Off-niche suggestions reach no box at all (owner, 23 Nov).
        if (!suggestionIsAboutNiche(suggestion, params.niche || '')) continue;
        seen.add(key);
        hits.push({ suggestion, seed: r.seed });
      }
    }
    return { hits, ok: anyOk };
  }

  private async etsySearch(keywords: string, limit: number): Promise<{ count: number; results: any[] }> {
    const key = `${keywords.toLowerCase()}|${limit}`;
    const cached = etsySearchCache.get(key);
    // Every call goes through etsyService, which owns the single 5 QPS / 5,000 QPD limiter.
    if (cached && cached.expires > Date.now()) return cached.value;

    const value = await this.etsy.searchActiveListings(keywords, limit);
    etsySearchCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /**
   * Real Etsy listings for the niche: title, real price, real shop name, real URL.
   * Returns null when Etsy is configured but the call failed.
   */
  private async fetchHotSellingItems(niche: string): Promise<IntelItem[] | null> {
    try {
      const { results } = await this.etsySearch(niche, 12);
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
  private async fetchLowCompetitionItems(keywords: string[]): Promise<IntelItem[] | null> {
    const candidates = keywords.slice(0, 5);
    if (candidates.length === 0) return [];

    const counted = await Promise.all(
      candidates.map(async (keyword) => {
        try {
          const { count } = await this.etsySearch(keyword, 1);
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
   *
   * The finished answer is cached for exactly one hour and its age is judged at
   * request time — open the app inside the hour and the same answer comes back
   * instantly, open it after the hour and a fresh check runs. A cached answer keeps
   * the `generatedAt` of the check that produced it, so nothing pretends to be newer
   * than it is.
   */
  async researchTrends(params: IntelTrendsParams): Promise<IntelTrendsResponse> {
    const now = this.now();
    const niche = (params.niche || '').trim();
    const cacheKey = intelAnswerCacheKey(params);
    const cachedAnswer = answerCache.get(cacheKey);
    if (niche && cachedAnswer && cachedAnswer.expiresAt > now.getTime()) return cachedAnswer.response;

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
        this.fetchHotSellingItems(niche),
        this.fetchLowCompetitionItems(hits.map((h) => h.suggestion)),
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

    const response: IntelTrendsResponse = {
      data,
      fallbackMessage:
        data.sources.google === 'error' && data.sources.etsy !== 'ok'
          ? 'Live search suggestions and Etsy are both unavailable right now — nothing is being shown rather than something invented.'
          : undefined,
    };
    answerCache.set(cacheKey, { response, expiresAt: now.getTime() + INTEL_ANSWER_TTL_MS });
    return response;
  }
}

export const intelService = new IntelService();
