import { test } from 'node:test';
import assert from 'node:assert';
import { extractCreativeEssence, finishedCreativeSubject, isInternalBriefEcho, isInternalSoundingBrief, isInternalTalkPoint, transformTwinScriptToPitch, buildTransformationPlannerRule, buildCompactSubject, finishedEssenceBrief, extractRelayedBenefits } from '../creativeTransformation.js';

/**
 * CREATIVE TRANSFORMATION LAYER — regression tests (owner Sep 28, task e4fddfab).
 * The owner's live-test defect: EVERY video she creates — Scene, Faceless, Twin —
 * recites her typed brief verbatim and shows the chat's internal structure
 * ("need 5 client beta testers", "5 compelling reasons", "CTA") instead of a
 * finished client pitch. These tests pin the transformation layer: the typed
 * brief is RAW MATERIAL; the video is a FINISHED PITCH built from the
 * client-facing essence, never from the brief's literal words or its structure.
 */

const OWNER_BRIEF = 'New all in one- content creation, editing platform- need 5 client beta testers.';

test('extractCreativeEssence: owner brief → finished client-facing subject, never the internal fragment', () => {
  const e = extractCreativeEssence(OWNER_BRIEF);
  assert.equal(e.internal, true, 'brief with "need 5 client beta testers" is internal-sounding');
  assert.ok(!/need\s+5\s+client\s+beta\s+testers/i.test(e.subject), 'never the recruiting fragment');
  assert.ok(!/beta\s+testers/i.test(e.subject), 'never the internal fragment');
  assert.ok(/all-in-one\s+content\s+creation/i.test(e.subject), 'product phrase survives');
  assert.ok(e.subject.startsWith('the '), 'finished subject reads as a definite noun phrase');
  assert.equal(e.product, 'all-in-one content creation and editing platform');
});

test('finishedCreativeSubject: internal-sounding brief → rewritten; clean brief untouched', () => {
  assert.equal(
    finishedCreativeSubject(OWNER_BRIEF),
    'the all-in-one content creation and editing platform'
  );
  assert.equal(
    finishedCreativeSubject('A scheduler that posts for you while you sleep'),
    'A scheduler that posts for you while you sleep'
  );
});

test('essence: internal brief with no product before the marker → neutral finished fallback', () => {
  const e = extractCreativeEssence("We're looking for beta testers for our new app");
  assert.equal(isInternalSoundingBrief("We're looking for beta testers for our new app"), true);
  assert.equal(e.internal, true);
  assert.ok(e.subject.startsWith('the '));
  assert.ok(!/beta\s+testers/i.test(e.subject), 'never the internal fragment');
});

test('isInternalBriefEcho: flags internal-brief recitals, leaves finished copy alone', () => {
  assert.equal(isInternalBriefEcho('Need 5 client beta testers for my platform!'), true);
  assert.equal(isInternalBriefEcho('We are looking for beta testers'), true);
  assert.equal(isInternalBriefEcho('Here are the 5 compelling reasons our clients switch'), true);
  assert.equal(isInternalBriefEcho('Add a CTA card at the end'), true);
  assert.equal(isInternalBriefEcho('Call to action goes right here'), true);
  // Finished, client-directed copy is NEVER flagged:
  assert.equal(isInternalBriefEcho('Ready to make the move? Tap the link in bio.'), false);
  assert.equal(isInternalBriefEcho('The upload takes two seconds and it is already processing.'), false);
  assert.equal(isInternalBriefEcho('Five reasons to love handmade candles'), false, 'plain "reasons to love" is client copy');
  assert.equal(isInternalBriefEcho('Handmade bracelets from our shop, gentle on your skin and your budget.'), false);
  assert.equal(isInternalBriefEcho(null), false);
});

test('isInternalTalkPoint: keeps real relayed components, drops internal meta', () => {
  // Client-relayed components must survive:
  assert.equal(isInternalTalkPoint('TikTok'), false);
  assert.equal(isInternalTalkPoint('lavender'), false);
  assert.equal(isInternalTalkPoint('$9.99'), false);
  assert.equal(isInternalTalkPoint('20% off'), false);
  assert.equal(isInternalTalkPoint('Follow @beadwick'), false);
  assert.equal(isInternalTalkPoint('link in bio'), false);
  // The brief's internal structure must never become a required component:
  assert.equal(isInternalTalkPoint('5 compelling reasons'), true);
  assert.equal(isInternalTalkPoint('need 5 client beta testers.'), true);
  assert.equal(isInternalTalkPoint('CTA'), true);
  assert.equal(isInternalTalkPoint('the making of'), true);
});

