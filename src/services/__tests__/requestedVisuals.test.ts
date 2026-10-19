import { test } from 'node:test';
import assert from 'node:assert';
import {
  extractRequestedVisuals,
  extractDictatedOpening,
  extractBullets,
  extractEndFlash,
  extractMood,
  userConversationText,
  buildDictationSection,
  buildBriefOverlaySpec,
  MAX_BULLETS,
} from '../requestedVisuals.js';
import { normalizeAssemblyOverlays } from '../assemblyOverlays.js';

/**
 * USER-REQUESTED ELEMENTS — discriminating fixtures (task 08041dff, owner
 * ADJUST #2 Oct 19). Her FIRST successful Faceless (85888d7f) was rejected on
 * content fidelity: dictated opening rephrased, no end-flash, no on-screen
 * bullets, mood inverted (asked relaxing, got someone upset on a phone).
 * These tests pin the deterministic extraction that feeds the planner prompt
 * + assembly overlays so her NEXT Faceless honors every ask.
 */

// VERBATIM owner brief from prod project 85888d7f (creativeTransformation.raw).
const OWNER_BRIEF =
  'Introducing EmpireLaunch Ai, your new content creation platform. ( You get 76 video creations a month! The best part is there is NO CREDIT BUYING!! - these are bullet points to show on screen- need to fit screen) This saves hundreds per month and hours of your time. Create content, edit personal videos or create designs for products! Go to EmpireLaunchAi.com Today to get started! (I want EmpireLaunchAi.com flashing at the bottom of the screen) The background needs to be encouraging, motivating. They get more time to do what they want. Yes that is fine. For the background show emotional benefit of someone doing what they love instead of being stuck on the phone Yes, and make this motivating to want to start now Yes, but make EmpireLaunchai.com flash';

test('1. dictated opening is preserved verbatim (never rephrased)', () => {
  const v = extractRequestedVisuals(OWNER_BRIEF);
  assert.ok(v.dictatedOpening, 'expected a dictated opening');
  assert.match(v.dictatedOpening!, /^Introducing EmpireLaunch Ai/i, 'opening must start with her word');
  assert.ok(!/Hello|Say hello/.test(v.dictatedOpening!), 'no rephrase');
});

test('2. on-screen bullet phrases are extracted, screen-fit capped', () => {
  const v = extractRequestedVisuals(OWNER_BRIEF);
  assert.ok(v.bullets && v.bullets.length >= 2, 'expected >= 2 bullet phrases');
  assert.ok(v.bullets!.length <= MAX_BULLETS, 'never more than the screen-fit cap');
  assert.ok(v.bullets!.some((b) => /76 video creations/.test(b)), 'first bullet = 76 video creations');
  assert.ok(v.bullets!.some((b) => /NO CREDIT BUYING/.test(b)), 'second bullet = NO CREDIT BUYING');
  assert.ok(v.bullets!.every((b) => !/bullet|fit screen|show on screen/i.test(b)), 'no instruction residue in items');
});

test('3. end-flash domain survives (EmpireLaunchAi.com)', () => {
  const v = extractRequestedVisuals(OWNER_BRIEF);
  assert.ok(v.endFlash, 'expected an end flash');
  assert.match(v.endFlash!.text, /empirelaunchai\.com/i, 'domain present');
});

test('4. mood/subject: relaxing/enjoying present, pain-point becomes NEVER-guard', () => {
  const v = extractRequestedVisuals(OWNER_BRIEF);
  assert.ok(v.mood, 'expected a mood directive');
  const pos = v.mood!.positive.toLowerCase();
  assert.match(pos, /(relax|enjoy|love|happy|motivat|encourag)/, 'positive mood present');
  assert.ok(/stuck on the phone/.test(v.mood!.avoid ?? ''), 'inversion target becomes the avoid-guard');
  const positive = v.mood!.positive.toLowerCase();
  assert.ok(!/stuck on the phone/.test(positive), 'positive phrase itself never inverts');
});

