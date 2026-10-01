import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCreativeEssence,
  stripInstructionResidue,
  isDegenerateEssenceOutput,
  buildCompactSubject,
  capNarrationForScene,
  NARRATION_MAX_CHARS,
  NARRATION_MAX_WORDS,
} from '../creativeTransformation.js';

/** The owner's Sep 30 faceless-launch brief (the failure that triggered this
 *  work) — it carried a 'CTA- Get … today … You choose …' residue tail. */
const PROD_BRIEF =
  'Stop wasting $150+ a month on credit-based AI apps. Meet EmpireLaunch AI \u2014 the all-in-one content creation, design, and editing platform built to help you create more for less. For just $50 a month, you get up to 96 videos \u2014 without constantly worrying about running out of credits. Create. Design. Edit. Launch. Everything you need to turn ideas into content, all in one powerful platform. Get in early. Create faster. Stay ahead of the competition. This is EmpireLaunch AI. Ok CTA- Get EmpireLaunch AI today and start creating more for less You choose Use a energetic mood across every scene and the narration.';

test('DEGENERATE GUARD (owner Sep 30 brief): extraction is compact, residue never becomes the subject', () => {
  const e = extractCreativeEssence(PROD_BRIEF);
  assert.equal(e.degenerateFallback, true, 'long whole-brief extraction must trigger the compact fallback');
  assert.ok(e.subject.length <= 160, `subject must be compact (got ${e.subject.length} chars)`);
  const contentWords = e.subject.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  assert.ok(contentWords <= 12, `subject must be <= 12 content words (got ${contentWords})`);
  assert.match(e.subject, /^EmpireLaunch AI/, 'subject leads with the brand');
  assert.match(e.subject, /all-in-one content creation/, 'subject keeps the product phrase');
  assert.ok(!/CTA|Ok\b|mood|Choose/i.test(e.subject), 'no instruction residue in the subject');
});

test('DEGENERATE GUARD (owner Sep 30 brief): product is the same compact phrase and the raw brief is preserved for audit', () => {
  const e = extractCreativeEssence(PROD_BRIEF);
  assert.equal(e.product, e.subject);
  assert.ok(e.raw.includes('CTA- Get EmpireLaunch AI today'), 'raw brief stays fully intact for debugging');
  assert.ok(/[A-Za-z0-9]/.test(e.subject));
});

test('stripInstructionResidue: cuts CTA- / Ok / You choose / mood-hint tails at the EARLIEST marker', () => {
  const out = stripInstructionResidue('Love this idea. Ok CTA- Get the app today You choose Use a energetic mood across every scene and the narration.');
  assert.equal(out, 'Love this idea.');
  assert.equal(stripInstructionResidue('Clean brief with no residue.'), 'Clean brief with no residue.');
  assert.equal(stripInstructionResidue('Accelerate with empire tools. CTA- buy now'), 'Accelerate with empire tools.');
  assert.equal(stripInstructionResidue('Get it today. Use a cool mood across every scene for the visuals'), 'Get it today.');
});

test('isDegenerateEssenceOutput: flags whole-brief echoes and residue markers, not clean subjects', () => {
  assert.equal(isDegenerateEssenceOutput('x'.repeat(260)), true, 'over-long subject is degenerate');
  assert.equal(isDegenerateEssenceOutput('Buy now. Ok this is the CTA- for the launch'), true);
  assert.equal(isDegenerateEssenceOutput('Say hello to EmpireLaunch AI \u2014 the all-in-one platform'), false);
  assert.equal(isDegenerateEssenceOutput(''), false, 'empty subject is not degenerate (hasProduct governs)');
});

test('buildCompactSubject: brand + product rewrite from a long brief', () => {
  const out = buildCompactSubject(PROD_BRIEF);
  assert.equal(out, 'EmpireLaunch AI \u2014 the all-in-one content creation, design, and editing platform');
  assert.ok(out.length <= 160);
});

test('NARRATION CAP: 6s scene holds at most ~15 content words / ~120 chars, word-boundary truncation', () => {
  const longNar = 'Say hello to the all-in-one content creation and editing platform for creators who want to publish faster every single day without ever thinking about credits again, plus a free trial and more.';
  const capped = capNarrationForScene(longNar, 6);
  const contentWords = capped.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  assert.ok(capped.length <= NARRATION_MAX_CHARS, `${capped.length} chars > cap`);
  assert.ok(contentWords <= NARRATION_MAX_WORDS, `${contentWords} words > cap`);
  assert.ok(!/,\s*plus\b|\smore\.?$/.test(capped), 'truncated at a word boundary, never mid-list');
});

test('NARRATION CAP: em-dash and punctuation tokens are NOT counted as words', () => {
  const line = 'Say hello to a clean brief subject \u2014 it\'s about to make things a lot easier.';
  const capped = capNarrationForScene(line, 6);
  assert.equal(capped, line, '15 content words + one em-dash fits a 6s slot untouched');
});

test('NARRATION CAP: shorter scenes scale the cap down, always >= 8 words', () => {
  const capped4 = capNarrationForScene('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 4);
  const words4 = capped4.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  assert.ok(words4 <= 10, `4s scene cap = 10 words (got ${words4})`);
  const capped2 = capNarrationForScene('one two three four five six seven eight nine ten eleven twelve', 2);
  const words2 = capped2.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  assert.ok(words2 <= 8 && words2 >= 8, `floor at 8 words (got ${words2})`);
});

test('NARRATION CAP: empty / whitespace input returns untouched', () => {
  assert.equal(capNarrationForScene('', 6), '');
  assert.equal(capNarrationForScene('   ', 6), '');
});

test('REGARESSION: clean brief extraction unchanged (no degenerate trigger)', () => {
  const e = extractCreativeEssence('Handmade candles from our shop, gentle on your skin and your budget.');
  assert.equal(e.degenerateFallback, false);
  assert.equal(e.subject, 'Handmade candles from our shop, gentle on your skin and your budget.');
});

test('REGARESSION: owner\'s beta-tester brief still transforms identically', () => {
  const e = extractCreativeEssence('New all in one- content creation, editing platform- need 5 client beta testers.');
  assert.equal(e.degenerateFallback, false);
  assert.equal(e.subject, 'the all-in-one content creation and editing platform');
  assert.equal(e.product, 'all-in-one content creation and editing platform');
});