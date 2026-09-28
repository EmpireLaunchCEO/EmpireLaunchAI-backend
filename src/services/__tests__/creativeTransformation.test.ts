import { test } from 'node:test';
import assert from 'node:assert';
import { extractCreativeEssence, finishedCreativeSubject, isInternalBriefEcho, isInternalSoundingBrief, isInternalTalkPoint, transformTwinScriptToPitch, buildTransformationPlannerRule } from '../creativeTransformation.js';

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