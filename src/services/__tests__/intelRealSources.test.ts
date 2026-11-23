/**
 * INTEL — real sources only (owner direction, 23 Nov).
 *
 * The five Home Base boxes used to be filled by an LLM asked to "search the web"
 * (it has no web access, so it invented trends) plus an HTML scraper that emitted
 * a Pinterest login wall as if it were data. The rebuilt path has exactly two real
 * sources: Google search suggestions (keyless autocomplete) and the existing Etsy
 * API v3 client.
 *
 * These tests run the REAL service with the network stubbed — no paid calls, no
 * sockets. They pin the three things the brief demands:
 *   1. a stubbed Google response produces the expected items;
 *   2. no produced string matches /sign ?in|logged? ?in/i, ever;
 *   3. with ETSY_CLIENT_ID unset, `sources.etsy === 'not_configured'`, both Etsy
 *      arrays are empty and nothing mentions signing in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IntelService,
  IntelEtsyClient,
  IntelHttpGetJson,
  clearIntelCaches,
  buildSeedQueries,
  buildContentHook,
  parseGoogleSuggestions,
} from '../intelService.js';
import { buildEtsyHeaders, isEtsyConfigured, resolveEtsyCredentials } from '../etsyCredentials.js';
import {
  ETSY_DAILY_LIMIT,
  ETSY_MIN_INTERVAL_MS,
  ETSY_QPS_LIMIT,
  EtsyDailyLimitReachedError,
  awaitEtsySlot,
  isEtsyDailyLimitReached,
  recordEtsyCall,
  resetEtsyRateLimitState,
  runEtsyRequest,
} from '../etsyRateLimits.js';

const NOW = new Date('2026-11-23T10:00:00.000Z');
const SIGN_IN = /sign ?in|logged? ?in/i;

function suggestionsStub(table: Record<string, string[]>): IntelHttpGetJson {
  return async (url: string) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    const list = table[q] ?? [];
    return [q, list, [], {}];
  };
}

function fakeEtsy(opts: {
  configured?: boolean;
  listings?: any[];
  counts?: Record<string, number>;
  failListings?: boolean;
}): IntelEtsyClient & { calls: number } {
  const client = {
    calls: 0,
    isConfigured: () => opts.configured ?? true,
    async searchActiveListings(keywords: string, limit: number) {
      client.calls += 1;
      if (opts.failListings) throw new Error('etsy down');
      if (limit === 1) {
        return { count: opts.counts?.[keywords] ?? 0, results: [] };
      }
      return { count: (opts.listings ?? []).length, results: opts.listings ?? [] };
    },
  };
  return client;
}

function allStrings(payload: any): string[] {
  const out: string[] = [];
  const walk = (v: any) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(payload);
  return out;
}

test('stubbed Google suggestions fill trendingThemes and contentIdeas', async () => {
  clearIntelCaches();
  const http = suggestionsStub({
    'digital planner': ['digital planner goodnotes', 'digital planner ipad', 'digital planner free'],
    'best digital planner': ['best digital planner for ipad', 'best digital planner 2026'],
    'digital planner gift': ['digital planner gift for her'],
    'digital planner ideas': ['digital planner ideas aesthetic'],
    'trending digital planner 2026': ['trending digital planner 2026 tiktok'],
  });

  const service = new IntelService({ httpGetJson: http, etsy: fakeEtsy({ configured: false }), now: () => NOW });
  const { data } = await service.researchTrends({ niche: 'digital planner' });

  assert.equal(data.sources.google, 'ok');
  // 8 distinct suggestions across the seeds, capped at 7 themes / 6 ideas.
  assert.equal(data.trendingThemes.length, 7);
  assert.equal(data.contentIdeas.length, 6);
  assert.ok(data.trendingThemes.every((i) => i.source === 'google' && i.text.length > 0));
  // The seed itself is never echoed back as a "trend".
  assert.ok(!data.trendingThemes.some((i) => i.text.toLowerCase() === 'digital planner'));
  // Content ideas are hook-shaped and name the suggestion they came from.
  assert.ok(data.contentIdeas[0].text.includes('digital planner goodnotes'));
  assert.ok(data.contentIdeas[0].detail?.includes('digital planner goodnotes'));
  // Seasonal windows are calendar facts, crossed with a real suggestion.
  assert.ok(data.seasonalOpportunities.length > 0);
  assert.ok(data.seasonalOpportunities.every((i) => i.source === 'google' && i.text.length > 0));
  assert.equal(data.generatedAt, NOW.toISOString());
});

test('no produced string ever contains sign-in text', async () => {
  clearIntelCaches();
  // A hostile stub: a suggestion that is nothing but a login wall, plus a good one.
  const http = suggestionsStub({
    'digital planner': ['digital planner — your not signed in', 'Pinterest trend: sign in to continue', 'digital planner ipad'],
  });
  const service = new IntelService({ httpGetJson: http, etsy: fakeEtsy({ configured: false }), now: () => NOW });
  const { data } = await service.researchTrends({ niche: 'digital planner' });

  const strings = allStrings(data);
  assert.ok(strings.length > 0);
  const offenders = strings.filter((s) => SIGN_IN.test(s));
  assert.deepEqual(offenders, []);
  assert.ok(data.trendingThemes.some((i) => i.text === 'digital planner ipad'));
  assert.equal(data.trendingThemes.length, 1);
});

test('both Etsy names cleared: etsy is not_configured, both Etsy arrays empty, no sign-in text', async () => {
  clearIntelCaches();
  // "Not configured" means BOTH halves of the key are absent. Clear every name the
  // credential resolver reads, so a stray .env cannot make this pass by accident.
  const names = ['ETSY_API_KEYSTRING', 'ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET', 'ETSY_API_SHARED_SECRET'];
  const saved: Record<string, string | undefined> = {};
  for (const n of names) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  try {
    assert.equal(isEtsyConfigured(), false, 'no credentials means not configured');

    const http = suggestionsStub({ 'digital planner': ['digital planner ipad', 'digital planner goodnotes'] });
    // No `etsy` dep: the service uses the real client, which must report itself unconfigured.
    const service = new IntelService({ httpGetJson: http, now: () => NOW });
    const { data } = await service.researchTrends({ niche: 'digital planner' });

    assert.equal(data.sources.etsy, 'not_configured');
    assert.ok(data.sources.etsyReason && data.sources.etsyReason.length > 0, 'a plain reason is given');
    assert.deepEqual(data.hotSellingItems, []);
    assert.deepEqual(data.lowCompetitionItems, []);
    // Google still fills its own boxes — one source failing must not empty the other.
    assert.equal(data.sources.google, 'ok');
    assert.ok(data.trendingThemes.length > 0);
    assert.deepEqual(allStrings(data).filter((s) => SIGN_IN.test(s)), []);
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

test('the Etsy header is `keystring:secret` — the exact shape Etsy measured 200 on', () => {
  const names = ['ETSY_API_KEYSTRING', 'ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET', 'ETSY_API_SHARED_SECRET'];
  const saved: Record<string, string | undefined> = {};
  for (const n of names) saved[n] = process.env[n];
  try {
    // The owner's live configuration: keystring in ETSY_API_KEYSTRING, her shared
    // secret saved (oddly) in ETSY_CLIENT_ID. Measured: x-api-key: ks:secret -> 200.
    process.env.ETSY_API_KEYSTRING = 'keystring123';
    process.env.ETSY_CLIENT_ID = 'secret456';
    delete process.env.ETSY_CLIENT_SECRET;
    delete process.env.ETSY_API_SHARED_SECRET;

    assert.deepEqual(resolveEtsyCredentials(), {
      keystring: 'keystring123',
      sharedSecret: 'secret456',
      configured: true,
    });
    assert.deepEqual(buildEtsyHeaders(), { 'x-api-key': 'keystring123:secret456' });
    // Extra headers survive; the api key cannot be overridden by a caller.
    assert.deepEqual(buildEtsyHeaders({ Authorization: 'Bearer t' }), {
      Authorization: 'Bearer t',
      'x-api-key': 'keystring123:secret456',
    });

    // A named shared secret wins over the ETSY_CLIENT_ID fallback.
    process.env.ETSY_CLIENT_SECRET = 'realsecret';
    assert.equal(buildEtsyHeaders()['x-api-key'], 'keystring123:realsecret');

    // A bare keystring can never work: Etsy answers 403 "Shared secret is required".
    delete process.env.ETSY_CLIENT_ID;
    delete process.env.ETSY_CLIENT_SECRET;
    delete process.env.ETSY_API_SHARED_SECRET;
    assert.equal(isEtsyConfigured(), false);
    assert.throws(() => buildEtsyHeaders(), /ETSY_API_KEYSTRING/);
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

test('the Etsy limiter spaces requests by 1000/ETSY_QPS_LIMIT, derived from the constant', async () => {
  resetEtsyRateLimitState();
  assert.equal(ETSY_QPS_LIMIT, 5);
  assert.equal(ETSY_MIN_INTERVAL_MS, 1000 / ETSY_QPS_LIMIT);
  assert.equal(ETSY_DAILY_LIMIT, 5000);

  const started = Date.now();
  await awaitEtsySlot();
  await awaitEtsySlot();
  const elapsed = Date.now() - started;
  // Two slots must be at least one interval apart — measured, not assumed.
  assert.ok(
    elapsed >= ETSY_MIN_INTERVAL_MS - 5,
    `two Etsy slots took ${elapsed}ms, expected at least ${ETSY_MIN_INTERVAL_MS}ms`,
  );
  resetEtsyRateLimitState();
});

test('a 429 parks every Etsy request for Retry-After, never a tight retry', async () => {
  resetEtsyRateLimitState();
  const err: any = new Error('Too Many Requests');
  err.response = { status: 429, headers: { 'retry-after': '1' }, data: { error: 'rate limited' } };

  await assert.rejects(
    runEtsyRequest(async () => {
      throw err;
    }),
    /Too Many Requests/,
  );

  // The next request must wait out the backoff rather than firing immediately.
  const started = Date.now();
  await awaitEtsySlot();
  const waited = Date.now() - started;
  assert.ok(waited >= 900, `expected a ~1s backoff from Retry-After, waited ${waited}ms`);
  resetEtsyRateLimitState();
});

test('the daily guard stops the Etsy call at 5,000 and says why', async () => {
  clearIntelCaches();
  resetEtsyRateLimitState();

  const names = ['ETSY_API_KEYSTRING', 'ETSY_CLIENT_ID', 'ETSY_CLIENT_SECRET', 'ETSY_API_SHARED_SECRET'];
  const saved: Record<string, string | undefined> = {};
  for (const n of names) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  try {
    process.env.ETSY_API_KEYSTRING = 'keystring123';
    process.env.ETSY_CLIENT_ID = 'secret456';

    for (let i = 0; i < ETSY_DAILY_LIMIT; i += 1) recordEtsyCall();
    assert.equal(isEtsyDailyLimitReached(), true);

    // The limiter refuses the request outright: the guarded function never runs.
    let ran = false;
    await assert.rejects(
      runEtsyRequest(async () => {
        ran = true;
        return 'x';
      }),
      (e: any) => e instanceof EtsyDailyLimitReachedError && e.code === 'ETSY_DAILY_LIMIT',
    );
    assert.equal(ran, false, 'no Etsy request is made once the day is spent');

    // Intel reports it as an error with a plain reason, and calls Etsy zero times.
    const http = suggestionsStub({ 'digital planner': ['digital planner ipad'] });
    const etsy = fakeEtsy({ listings: [{ listing_id: 1, title: 'Digital Planner' }] });
    const service = new IntelService({ httpGetJson: http, etsy, now: () => NOW });
    const { data } = await service.researchTrends({ niche: 'digital planner' });

    assert.equal(data.sources.etsy, 'error');
    assert.match(data.sources.etsyReason ?? '', /limit/i);
    assert.equal(etsy.calls, 0, 'the daily guard stops the Intel Etsy calls');
    assert.deepEqual(data.hotSellingItems, []);
    assert.deepEqual(data.lowCompetitionItems, []);
    // Google is untouched by Etsy's quota.
    assert.equal(data.sources.google, 'ok');
  } finally {
    resetEtsyRateLimitState();
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

test('Etsy configured: real titles, prices, shops, URLs and real active-listing counts', async () => {
  clearIntelCaches();
  const http = suggestionsStub({
    'digital planner': ['digital planner ipad', 'digital planner goodnotes', 'digital planner stickers'],
  });
  const etsy = fakeEtsy({
    listings: [
      {
        listing_id: 123,
        title: 'Digital Planner 2026 GoodNotes iPad',
        price: { amount: 1250, divisor: 100, currency_code: 'USD' },
        url: 'https://www.etsy.com/listing/123',
        shop: { shop_name: 'PaperAndPixel' },
      },
      { listing_id: 456, title: 'Minimal Digital Planner', price: { amount: 400, divisor: 100, currency_code: 'USD' } },
    ],
    counts: { 'digital planner ipad': 9000, 'digital planner goodnotes': 120, 'digital planner stickers': 640 },
  });

  const service = new IntelService({ httpGetJson: http, etsy, now: () => NOW });
  const { data } = await service.researchTrends({ niche: 'digital planner' });

  assert.equal(data.sources.etsy, 'ok');
  assert.equal(data.hotSellingItems.length, 2);
  assert.equal(data.hotSellingItems[0].text, 'Digital Planner 2026 GoodNotes iPad');
  assert.equal(data.hotSellingItems[0].detail, '$12.50 · by PaperAndPixel');
  assert.equal(data.hotSellingItems[0].url, 'https://www.etsy.com/listing/123');
  // A listing without a shop name still gets a real price and a real URL.
  assert.equal(data.hotSellingItems[1].detail, '$4.00');
  assert.equal(data.hotSellingItems[1].url, 'https://www.etsy.com/listing/456');

  // Low competition: only keywords with a real count, lowest count first.
  assert.deepEqual(
    data.lowCompetitionItems.map((i) => i.text),
    ['digital planner goodnotes', 'digital planner stickers', 'digital planner ipad'],
  );
  assert.equal(data.lowCompetitionItems[0].detail, '120 active listings on Etsy');
  assert.ok(data.lowCompetitionItems[0].url?.includes('etsy.com/search'));
  assert.deepEqual(allStrings(data).filter((s) => SIGN_IN.test(s)), []);
});

test('a Google failure does not empty the Etsy boxes, and says so in sources', async () => {
  clearIntelCaches();
  const http: IntelHttpGetJson = async () => {
    throw new Error('google unreachable');
  };
  const etsy = fakeEtsy({
    listings: [{ listing_id: 1, title: 'Digital Planner', price: { amount: 500, divisor: 100, currency_code: 'USD' } }],
  });

  const service = new IntelService({ httpGetJson: http, etsy, now: () => NOW });
  const { data } = await service.researchTrends({ niche: 'digital planner' });

  assert.equal(data.sources.google, 'error');
  assert.deepEqual(data.trendingThemes, []);
  assert.deepEqual(data.contentIdeas, []);
  assert.equal(data.sources.etsy, 'ok');
  assert.equal(data.hotSellingItems.length, 1);
  // Calendar-based seasonal windows survive without search data (they are facts, not trends).
  assert.ok(data.seasonalOpportunities.length > 0);
  assert.ok(data.seasonalOpportunities.every((i) => !i.detail || !i.detail.includes('Niche search')));
});

test('an Etsy failure leaves the Google boxes intact', async () => {
  clearIntelCaches();
  const http = suggestionsStub({ 'digital planner': ['digital planner ipad'] });
  const service = new IntelService({ httpGetJson: http, etsy: fakeEtsy({ failListings: true }), now: () => NOW });
  const { data } = await service.researchTrends({ niche: 'digital planner' });

  assert.equal(data.sources.etsy, 'error');
  assert.deepEqual(data.hotSellingItems, []);
  assert.deepEqual(data.lowCompetitionItems, []);
  assert.equal(data.sources.google, 'ok');
  assert.equal(data.trendingThemes.length, 1);
});

test('suggestions are cached per query for ~45 minutes', async () => {
  clearIntelCaches();
  let calls = 0;
  const http: IntelHttpGetJson = async (url: string) => {
    calls += 1;
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    return [q, [`${q} ipad`], [], {}];
  };
  const service = new IntelService({ httpGetJson: http, etsy: fakeEtsy({ configured: false }), now: () => NOW });

  await service.researchTrends({ niche: 'digital planner' });
  const first = calls;
  assert.ok(first > 1);
  await service.researchTrends({ niche: 'digital planner' });
  assert.equal(calls, first); // second page-load hits the cache, not Google
});

test('helpers: seeds, hook phrasing and autocomplete parsing', () => {
  const seeds = buildSeedQueries({ niche: 'digital planner', angle: 'minimalist' }, NOW);
  assert.deepEqual(seeds, [
    'digital planner',
    'best digital planner',
    'digital planner gift',
    'digital planner ideas',
    'trending digital planner 2026',
    'digital planner minimalist',
  ]);
  assert.deepEqual(buildSeedQueries({}, NOW), []);

  // Every hook names her niche and speaks to her audience (owner, 23 Nov).
  assert.equal(
    buildContentHook('personalised gift for sister', 1, 'personalised gifts', 'gift shoppers'),
    '3 things gift shoppers should check before buying "personalised gift for sister" in the personalised gifts niche',
  );

  assert.deepEqual(parseGoogleSuggestions(['q', ['a b', '  c d  ', 5], [], {}]), ['a b', 'c d']);
  assert.deepEqual(parseGoogleSuggestions({ error: 'nope' }), []);
});

test('two real suggestions still give at least five distinct niche hooks', async () => {
  clearIntelCaches();
  // Google answered with only two suggestions for this niche.
  const http = suggestionsStub({
    'digital planner': ['digital planner goodnotes', 'digital planner ipad'],
  });
  const service = new IntelService({ httpGetJson: http, etsy: fakeEtsy({ configured: false }), now: () => NOW });
  const { data } = await service.researchTrends({
    niche: 'digital planner',
    targetCustomers: 'busy mums who plan on an iPad',
  });

  assert.ok(data.contentIdeas.length >= 5, `expected >= 5 ideas, got ${data.contentIdeas.length}`);
  // Every hook is about HER business: it names her niche and speaks to her audience.
  for (const idea of data.contentIdeas) {
    assert.ok(idea.text.includes('digital planner'), `missing niche: ${idea.text}`);
    assert.ok(idea.text.includes('busy mums who plan on an iPad'), `missing audience: ${idea.text}`);
  }
  // Distinct hooks, not five rewordings: the pattern cycle differs line by line.
  assert.equal(new Set(data.contentIdeas.map((i) => i.text)).size, data.contentIdeas.length);
  // Each still names the real suggestion it was framed from — nothing invented.
  assert.ok(data.contentIdeas.every((i) => i.detail?.startsWith('From the real search suggestion')));
});

test('fresh=1 bypasses both 45-minute caches, and the Etsy call still goes through the client', async () => {
  clearIntelCaches();
  let googleCalls = 0;
  const http: IntelHttpGetJson = async (url: string) => {
    googleCalls += 1;
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    return [q, q === 'digital planner' ? ['digital planner ipad'] : [], [], {}];
  };
  const etsy = fakeEtsy({
    listings: [{ listing_id: 1, title: 'Digital Planner', price: { amount: 500, divisor: 100, currency_code: 'USD' } }],
    counts: { 'digital planner ipad': 12 },
  });
  const service = new IntelService({ httpGetJson: http, etsy, now: () => NOW });

  await service.researchTrends({ niche: 'digital planner' });
  const afterCold = googleCalls;
  const etsyAfterCold = etsy.calls;
  assert.ok(afterCold > 0);
  assert.ok(etsyAfterCold > 0);

  // Cached: a second plain request makes no new calls at all.
  await service.researchTrends({ niche: 'digital planner' });
  assert.equal(googleCalls, afterCold);
  assert.equal(etsy.calls, etsyAfterCold);

  // fresh=1: both caches are skipped, so Google and Etsy are called again.
  await service.researchTrends({ niche: 'digital planner', fresh: true });
  assert.ok(googleCalls > afterCold, 'fresh=1 must re-ask Google');
  assert.ok(etsy.calls > etsyAfterCold, 'fresh=1 must re-ask Etsy');
});