test('5. planner directive is mandatory and carries ALL four asks', () => {
  const v = extractRequestedVisuals(OWNER_BRIEF);
  const d = buildDictationSection(v, 5);
  assert.ok(d.includes('USER-DICTATED OPENING'), 'dictation block present');
  assert.ok(d.includes('Introducing EmpireLaunch Ai'), 'verbatim opening in prompt');
  assert.ok(d.includes('USER-REQUESTED ON-SCREEN BULLETS'), 'bullets block present');
  assert.ok(d.includes('76 video creations a month'), 'bullet item in prompt');
  assert.ok(d.includes('USER-REQUESTED END FLASH'), 'flash block present');
  assert.match(d, /empirelaunchai\.com/i, 'domain in prompt');
  assert.ok(d.includes('NEVER show'), 'mood NEVER-guard present');
});

test('6. overlay spec from the brief renders at assembly (bullets + flash)', () => {
  const v = extractRequestedVisuals(OWNER_BRIEF);
  const spec = buildBriefOverlaySpec(v, 5);
  assert.ok(spec, 'expected a spec for her asks');
  assert.ok(spec!.perScene && spec!.perScene.length === 1, 'bullets in scene 1');
  const bs = spec!.perScene![0].bullets;
  assert.ok(bs.length >= 2, 'bullet overlay entries');
  assert.ok(bs.every((b) => b.marker && b.at > 0), 'marker + bring-in time set');
  assert.ok(spec!.flash && /empirelaunchai\.com/i.test(spec!.flash.text), 'end flash set');
  const norm = normalizeAssemblyOverlays(spec, 5);
  assert.ok(norm && norm.perScene && norm.flash, 'normalizer accepts the derived spec');
});

test('7. negative: a brief with no asks produces nothing (never invents)', () => {
  const plain = 'A cozy coffee shop that roasts beans in house. Fresh coffee every morning.';
  const v = extractRequestedVisuals(plain);
  assert.deepStrictEqual(v, {}, 'no asks -> empty extraction');
  assert.strictEqual(buildDictationSection(v, 5), '', 'no directive block');
  assert.strictEqual(buildBriefOverlaySpec(v, 5), null, 'no overlay spec');
});

test('8. asks living only in conversation user turns are found via the union', () => {
  const idea = 'Build a promo for EmpireLaunch AI.';
  const turns = [
    { role: 'user', content: 'make accelerateai.co flash at the end of the video' },
    { role: 'assistant', content: "I'll plan that." },
    { role: 'user', content: 'show bullet points on screen: Save hours weekly; Save hundreds monthly' },
  ];
  const v = extractRequestedVisuals(idea + ' ' + userConversationText(turns));
  assert.ok(v.endFlash, 'flash from conversation detected');
  assert.match(v.endFlash!.text, /accelerate/i);
  assert.ok(v.bullets && v.bullets.length >= 2, 'bullets from conversation detected');
});

test('9. standalone extractors: Meet/This-is openings, dash-list bullets, avoid-only moods', () => {
  assert.strictEqual(extractDictatedOpening('Meet EmpireLaunch AI. It is fast.'), 'Meet EmpireLaunch AI');
  assert.strictEqual(
    extractDictatedOpening('This is the new go-to platform for creators.'),
    'This is the new go-to platform for creators',
  );
  const dash = '- Save hours weekly;\n- Save hundreds monthly; these are bullet points for the video';
  assert.deepStrictEqual(extractBullets(dash), ['Save hours weekly', 'Save hundreds monthly']);
  const flash = 'Please flash AccelerateAI.co at the very end.';
  assert.deepStrictEqual(extractEndFlash(flash), { text: 'AccelerateAI.co' });
  const avoidOnly = 'Show people relaxing instead of being overwhelmed by notifications.';
  const mood = extractMood(avoidOnly);
  assert.ok(mood && /relaxing/.test(mood.positive.toLowerCase()), 'positive extracted');
  assert.ok(mood && /overwhelmed by notifications/.test(mood.avoid ?? ''), 'avoid guard extracted');
});