/**
 * DEFECT 1 — client INSTRUCTIONS leak into image and video prompts as CONTENT.
 *
 * Owner's words: "any bug that is named gets fixed."
 *
 * What the client saw: she typed "make it look premium" in the consultant chat. The
 * inventory builder turned every user turn into "components", the substring check
 * could not find "make it look premium" in the plan (of course not — it is a note
 * about how the video should FEEL), and the deterministic backstop appended it
 * VERBATIM to a scene's visualPrompt. That string IS the model prompt, so the image
 * model was asked to draw it — and the same text was concatenated into the Veo take
 * prompt. Her note about the mood became content, painted onto the video.
 *
 * Why it survived: the only filters were blocklists of literal chat phrases
 * (stripInstructionResidue / isChatResidueText). "make it look premium",
 * "don't use the word cheap", "more energy" match neither list.
 *
 * The fix classifies by GRAMMATICAL MOOD: a directive is STYLE GUIDANCE for the
 * planner and can never be painted; a directive that names a concrete subject
 * ("add a photo of my dog") is still CONTENT and must reach the plan.
 *
 * Pure + offline: no model, no ffmpeg, no network, no spend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInventoryIntent,
  isDirectiveInstruction,
  buildComponentInventory,
  buildStyleGuidance,
  injectMissingComponents,
  verifyComponentsInScript,
  type SceneScript,
} from '../sceneVideoPipelineService.js';

const scene = (n: number, visualPrompt: string, narration = ''): SceneScript => ({
  sceneNumber: n, duration: 6, visualType: 'still', visualPrompt, narration,
});

// ─── the predicate ──────────────────────────────────────────────────────────
test('directive: an instruction about how the video should FEEL is a directive', () => {
  for (const phrase of [
    'make it look premium',
    "don't use the word cheap",
    'more energy',
    'keep the energy up',
    'it should feel calm',
    'use a teal palette',
    'make the narration shorter',
    'you should keep the scenes short',
  ]) {
    assert.equal(classifyInventoryIntent(phrase), 'directive', `"${phrase}" is an instruction, not content`);
    assert.equal(isDirectiveInstruction(phrase), true);
  }
});

test('directive: an instruction that NAMES a concrete subject is still CONTENT', () => {
  // The over-correction guard: never silently drop a subject the client actually named.
  for (const phrase of [
    'add a photo of my dog',
    'show the candle on a linen table',
    'include the kraft gift box',
    'put the wick being lit in the last scene',
  ]) {
    assert.equal(classifyInventoryIntent(phrase), 'content', `"${phrase}" names something to show`);
    assert.equal(isDirectiveInstruction(phrase), false);
  }
});

test('directive: plain description is untouched (no instruction framing at all)', () => {
  for (const phrase of [
    'Handmade beaded bracelets from our shop',
    'Our shop Beadwick & Co sells handmade bracelets on TikTok for $9.99 with a teal palette.',
    'Sunday Morning candle, warm vanilla and cedar',
    '20% off this week',
    'Follow @beadwick to save this',
  ]) {
    assert.equal(classifyInventoryIntent(phrase), 'content', `"${phrase}" must stay content`);
  }
});

// ─── the inventory no longer swallows the instruction ───────────────────────
test('inventory: "make it look premium" yields NO inventory item containing "premium"', () => {
  const inventory = buildComponentInventory({
    components: [],
    cleanBrief: '',
    conversation: [{ role: 'user', content: 'make it look premium' }],
  });
  assert.equal(
    inventory.some(c => /premium/i.test(c)),
    false,
    `an instruction must never become a component to paint: ${JSON.stringify(inventory)}`,
  );
  // ...and the words are not thrown away: they become style guidance for the planner.
  const style = buildStyleGuidance({
    components: [],
    cleanBrief: '',
    conversation: [{ role: 'user', content: 'make it look premium' }],
  });
  assert.ok(style.some(c => /premium/i.test(c)), `the instruction must reach the planner as direction: ${JSON.stringify(style)}`);
});

test('injection: a directive leaves every visualPrompt BYTE-IDENTICAL and is reported as skipped', () => {
  const script = [
    scene(1, 'Cinematic establishing shot of the amber jar on a linen table', 'Sunday Morning, poured by hand.'),
    scene(2, 'Close-up of the wick catching, flame rising', 'Light it and the vanilla opens up.'),
  ];
  const before = script.map(s => s.visualPrompt);
  const result = injectMissingComponents(script, ['make it look premium']);
  assert.deepEqual(result.script.map(s => s.visualPrompt), before, 'no visualPrompt may change');
  assert.deepEqual(result.injected, [], 'nothing was painted');
  assert.ok(result.skippedResidue.some(c => /make it look premium/i.test(c)), 'the directive is REPORTED, not silently dropped');
  assert.deepEqual(result.stillMissing, [], 'an instruction is never a missing component');
});

test('verification: a directive can never be reported as a missing component', () => {
  const script = [scene(1, 'Cinematic establishing shot', 'Say hello.')];
  assert.deepEqual(verifyComponentsInScript(script, ['more energy', 'make it look premium']).missing, []);
});

// ─── the content case still reaches the plan ────────────────────────────────
test('inventory: "add a photo of my dog" still reaches the plan as content', () => {
  const inventory = buildComponentInventory({
    components: [],
    cleanBrief: '',
    conversation: [{ role: 'user', content: 'add a photo of my dog' }],
  });
  assert.ok(
    inventory.some(c => /photo of my dog/i.test(c)),
    `a directive that names a subject must still reach the plan: ${JSON.stringify(inventory)}`,
  );
  // And it is placed like any other content item.
  const script = [scene(1, 'Cinematic establishing shot', 'Say hello.')];
  const placed = injectMissingComponents(script, inventory);
  assert.ok(placed.injected.some(c => /photo of my dog/i.test(c)), 'the named subject lands in the plan');
});
