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

// OWNER EXPANSION (Oct 19, rev 163): the dictation-fidelity bar applies to ALL
// modes — "make sure this follows suit for scene based and twin as well." The
// fix lives in the SHARED extraction/planner layer, so these discriminators pin
// Scene-mode + Twin-mode briefs through the exact same entry points the
// faceless path uses. If a mode-specific branch ever bypassed this layer, the
// asserts below trip.

test('10. SCENE-mode brief: dictated opening, bullets, end flash, mood all honored via shared layer', () => {
  const sceneBrief =
    'Scene-based promo for EmpireLaunch AI. Meet EmpireLaunch AI. ' +
    '( You get 76 videos a month! NO CREDIT BUYING!! - these are bullet points to show on screen) ' +
    'flash empirelaunchai.com at the end. scene should show someone relaxing instead of being stuck on a phone';
  const v = extractRequestedVisuals(sceneBrief);
  assert.match(v.dictatedOpening!, /^Meet EmpireLaunch AI/, 'scene-mode dictated opening verbatim');
  assert.ok(v.bullets && v.bullets.length >= 2, 'scene bullets extracted');
  assert.ok(v.bullets!.some((b) => /76 videos a month/.test(b)), 'scene bullet 1 present');
  assert.ok(v.bullets!.some((b) => /NO CREDIT BUYING/.test(b)), 'scene bullet 2 present');
  assert.match(v.endFlash!.text, /empirelaunchai\.com/i, 'scene end-flash domain');
  assert.match(v.mood!.positive.toLowerCase(), /someone relaxing/, 'scene mood positive');
  assert.match(v.mood!.avoid ?? '', /stuck on a phone/i, 'scene pain-point kept as NEVER-guard only');
  const d = buildDictationSection(v, 3);
  assert.ok(d.includes('USER-DICTATED OPENING') && d.includes('Meet EmpireLaunch AI'), 'scene planner block carries the dictated opening');
  assert.ok(d.includes('USER-REQUESTED END FLASH'), 'scene planner block carries the flash');
  assert.ok(d.includes('NEVER show'), 'scene planner block carries the NEVER-guard');
  const spec = buildBriefOverlaySpec(v, 3);
  assert.ok(spec && spec.perScene && spec.flash, 'scene overlay spec derived');
  assert.ok(spec!.perScene![0].bullets.length >= 2, 'scene bullets wired to assembly overlays');
});

test('11. TWIN-mode brief: dictated brand line, bullets, flash, mood follow suit', () => {
  const twinBrief =
    'I want a twin video for EmpireLaunch AI. Introducing EmpireLaunch AI, your new go-to platform. ' +
    '( You get 76 videos a month! NO CREDIT BUYING!! - these are bullet points) ' +
    'flash empirelaunchai.com at the end. show someone enjoying their craft instead of being glued to a phone';
  const v = extractRequestedVisuals(twinBrief);
  assert.match(v.dictatedOpening!, /^Introducing EmpireLaunch AI/, 'twin dictated opening verbatim (never rephrased)');
  assert.ok(v.bullets && v.bullets.length >= 2, 'twin bullets extracted');
  assert.match(v.endFlash!.text, /empirelaunchai\.com/i, 'twin end-flash domain');
  assert.match(v.mood!.positive.toLowerCase(), /enjoying their craft/, 'twin mood positive');
  assert.match(v.mood!.avoid ?? '', /glued to a phone/i, 'twin pain-point -> NEVER-guard');
  assert.ok(!/glued to a phone/.test(v.mood!.positive.toLowerCase()), 'twin positive never inverts');
  const d = buildDictationSection(v, 5);
  assert.ok(d.includes('Introducing EmpireLaunch AI'), 'twin planner block speaks the dictated line verbatim');
  assert.ok(d.includes('NEVER show'), 'twin NEVER-guard present');
  const spec = buildBriefOverlaySpec(v, 5);
  assert.ok(spec && spec.flash, 'twin overlay spec has the end flash');
});

test('12. mode-parity: Faceless / Scene / Twin all hit the SAME shared extraction contract', () => {
  const faceless =
    'Introducing EmpireLaunch AI. ( You get 76 videos a month! NO CREDIT BUYING!! - bullet points for the screen) ' +
    'flash empirelaunchai.com at the end. show someone relaxing instead of being stuck on a phone';
  const scene =
    'Scene-based promo for EmpireLaunch AI. Meet EmpireLaunch AI. ( You get 76 videos a month! NO CREDIT BUYING!! - these are bullet points to show on screen) ' +
    'flash empirelaunchai.com at the end. scene should show someone relaxing instead of being stuck on a phone';
  const twin =
    'I want a twin video for EmpireLaunch AI. Introducing EmpireLaunch AI, your new go-to platform. ( You get 76 videos a month! NO CREDIT BUYING!! - these are bullet points) ' +
    'flash empirelaunchai.com at the end. show someone enjoying their craft instead of being glued to a phone';
  for (const [label, b] of Object.entries({ faceless, scene, twin })) {
    const v = extractRequestedVisuals(b);
    assert.match(v.dictatedOpening!, /(Introducing|Meet) EmpireLaunch AI/, `${label}: dictated opening verbatim`);
    assert.ok(v.bullets && v.bullets.length >= 2, `${label}: bullets extracted`);
    assert.ok(v.bullets!.some((x) => /76 videos a month/.test(x)), `${label}: bullet 1 present`);
    assert.ok(v.bullets!.some((x) => /NO CREDIT BUYING/.test(x)), `${label}: bullet 2 present`);
    assert.match(v.endFlash!.text, /empirelaunchai\.com/i, `${label}: end flash`);
    assert.ok(v.mood && v.mood.positive, `${label}: mood directive`);
    assert.ok(!/(stuck on a phone|glued to a phone)/.test(v.mood!.positive.toLowerCase()), `${label}: positive never inverts`);
    assert.ok(/(stuck on a phone|glued to a phone)/.test((v.mood!.avoid ?? '').toLowerCase()), `${label}: pain point kept as NEVER-guard only`);
    const d = buildDictationSection(v, 5);
    assert.ok(d.includes('USER-DICTATED OPENING') && d.includes('USER-REQUESTED ON-SCREEN BULLETS'), `${label}: planner block mandatory`);
    assert.ok(d.includes('USER-REQUESTED END FLASH') && d.includes('NEVER show'), `${label}: flash + guard in planner block`);
    const spec = buildBriefOverlaySpec(v, 5);
    assert.ok(spec && spec.perScene && spec.flash, `${label}: assembly overlay spec derived`);
  }
});