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

test('ETSY_CLIENT_ID unset: etsy is not_configured, both Etsy arrays empty, no sign-in text', async () => {
  clearIntelCaches();
  const saved = process.env.ETSY_CLIENT_ID;
  delete process.env.ETSY_CLIENT_ID;
  try {
    const http = suggestionsStub({ 'digital planner': ['digital planner ipad', 'digital planner goodnotes'] });
    // No `etsy` dep: the service uses the real client, which must report itself unconfigured.
    const service = new IntelService({ httpGetJson: http, now: () => NOW });
    const { data } = await service.researchTrends({ niche: 'digital planner' });

    assert.equal(data.sources.etsy, 'not_configured');
    assert.deepEqual(data.hotSellingItems, []);
    assert.deepEqual(data.lowCompetitionItems, []);
    // Google still fills its own boxes — one source failing must not empty the other.
    assert.equal(data.sources.google, 'ok');
    assert.ok(data.trendingThemes.length > 0);
    assert.deepEqual(allStrings(data).filter((s) => SIGN_IN.test(s)), []);
  } finally {
    if (saved === undefined) delete process.env.ETSY_CLIENT_ID;
    else process.env.ETSY_CLIENT_ID = saved;
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

  assert.equal(
    buildContentHook('personalised gift for sister', 1),
    '3 things to look for in "personalised gift for sister"',
  );

  assert.deepEqual(parseGoogleSuggestions(['q', ['a b', '  c d  ', 5], [], {}]), ['a b', 'c d']);
  assert.deepEqual(parseGoogleSuggestions({ error: 'nope' }), []);
});
