/**
 * Unit tests for the planning-layer guarantee (owner directives, Sep 8):
 *   A) every component the client relays in the conversation must appear in the
 *      Scene-Based video;
 *   B) the ENTIRE story (hook → about → CTA) must complete start-to-finish
 *      EXACTLY inside the chosen duration.
 * These are pure deterministic helpers (NO paid renders, NO mocks): the
 * component inventory builder, the plan-time-normalizer (hard time budget), and
 * the two plan verifiers (components-in-script + story-arc coverage) that drive
 * the ONE auto-correct re-plan pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComponentInventory,
  verifyComponentsInScript,
  verifyArcCoverage,
  normalizePlanTimeBudget,
  type SceneScript,
} from '../sceneVideoPipelineService.js';

const scene = (n: number, d: number, visualPrompt: string, narration = ''): SceneScript => ({
  sceneNumber: n, duration: d, visualType: 'still', visualPrompt, narration,
});

// ─── buildComponentInventory ────────────────────────────────────────────────
test('buildComponentInventory: explicit components preserved, deduped case-insensitively, trimmed', () => {
  const inventory = buildComponentInventory({
    components: ['Teal palette', 'teal palette', '  Follow @beadwick ', ''],
    cleanBrief: '',
    conversation: [],
  });
  assert.deepEqual(inventory, ['Teal palette', 'Follow @beadwick']);
});

test('buildComponentInventory: reads USER turns only (assistant framing stripped) and extracts tokens', () => {
  const inventory = buildComponentInventory({
    components: [],
    cleanBrief: 'Handmade beaded bracelets from our shop',
    conversation: [
      { role: 'assistant', content: "I'll refine the script for you, tap the wand to generate." },
      { role: 'user', content: 'Our shop Beadwick & Co sells handmade bracelets on TikTok for $9.99 with a teal palette. Follow @beadwick to save this.' },
    ],
  });
  // Canonical tokens from the user's relayed components:
  assert.ok(inventory.some(c => c.toLowerCase() === 'tiktok'), 'platform token TikTok');
  assert.ok(inventory.some(c => c.toLowerCase() === 'teal'), 'color token teal');
  assert.ok(inventory.some(c => c.toLowerCase() === '$9.99'), 'price token $9.99');
  assert.ok(inventory.some(c => c.toLowerCase() === 'follow @beadwick'), 'CTA wording Follow @beadwick');
  // The subject/concept chunk from the user turn:
  assert.ok(inventory.some(c => c.toLowerCase().includes('beadwick & co')), 'brief chunk carries Beadwick & Co');
  // Assistant/consultant framing is NOT part of the inventory:
  assert.ok(!inventory.some(c => /refine the script|tap the wand/.test(c.toLowerCase())), 'assistant framing excluded');
});

test('buildComponentInventory: reads the clean brief, extracts "20% off" offer', () => {
  const inventory = buildComponentInventory({
    components: [],
    cleanBrief: 'Candle brand Soothe & Smoke, apothecary candles, 20% off this week.',
    conversation: [],
  });
  assert.ok(inventory.some(c => c.toLowerCase() === '20% off'), 'percent-off offer token');
  assert.ok(inventory.some(c => c.toLowerCase().includes('soothe & smoke')), 'brief chunk carries the brand');
});

test('buildComponentInventory: bounded to the 14-item cap', () => {
  const many = Array.from({ length: 30 }, (_, i) => `Component number ${i + 1} with concrete detail`);
  const inventory = buildComponentInventory({ components: many, cleanBrief: '', conversation: [] });
  assert.ok(inventory.length <= 14, `capped at 14, got ${inventory.length}`);
  assert.equal(inventory.length, 14);
});

test('buildComponentInventory: empty inputs → empty inventory', () => {
  const inventory = buildComponentInventory({ components: [], cleanBrief: '', conversation: [] });
  assert.deepEqual(inventory, []);
});

// ─── verifyComponentsInScript ───────────────────────────────────────────────
test('verifyComponentsInScript: every component present → no missing', () => {
  const script = [
    scene(1, 10, 'Cinematic establishing shot, teal palette, the shop opening'),
    scene(2, 10, 'Handmade bracelets close-up', 'These handmade bracelets are only $9.99.'),
    scene(3, 10, 'Confident closing shot, call to action', 'Follow @beadwick to save this.'),
  ];
  assert.deepEqual(verifyComponentsInScript(script, ['teal', '$9.99', 'Follow @beadwick']).missing, []);
});

test('verifyComponentsInScript: missing component reported; case-insensitive substring match', () => {
  const script = [
    scene(1, 10, 'Opening hook — promoting on TikTok'),
    scene(2, 10, 'The key benefit in action'),
  ];
  assert.deepEqual(verifyComponentsInScript(script, ['TIKTOK']).missing, [], 'case-insensitive match');
  assert.deepEqual(verifyComponentsInScript(script, ['tiktok', 'magenta']).missing, ['magenta'], 'only the absent one is missing');
});

test('verifyComponentsInScript: empty components → nothing missing', () => {
  const script = [scene(1, 10, 'Any visual'), scene(2, 10, 'Any other visual')];
  assert.deepEqual(verifyComponentsInScript(script, []).missing, []);
});

test('verifyComponentsInScript: component normalized before comparison', () => {
  const script = [scene(1, 10, 'Follow @beadwick now')];
  assert.deepEqual(verifyComponentsInScript(script, ['  Follow   @beadwick ']).missing, []);
});

// ─── normalizePlanTimeBudget (HARD TIME BUDGET) ─────────────────────────────
test('normalizePlanTimeBudget: GPT drift rescaled so the total sums EXACTLY to target', () => {
  // GPT planned 8+20+8 = 36s for a 30s video → proportional rescale to exactly 30.
  const plan = [scene(1, 8, 'a'), scene(2, 20, 'b'), scene(3, 8, 'c')];
  const out = normalizePlanTimeBudget(plan, 30);
  assert.equal(out.reduce((a, s) => a + s.duration, 0), 30);
  assert.deepEqual(out.map(s => s.duration), [7, 17, 6], 'integer-rounded + residual on the last scene');
});

test('normalizePlanTimeBudget: wild GPT drift (2+60+4 = 66s → 30s) still sums exactly', () => {
  const out = normalizePlanTimeBudget([scene(1, 2, 'a'), scene(2, 60, 'b'), scene(3, 4, 'c')], 30);
  assert.equal(out.reduce((a, s) => a + s.duration, 0), 30);
});

test('normalizePlanTimeBudget: already-exact plan is unchanged', () => {
  const plan = [scene(1, 5, 'a'), scene(2, 5, 'b'), scene(3, 5, 'c')];
  const out = normalizePlanTimeBudget(plan, 15);
  assert.deepEqual(out.map(s => s.duration), [5, 5, 5]);
  assert.equal(out.reduce((a, s) => a + s.duration, 0), 15);
});

test('normalizePlanTimeBudget: under-budget plan (10+10+10 = 30 → 25) sums exactly', () => {
  const out = normalizePlanTimeBudget([scene(1, 10, 'a'), scene(2, 10, 'b'), scene(3, 10, 'c')], 25);
  assert.equal(out.reduce((a, s) => a + s.duration, 0), 25);
  assert.deepEqual(out.map(s => s.duration), [8, 8, 9], 'residual added to the last scene');
});

test('normalizePlanTimeBudget: empty plan → empty', () => {
  assert.deepEqual(normalizePlanTimeBudget([], 30), []);
});

test('normalizePlanTimeBudget: preserves scene order, types and copy', () => {
  const plan = [scene(1, 8, 'hook visual', 'Opening narration'), scene(2, 20, 'benefit visual', ''), scene(3, 8, 'cta visual', 'Call to action.')];
  const out = normalizePlanTimeBudget(plan, 30);
  assert.equal(out[0].visualPrompt, 'hook visual');
  assert.equal(out[2].narration, 'Call to action.');
  assert.equal(out[1].visualType, 'still');
});

// ─── verifyArcCoverage (hook → about → CTA) ─────────────────────────────────
test('verifyArcCoverage: full arc passes (hook early, about middle, CTA last)', () => {
  const script = [
    scene(1, 8, 'Opening hook — establishing the shop', 'Meet Beadwick.'),
    scene(2, 8, 'Everything you need to know about handmade bracelets'),
    scene(3, 8, 'The key benefit in action'),
    scene(4, 6, 'Confident closing shot', 'Follow @beadwick and tap the link in bio!'),
  ];
  const flags = verifyArcCoverage(script);
  assert.deepEqual(flags, { hook: true, about: true, cta: true });
});

test('verifyArcCoverage: missing CTA in the final scene is flagged', () => {
  const script = [
    scene(1, 8, 'Opening hook — introducing the product'),
    scene(2, 8, 'The key benefit, what this is about'),
    scene(3, 8, 'The payoff shot'),
  ];
  const flags = verifyArcCoverage(script);
  assert.equal(flags.hook, true);
  assert.equal(flags.about, true);
  assert.equal(flags.cta, false, 'final scene carries no call-to-action wording');
});

test('verifyArcCoverage: empty script → all stages missing', () => {
  assert.deepEqual(verifyArcCoverage([]), { hook: false, about: false, cta: false });
});

test('verifyArcCoverage: the no-plan fallback arc satisfies all three stages (regression)', () => {
  // Mirror buildArcScenes wording (the deterministic fallback every plan degrades to).
  const subject = 'Beadwick & Co';
  const script = [
    scene(1, 6, `Cinematic establishing shot: hook intro of ${subject}`, `Opening — introducing ${subject}.`),
    scene(2, 6, `Cinematic medium shot: setting up ${subject}`, `Getting started: the essentials of ${subject} come into focus.`),
    scene(3, 6, `Cinematic wide shot: ${subject} delivering its key benefit`, `Now it comes together — the transformation and key benefit of ${subject} in action.`),
    scene(4, 6, `Cinematic close-up: the payoff result of ${subject}`, `The payoff: look at the result ${subject} delivers.`),
    scene(5, 6, `Cinematic closing shot: ${subject} final call-to-action`, `Call to action: ready to take the next step with ${subject}?`),
  ];
  assert.deepEqual(verifyArcCoverage(script), { hook: true, about: true, cta: true });
});