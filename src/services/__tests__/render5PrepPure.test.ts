/**
 * RENDER #5 PREP — pure tests (ZERO paid API calls, ZERO ffmpeg):
 *   (1) OWNER-SCRIPT NARRATION OVERRIDE — the owner's 8 dictated lines are spoken
 *       VERBATIM (F4 expected-set = her lines → 8/8), her lines stay OUT of
 *       visualPrompts, and scenes are sized from spoken-length rooms so every line
 *       is FULLY spoken (delivered lands in the 29.5–30.5s band; tighten pauses,
 *       never words).
 *   (2) LINK-IN-BIO DEFAULT BAN — generated narration NEVER carries link-in-bio
 *       phrasing unless the owner/client explicitly requested it (enforced at the
 *       transformation output AND pre-TTS); the explicitly-requested case still
 *       works.
 *   (3) TAIL-CLIP preconditions — the default no-plan fallback CTA and the
 *       finished-copy fallback battery are link-in-bio free (the real ffmpeg
 *       deliverable is proven by render5TailClipFixture.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNarrationScript,
  mapNarrationLinesToScenes,
  sizeScenesToNarration,
  estimateNarrationRoom,
  applyNarrationOverride,
  applyLinkInBioBan,
  preTtsSanitize,
  verifySellingPointsSpoken,
  injectSellingPointsIntoNarration,
  stripBenefitTextFromVisualPrompts,
  deliveredVideoDuration,
  dissolveCompensatedSceneSum,
  finalCopyFallbackLine,
} from '../sceneVideoPipelineService.js';
import {
  containsLinkInBio,
  stripLinkInBioPhrases,
} from '../creativeTransformation.js';

/** The owner's dictated script — VERBATIM (Render #5 prep, Oct 11). */
const OWNER_SCRIPT = [
  'Introducing EmpireLaunch AI. Your new go to platform.',
  'You get 76 videos a month,',
  'and the best part- you don\'t pay for credits with this platform.',
  'Create your content, Edit your personal content,',
  'do you create designs? You get 50 a month on this platform!',
  'You will save hours of work, and save hundreds monthly.',
  'Build your brand and business confidently with this platform.',
  'Go to EmpireLaunchAI.com to get started today!!',
];

/** A 5-scene faceless-shaped plan (durations sum exactly to 30 pre-override). */
const plan5 = () => [
  { sceneNumber: 1, duration: 6, visualType: 'still' as const, narration: 'Watch how this saves your time from day one.', visualPrompt: 'Close-up on the app home screen, finger tapping the upload button, hook intro' },
  { sceneNumber: 2, duration: 6, visualType: 'still' as const, narration: 'The essentials come together fast, and the process is simpler than it looks.', visualPrompt: 'Medium shot: setting up the fundamentals of the subject, early stage' },
  { sceneNumber: 3, duration: 6, visualType: 'still' as const, narration: 'And this is where it clicks — the transformation you came for.', visualPrompt: 'Wide shot: the subject delivering its key benefit, transformation in progress' },
  { sceneNumber: 4, duration: 6, visualType: 'still' as const, narration: "That's the payoff — real results, right in front of you.", visualPrompt: 'Close-up: the payoff result of the subject, breakthrough moment' },
  { sceneNumber: 5, duration: 6, visualType: 'still' as const, narration: 'Ready to make the move? You can get started today.', visualPrompt: 'Closing shot: the subject final call-to-action, confident ending' },
];

test('normalizeNarrationScript: array + newline/| string, empty -> null', () => {
  assert.deepEqual(normalizeNarrationScript(OWNER_SCRIPT), OWNER_SCRIPT);
  assert.deepEqual(normalizeNarrationScript(OWNER_SCRIPT.join('\n')), OWNER_SCRIPT);
  assert.deepEqual(normalizeNarrationScript(OWNER_SCRIPT.join('|')), OWNER_SCRIPT);
  assert.deepEqual(normalizeNarrationScript(['  a  ', '', ' b']), ['a', 'b']);
  assert.equal(normalizeNarrationScript(undefined), null);
  assert.equal(normalizeNarrationScript(null), null);
  assert.equal(normalizeNarrationScript([]), null);
  assert.equal(normalizeNarrationScript('   '), null);
  assert.equal(normalizeNarrationScript(42), null);
});