test('transformTwinScriptToPitch: internal script → finished pitch; finished user script verbatim', () => {
  const pitch = transformTwinScriptToPitch(OWNER_BRIEF);
  assert.ok(!/beta\s+testers/i.test(pitch), 'twin never recites the brief');
  assert.ok(/all-in-one\s+content\s+creation/i.test(pitch), 'pitch carries the product');
  assert.ok(/ready\s+to\s+make\s+the\s+move/i.test(pitch), 'ends in a client-directed CTA');
  // A user's own finished script is authoritative (LINE_CHANGE carve-out):
  assert.equal(
    transformTwinScriptToPitch('Welcome to my Empire! This is my Neural Twin double, ready to market 24/7.'),
    'Welcome to my Empire! This is my Neural Twin double, ready to market 24/7.'
  );
});

test('buildTransformationPlannerRule: hard rule tells the planner to pitch the essence', () => {
  const rule = buildTransformationPlannerRule();
  assert.ok(/RAW MATERIAL/i.test(rule));
  assert.ok(/FINISHED PITCH/i.test(rule));
  assert.ok(/internal-sounding/i.test(rule));
  assert.ok(/beta\s+testers/i.test(rule));
});

// ── OWNER OCT 9 re-test regression (task ddcc1b95) ─────────────────────────
test('subject never swallows a possessive bullet fragment ("the Your Go")', () => {
  // Long first sentence (>200ch) trips the degenerate guard -> buildCompactSubject.
  // The Oct 9 owner brief had this shape: brand + "Your Go To platform" + benefits
  // + the UI tail "…get started! Yes".
  const brief = 'Say hello to EmpireLaunch AI your Go To platform for all in one creation editing and design, stop wasting money on credit apps that charge you monthly, save time and money while you build and scale your brands, all at an introductory price you will love, get started! Yes';
  const e = extractCreativeEssence(brief);
  assert.ok(e.degenerateFallback, `expected degenerate fallback, got subject=${e.subject}`);
  assert.ok(!/(?:^|\s)Your Go(?:$|\s)|— the (?:your|our|my|their)\b/i.test(e.subject), `subject leaked possessive fragment: ${e.subject}`);
  assert.ok(!/get started!?\s+yes/i.test(e.subject), `subject leaked UI chat tail: ${e.subject}`);
  assert.ok(e.subject.length <= 160);
  assert.ok(e.subject.startsWith('EmpireLaunch AI'), `brand lost: ${e.subject}`);
});
test('essence relays real product substance (F3 over-collapse guard)', () => {
  const brief = 'EmpireLaunch AI is your go-to platform for all-in-one creation, editing and design. Stop wasting money on credit apps — save time and money building and scaling brands. Introductory price. Get started! Yes';
  const e = extractCreativeEssence(brief);
  const all = [e.subject, e.product, e.offer, e.audience].filter(Boolean).join(' ').toLowerCase();
  assert.ok(/all-in-one|creation|design|editing/.test(all), `substance lost: ${all}`);
  assert.ok(!/get started|yes/i.test(e.subject), `subject carried chat tail: ${e.subject}`);
});
test('compact fallback keeps brand + product and no chat tail', () => {
  const brief = 'Introducing EmpireLaunch AI your Go To platform for creators. Use a energetic mood across every scene. Yes Make sure it is cohesive.';
  const c = buildCompactSubject(brief);
  assert.ok(c.includes('EmpireLaunch AI'), `brand lost: ${c}`);
  assert.ok(!/make sure|energetic mood|Yes/i.test(c), `chat residue in subject: ${c}`);
  assert.ok(!c.toLowerCase().includes('your go'), `possessive fragment in subject: ${c}`);
});

// ── OWNER OCT 9 ACCEPTANCE — REAL ROUTE SHAPE (task da4ef0ed) ───────────────
// The Oct 9 acceptance render (project 7e89b3d4, approval 0af8f15f) ran the
// FULL reconstructed brief through POST /api/approval/create (type faceless,
// mood energetic, duration 15, ends "…get started! Yes"). Stored result:
//   subject = "EmpireLaunch AI — the ur go", degenerateFallback TRUE,
//   offer = "Save time" ONLY, plan narrations carried ZERO benefits.
// This test is shaped EXACTLY like that input and FAILS on pre-fix main
// (subject "EmpireLaunch AI — the ur go" ≠ "EmpireLaunch AI"; benefits missing).
const OCT9_ACCEPTANCE_BRIEF = "Introducing EmpireLaunch AI, your go to platform for all-in-one creation, editing and design. Stop wasting money on credit apps. Save time and money. Build and scale your brands. Get started today for the introductory price! Yes Make sure it's cohesive and makes customers want to get this app.";
const OCT9_BENEFITS = [
  'all-in-one creation, editing and design',
  'stop paying for single-purpose apps',
  'save time and money',
  'build and scale your brand',
  'introductory price',
];

