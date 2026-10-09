import { test } from 'node:test';
import assert from 'node:assert';
import { extractCreativeEssence, finishedCreativeSubject, isInternalBriefEcho, isInternalSoundingBrief, isInternalTalkPoint, transformTwinScriptToPitch, buildTransformationPlannerRule, buildCompactSubject } from '../creativeTransformation.js';

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