test('mapNarrationLinesToScenes: 8 lines -> 5 scenes [2,2,2,1,1] in order', () => {
  const m = mapNarrationLinesToScenes(OWNER_SCRIPT, 5);
  assert.deepEqual(m.map(x => x.length), [2, 2, 2, 1, 1]);
  assert.equal(m[0][0], OWNER_SCRIPT[0]);
  assert.equal(m[1][0], OWNER_SCRIPT[2]);
  assert.equal(m[2][0], OWNER_SCRIPT[4]);
  assert.equal(m[3][0], OWNER_SCRIPT[6]);
  assert.equal(m[4][0], OWNER_SCRIPT[7]);
  // order preserved end-to-end
  const flat = m.flat();
  assert.deepEqual(flat, OWNER_SCRIPT);
});

test('sizeScenesToNarration: every scene >= its narration room; exact dissolve-compensated sum; delivered in band', () => {
  const mapping = mapNarrationLinesToScenes(OWNER_SCRIPT, 5);
  const sizes = sizeScenesToNarration(mapping, 30);
  const rooms = mapping.map((lines, i) => Math.ceil(estimateNarrationRoom(lines)));
  // 8 lines across 5 scenes of a 30s video must deliver inside the owner band
  assert.equal(sizes.length, 5);
  sizes.forEach((s, i) => assert.ok(s >= Math.max(3, rooms[i]), `scene ${i + 1} size ${s} < room ${rooms[i]}`));
  // exact dissolve-compensated integer target (33 for 30s/5 scenes)
  assert.equal(sizes.reduce((a, b) => a + b, 0), Math.round(dissolveCompensatedSceneSum(30, 5)));
  const delivered = deliveredVideoDuration(sizes.map(s => ({ duration: s })));
  assert.ok(delivered >= 29.5 && delivered <= 30.5, `delivered ${delivered} outside 29.5-30.5 band`);
});

test('applyNarrationOverride: verbatim lines, F4 expected-set = her lines (8/8), visuals untouched', () => {
  const r = applyNarrationOverride(plan5(), OWNER_SCRIPT, 30);
  assert.equal(r.script.length, 5);
  // narration carried verbatim (all 8 lines present across the scenes)
  const verified = verifySellingPointsSpoken(r.script, OWNER_SCRIPT);
  assert.deepEqual(verified.missing, []);
  // F4 injector (the deterministic backstop) early-returns — nothing to inject,
  // and crucially it must NOT truncate her lines to the SHORT cap
  const f4 = injectSellingPointsIntoNarration(r.script, OWNER_SCRIPT);
  assert.equal(f4.injected.length, 0);
  assert.deepEqual(f4.stillMissing, []);
  f4.script.forEach((s, i) => assert.equal(s.narration, r.script[i].narration));
  // every line is present verbatim somewhere
  for (const line of OWNER_SCRIPT) {
    assert.ok(r.script.some(s => s.narration.includes(line)), `missing spoken line: ${line}`);
  }
  // visuals untouched by the override (subject-exact/no-text stills come from the brief)
  assert.deepEqual(r.script.map(s => s.visualPrompt), plan5().map(s => s.visualPrompt));
  // durations resized and exact
  assert.equal(r.script.reduce((a, s) => a + s.duration, 0), Math.round(dissolveCompensatedSceneSum(30, 5)));
});

test('her lines stay OUT of visualPrompts (F4 visual-prompt ban with expected-set = her lines)', () => {
  // simulate a leak: one visualPrompt carries her line verbatim
  const leaked = plan5();
  leaked[0].visualPrompt = `Close-up on the app home screen — You get 76 videos a month, — finger tapping`;
  const stripped = stripBenefitTextFromVisualPrompts(leaked, OWNER_SCRIPT);
  assert.deepEqual(stripped.strippedScenes, [1]);
  assert.ok(!containsLinkInBio(stripped.script[0].visualPrompt)); // no residue
  assert.ok(!stripped.script[0].visualPrompt.toLowerCase().includes('76 videos a month'));
});