test('REAL ROUTE (Oct 9): degenerate fallback subject is EXACTLY "EmpireLaunch AI" — no "ur go" fragment', () => {
  const e = extractCreativeEssence(OCT9_ACCEPTANCE_BRIEF);
  assert.equal(e.degenerateFallback, true, `expected degenerate fallback, got subject=${e.subject}`);
  assert.equal(e.subject, 'EmpireLaunch AI', `subject must be exactly the brand: ${e.subject}`);
  assert.equal(e.product, 'EmpireLaunch AI', `product must not carry a bullet fragment: ${e.product}`);
  assert.ok(!/ur\s+go|— the ur|the ur go/i.test(e.subject), `possessive text-speak fragment leaked: ${e.subject}`);
  assert.ok(!/get started|yes|make sure|cohesive|wants to get/i.test(e.subject), `chat tail leaked: ${e.subject}`);
});

test('REAL ROUTE (Oct 9): ALL FIVE benefits relayed as finished copy (no over-collapse)', () => {
  const e = extractCreativeEssence(OCT9_ACCEPTANCE_BRIEF);
  assert.ok(Array.isArray(e.benefits) && e.benefits.length === 5, `expected 5 relayed benefits, got ${JSON.stringify(e.benefits)}`);
  for (const b of OCT9_BENEFITS) {
    assert.ok(e.benefits!.some((x) => x.toLowerCase() === b.toLowerCase()), `missing relayed benefit: ${b} — got ${JSON.stringify(e.benefits)}`);
  }
  assert.equal(e.offer, 'Save time and money', `offer must be the FULL phrase, not "Save time": ${e.offer}`);
  // No raw-brief fragment anywhere in the finished essence fields.
  const all = [e.subject, e.product, e.offer, ...(e.benefits ?? [])].join(' ').toLowerCase();
  assert.ok(!/get started|wants to get|cohesive|make sure|^yes\b|\byes\b/i.test(all), `residue in finished essence: ${all}`);
});

test('REAL ROUTE (Oct 9): planner receives the FINISHED ESSENCE BRIEF (subject + all benefits)', () => {
  // Mirrors the exact plannerBrief expression in createProject() — the planner
  // input is the finished essence brief, NEVER the raw brief or a bare subject.
  const e = extractCreativeEssence(OCT9_ACCEPTANCE_BRIEF);
  const plannerBrief = (e.internal || e.degenerateFallback) ? finishedEssenceBrief(e) : '';
  assert.ok(plannerBrief.startsWith('EmpireLaunch AI.'), `planner brief starts with brand: ${plannerBrief}`);
  for (const b of OCT9_BENEFITS) {
    assert.ok(plannerBrief.toLowerCase().includes(b), `planner brief relays benefit: ${b} — got: ${plannerBrief}`);
  }
  assert.ok(!/ur\s+go|get started|wants to get|cohesive|make sure/i.test(plannerBrief), `residue in planner brief: ${plannerBrief}`);
  // Every relayed benefit is FINISHED copy — never a raw brief fragment:
  // subject + the five benefits = 6 finished sentences (audience absent here).
  const sentences = plannerBrief.split('.').filter((s) => s.trim().length > 0);
  assert.equal(sentences.length, 6, `finished sentence count (subject+5 benefits): ${plannerBrief}`);
});

test('REAL ROUTE (Oct 9): extractRelayedBenefits covers the five concrete benefits', () => {
  const rel = extractRelayedBenefits(OCT9_ACCEPTANCE_BRIEF);
  assert.equal(rel.length, 5, `got ${JSON.stringify(rel)}`);
  for (const b of OCT9_BENEFITS) assert.ok(rel.includes(b), `missing ${b}`);
  assert.ok(rel.every((x) => !/get started|wants to get|yes|cohesive|make sure/i.test(x)), `raw fragment in relay set: ${JSON.stringify(rel)}`);
});

test('REAL ROUTE (Oct 9): planner hard rule names all five benefits for narration', () => {
  const rule = buildTransformationPlannerRule();
  const lower = rule.toLowerCase();
  for (const b of OCT9_BENEFITS) {
    assert.ok(lower.includes(b), `rule relays benefit: ${b} — ${rule.slice(0, 300)}`);
  }
});