test('LINK-IN-BIO BAN: detection covers every owner-named phrasing, strips cleanly', () => {
  for (const p of ['click the link in bio', 'link in bio', 'link in my bio', 'check the link in bio', 'bio link']) {
    assert.ok(containsLinkInBio(p), `missed "${p}"`);
  }
  assert.ok(containsLinkInBio('Ready to make the move? Tap the link in bio.'));
  assert.ok(!containsLinkInBio(OWNER_SCRIPT.join(' ')), 'owner script must be link-in-bio free');
  assert.ok(!containsLinkInBio('biography'));
  assert.equal(stripLinkInBioPhrases('Ready to make the move? Tap the link in bio.'), 'Ready to make the move?.');
  assert.equal(stripLinkInBioPhrases('Nice offer — check the link in my bio today!'), 'Nice offer — today!');
});

test('LINK-IN-BIO BAN: default ban fires at the transformation output (narration + visuals); explicit request keeps narration', () => {
  const withBio = plan5();
  withBio[4].narration = 'Ready to make the move? Tap the link in bio.';
  withBio[4].visualPrompt = 'Closing shot with a big "click the link in bio" caption on screen';
  // NOT requested -> stripped everywhere
  const banned = applyLinkInBioBan(withBio, { allowLinkInBio: false });
  assert.deepEqual(banned.strippedNarrationScenes, [5]);
  assert.deepEqual(banned.strippedVisualScenes, [5]);
  assert.ok(!containsLinkInBio(banned.script[4].narration));
  assert.ok(!containsLinkInBio(banned.script[4].visualPrompt));
  // the phrase itself is gone from the visual (whatever imagery wording remains is fine)
  // explicitly requested -> narration KEEPS the phrase (authoritative copy), visuals still cleaned (F1)
  const allowed = applyLinkInBioBan(withBio, { allowLinkInBio: true });
  assert.deepEqual(allowed.strippedNarrationScenes, []);
  assert.deepEqual(allowed.strippedVisualScenes, [5]);
  assert.ok(containsLinkInBio(allowed.script[4].narration));
  assert.ok(!containsLinkInBio(allowed.script[4].visualPrompt));
});

test('LINK-IN-BIO BAN: pre-TTS sanitizer fires on residue, honors both allow flags, leaves clean copy alone', () => {
  const withBio = 'Ready to make the move? Tap the link in bio.';
  const fired = preTtsSanitize(withBio, { sceneId: 's1' });
  assert.equal(fired.replaced, true);
  assert.equal(fired.reason, 'link-in-bio');
  assert.ok(!containsLinkInBio(fired.text));
  // explicit request -> verbatim
  const kept = preTtsSanitize(withBio, { allowLinkInBio: true });
  assert.equal(kept.replaced, false);
  assert.equal(kept.text, withBio);
  // plan-speak still replaced (hygiene unchanged), but allowPlanSpeak keeps verbatim
  const planSpeak = preTtsSanitize('Step 1 of 3: opening', { sceneId: 's2' });
  assert.equal(planSpeak.replaced, true);
  assert.equal(planSpeak.reason, 'plan-speak');
  assert.ok(!containsLinkInBio(planSpeak.text));
  assert.equal(preTtsSanitize('Step 1 of 3: opening', { allowPlanSpeak: true, sceneId: 's2' }).replaced, false);
  // owner lines pass through untouched
  const ownerLine = preTtsSanitize(OWNER_SCRIPT[7], { sceneId: 's5' });
  assert.equal(ownerLine.replaced, false);
  assert.equal(ownerLine.text, OWNER_SCRIPT[7]);
});

test('default CTA copy (arc fallback + finished-copy battery) is link-in-bio free', () => {
  for (let beat = 0; beat < 12; beat++) {
    for (const seed of ['a', 'scene-xyz', '5f306a6e-622a-42d3-be52-e0bfdcf92211']) {
      assert.ok(!containsLinkInBio(finalCopyFallbackLine(seed, beat)), `fallback line has link-in-bio: ${finalCopyFallbackLine(seed, beat)}`);
    }
  }
  // the safe CTA used when a stripped line empties out is clean + speaks verbatim
  const emptied = preTtsSanitize('Just the link in bio', { sceneId: 's9' });
  assert.equal(emptied.replaced, true);
  assert.equal(emptied.text, 'Ready to make the move? You can get started today.');
});