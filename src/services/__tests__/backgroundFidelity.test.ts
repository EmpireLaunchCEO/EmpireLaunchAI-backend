/**
 * CLIENT-STATED BACKGROUND / IMAGERY — the owner's top defect (owner, 2026-11-09):
 *   "it just ignores the background, even though in the chat it acknowledged it."
 *   "it still creates its own images .......not what is suggested by me"
 *   Canonical case, her own words: "it should be able to create an image of a
 *   happy family spending time together."
 *
 * WHAT THIS PINS: a background/subject the client TYPES in chat must be carried
 * into the image prompt that actually reaches the image model — in Scene, in
 * Faceless and in Twin. The consultant agreed in writing, so the renderer must
 * honour it deterministically (design principle 1); the planner arranges timing,
 * narration and overlays AROUND that content and has no business replacing it
 * (design principle 10 — a pipeline that silently substitutes a template fails).
 *
 * THE ASSERTION IS ON THE PROMPT THAT GOES OUT (design principle 13): every check
 * below reads `buildSceneImagePrompt(scene.visualPrompt)` — the exact string
 * `processScene` hands to `renderingEngine.renderImage` — never an intermediate
 * extraction variable. For Twin, whose frames are DRAWN (no image model call),
 * the artefact is the plan's visualPrompt, which is the twin's image instruction.
 *
 * FAILING FIRST (measured at origin/main `8b4eab3`, before the fix):
 *   - `extractRequestedImagery` did not exist (the client's sentence only reached
 *     the COMPONENTS INVENTORY, whose rule demands it be SPOKEN);
 *   - the F4 visual strip passed the WHOLE inventory as banned phrases, so the
 *     sentence was scrubbed from every visualPrompt;
 *   - Twin hard-coded "studio-lit dark background".
 *   → every scene-level assertion below failed.
 *
 * NO paid calls, NO network, NO ffmpeg: pure deterministic helpers in the same
 * order createProject runs them (the wiring itself is pinned at the bottom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildComponentInventory,
  extractRequestedImagery,
  isRequestedImageryItem,
  buildPlannerImagerySection,
  applyRequestedImagery,
  buildSceneImagePrompt,
  parseScenePlan,
  normalizePlanTimeBudget,
  applySceneMotionFloor,
  extractSoraBlockPrompts,
  injectSellingPointsIntoNarration,
  resolveNarrationRoles,
  enforceAvatarConsistency,
  extractAvatarLook,
  applyActionBackstop,
  stripBenefitTextFromVisualPrompts,
  type SceneScript,
} from '../sceneVideoPipelineService.js';
import { extractCreativeEssence, finishedEssenceSentences } from '../creativeTransformation.js';
import { userConversationText } from '../requestedVisuals.js';
import { buildTwinPlan, buildTwinVisualPrompt } from '../cinemaEngineService.js';
import { soraCallBudget } from '../soraVideoService.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = readFileSync(path.resolve(TEST_DIR, '../sceneVideoPipelineService.ts'), 'utf8');

/** The owner's canonical sentence, verbatim. */
const OWNER_PHRASE = 'a happy family spending time together';
const OWNER_SENTENCE = `The background should be ${OWNER_PHRASE}.`;

/** A real consultant transcript: she asks for the video, then names the picture,
 *  and the consultant AGREES in writing — the promise the render broke. */
const CONVERSATION: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'I want a 30 second video for my bakery.' },
  { role: 'assistant', content: 'Love it — a 30s promo for your bakery. What should it look like?' },
  { role: 'user', content: OWNER_SENTENCE },
  { role: 'assistant', content: `Perfect — ${OWNER_PHRASE} in the background, I'll use that.` },
];
const IDEA = 'A 30 second promo for my bakery.';
const DURATION = 30;

/** The planner reply that CAUSED the defect: it obeyed the F4 "components must be
 *  SPOKEN, never in a visualPrompt" rule, so the background went into the
 *  voiceover and its own stock bakery visuals stayed in the picture. */
const PLANNER_RAW = {
  scenes: [
    { sceneNumber: 1, duration: 6, visualType: 'still', visualPrompt: 'Warm bakery counter at sunrise, fresh loaves, soft window light', narration: 'Fresh bread, baked before the sun comes up.' },
    { sceneNumber: 2, duration: 6, visualType: 'still', visualPrompt: 'Close-up of hands pulling a golden loaf from the oven', narration: 'Every loaf is made by hand, the same way every morning.' },
    { sceneNumber: 3, duration: 6, visualType: 'still', visualPrompt: 'A tidy pastry display case, morning light across the glass', narration: 'Take home something warm for the people you love.' },
    { sceneNumber: 4, duration: 6, visualType: 'still', visualPrompt: 'Coffee being poured beside a paper bakery bag', narration: 'A happy family spending time together around the table.' },
    { sceneNumber: 5, duration: 6, visualType: 'still', visualPrompt: 'The bakery storefront at golden hour, open sign glowing', narration: 'Come by this weekend and try it yourself.' },
  ],
};

/** Mirror of createProject's post-plan sequence, in ITS order (see the wiring pin
 *  at the bottom of this file for why the order matters). */
function runLivePostPlan(raw: any, mode: 'scene' | 'faceless') {
  const inventory = buildComponentInventory({ cleanBrief: IDEA, conversation: CONVERSATION });
  const requestedImagery = extractRequestedImagery(`${IDEA} ${userConversationText(CONVERSATION)}`);
  const inventoryForPlanner = inventory.filter((c) => !isRequestedImageryItem(c, requestedImagery));
  const budget = soraCallBudget(DURATION);
  const scriptBeforeFloor = parseScenePlan(raw, IDEA, DURATION, mode);
  if (mode === 'faceless') for (const s of scriptBeforeFloor) s.visualType = 'still';
  const timeExact = normalizePlanTimeBudget(scriptBeforeFloor, DURATION, { dissolveCompensate: true });
  const script = mode === 'scene'
    ? applySceneMotionFloor(timeExact, extractSoraBlockPrompts(raw || {}, budget), budget)
    : timeExact;
  const planned: SceneScript[] = script.map((s) => ({ ...s }));
  const f4SellingPoints = finishedEssenceSentences(extractCreativeEssence(IDEA));
  const f4Narr = injectSellingPointsIntoNarration(planned, f4SellingPoints);
  const voiced = f4Narr.script.map((s) => ({ ...s }));
  const withRoles = resolveNarrationRoles(voiced);
  const avatarPass = enforceAvatarConsistency(withRoles, extractAvatarLook(raw || {}));
  const actionPass = applyActionBackstop(avatarPass.script);
  // THE F4 VISUAL BAN — banned list exactly as createProject builds it (imagery
  // removed from it; before the fix the WHOLE inventory was banned).
  const f4Visual = stripBenefitTextFromVisualPrompts(
    actionPass.script,
    [...f4SellingPoints, ...inventoryForPlanner, ...inventoryForPlanner.map((c) => String(c ?? '').replace(/^[-–—•*\s]+/, ''))]
      .filter((c) => !/^EmpireLaunch AI\.$/i.test(c)),
  );
  // THE CARRIED IMAGERY (the fix), after the strip.
  const imageryPass = applyRequestedImagery(f4Visual.script, requestedImagery);
  return {
    planned: imageryPass.script,
    requestedImagery,
    inventoryForPlanner,
    imageryPass,
    strippedScenes: f4Visual.strippedScenes,
  };
}

/** THE PROMPT THAT GOES OUT, per scene. */
const outboundPrompts = (plan: SceneScript[]) => plan.map((s) => buildSceneImagePrompt(s.visualPrompt));

// ─── 1. the client's sentence is extracted as IMAGERY ────────────────────────
test('extractRequestedImagery: the owner\'s canonical sentence becomes an image instruction', () => {
  const imagery = extractRequestedImagery(`${IDEA} ${OWNER_SENTENCE}`);
  assert.equal(imagery.length, 1, `expected exactly one image instruction, got ${JSON.stringify(imagery)}`);
  assert.equal(imagery[0].phrase.toLowerCase(), OWNER_PHRASE);
  assert.equal(imagery[0].scope, 'background', 'a background applies to the whole video, so every scene carries it');
});

test('extractRequestedImagery: an INSTRUCTION with no subject of its own is never promoted into the picture (PR #148 defect 1 stays fixed)', () => {
  for (const instruction of ['Make it look premium.', 'Keep it upbeat and cohesive.', 'Use a energetic mood across every scene.']) {
    assert.deepEqual(extractRequestedImagery(instruction), [], `"${instruction}" is style direction, not imagery`);
  }
});

// ─── 2. the planner is TOLD, and told correctly ──────────────────────────────
test('the planner prompt carries her imagery as imagery — and it is NOT also demanded as spoken copy', () => {
  const requestedImagery = extractRequestedImagery(`${IDEA} ${userConversationText(CONVERSATION)}`);
  const inventory = buildComponentInventory({ cleanBrief: IDEA, conversation: CONVERSATION });
  const inventoryForPlanner = inventory.filter((c) => !isRequestedImageryItem(c, requestedImagery));
  // Before the fix the sentence sat in the inventory, whose rule is "MUST be
  // SPOKEN … NEVER put component text into a visualPrompt" — the loss point.
  assert.ok(inventory.some((c) => c.toLowerCase().includes(OWNER_PHRASE)), 'fixture: the sentence really does reach the inventory');
  assert.ok(!inventoryForPlanner.some((c) => c.toLowerCase().includes(OWNER_PHRASE)), 'it must not be demanded as spoken copy as well');
  const section = buildPlannerImagerySection(requestedImagery);
  assert.ok(section.toLowerCase().includes(OWNER_PHRASE), 'the request sent to GPT 5.2 must name what she asked to see');
  assert.match(section, /visualPrompt/i, 'and must say it belongs in the picture');
  assert.match(section, /NOT narration copy/i, 'and must not let the planner reduce it to voiceover');
});

// ─── 3. SCENE: her background reaches the image prompt ───────────────────────
test('SCENE — the outbound image prompt for EVERY scene contains her background', () => {
  const { planned, imageryPass } = runLivePostPlan(PLANNER_RAW, 'scene');
  assert.ok(planned.length >= 3, 'fixture: a real multi-scene plan');
  assert.ok(planned.some((s) => s.visualType === 'motion'), 'SCENE must enter its own branch (it is the mode that buys motion)');
  assert.ok(imageryPass.applied.length > 0, 'the carry-through must report what it carried');
  for (const prompt of outboundPrompts(planned)) {
    assert.ok(prompt.toLowerCase().includes(OWNER_PHRASE), `scene image prompt lost her background: "${prompt}"`);
  }
});

test('SCENE — DISCRIMINATOR: the planner\'s own plan did NOT contain it (the defect this fixes)', () => {
  const visualText = PLANNER_RAW.scenes.map((s) => s.visualPrompt).join(' ').toLowerCase();
  const narrationText = PLANNER_RAW.scenes.map((s) => s.narration).join(' ').toLowerCase();
  // The pre-fix state, exactly: the sentence reached the VOICEOVER (the planner
  // obeyed the old "components must be SPOKEN, never in a visualPrompt" rule) and
  // no visualPrompt carried it — so the picture was the planner's own invention.
  assert.ok(narrationText.includes(OWNER_PHRASE), 'fixture: the planner said it out loud');
  assert.ok(!visualText.includes(OWNER_PHRASE), 'fixture: and never put it in a picture');
  assert.ok(PLANNER_RAW.scenes[0].visualPrompt.toLowerCase().includes('bakery'), 'its own stock bakery scene, not hers');
});

// ─── 4. FACELESS: same guarantee, its own branch ─────────────────────────────
test('FACELESS — the outbound image prompt for EVERY scene contains her background', () => {
  const { planned } = runLivePostPlan(PLANNER_RAW, 'faceless');
  assert.ok(planned.every((s) => s.visualType === 'still'), 'FACELESS must enter its own branch (stills only, zero motion)');
  for (const prompt of outboundPrompts(planned)) {
    assert.ok(prompt.toLowerCase().includes(OWNER_PHRASE), `faceless image prompt lost her background: "${prompt}"`);
  }
});

// ─── 5. TWIN: its image instruction is hers, not a hard-coded template ───────
test('TWIN — every segment\'s image instruction carries her background and drops the hard-coded studio backdrop', () => {
  const script = 'Fresh bread, baked before the sun comes up. Every loaf is made by hand. Come by this weekend and try it yourself.';
  const requestedImagery = extractRequestedImagery(`${script} ${userConversationText(CONVERSATION)}`);
  const { plan } = buildTwinPlan(script, DURATION, 'female', requestedImagery);
  assert.ok(plan.length >= 2, 'fixture: a real multi-segment twin plan');
  for (const seg of plan) {
    assert.ok(seg.visualPrompt.toLowerCase().includes(OWNER_PHRASE), `twin image instruction lost her background: "${seg.visualPrompt}"`);
    assert.ok(!/studio-lit dark background/i.test(seg.visualPrompt), 'the template backdrop must not survive a client-stated one');
  }
});

test('TWIN — with no request the image instruction is byte-identical to the old default (no regression)', () => {
  const legacy = 'The same talking-head AI avatar built from the user\'s photo with a confident expression, facing the camera and speaking, subtle mouth movement, studio-lit dark background, vertical 9:16 frame — no text, no captions, no on-screen words.';
  assert.equal(buildTwinVisualPrompt('confident'), legacy);
  assert.equal(buildTwinVisualPrompt('confident', '   '), legacy);
});

// ─── 6. it is CARRIED, never GATED ──────────────────────────────────────────
test('the fix carries the words through — it never blocks or fails a render (no gate)', () => {
  const { planned } = runLivePostPlan(PLANNER_RAW, 'scene');
  assert.ok(planned.length > 0, 'a plan that ignored the background still renders — it is corrected, not rejected');
  const before = planned.map((s) => s.narration);
  const pass = applyRequestedImagery(planned, [{ phrase: OWNER_PHRASE, scope: 'background', source: OWNER_SENTENCE }]);
  assert.equal(pass.script.length, planned.length);
  assert.deepEqual(pass.script.map((s) => s.narration), before, 'narration is never rewritten by the imagery carry');
});

// ─── 7. WIRING PIN: the fixture above must match what production runs ────────
test('createProject actually runs the imagery pass AFTER the F4 visual strip, and asks the planner for it', () => {
  const stripAt = SERVICE_SRC.indexOf('const f4Visual = f4Voice');
  const passAt = SERVICE_SRC.indexOf('applyRequestedImagery(planned, requestedImagery)');
  const sectionAt = SERVICE_SRC.indexOf('buildPlannerImagerySection(requestedImagery)');
  const filterAt = SERVICE_SRC.indexOf('!isRequestedImageryItem(c, requestedImagery)');
  assert.ok(sectionAt > 0, 'the planner request must carry the client-stated imagery section');
  assert.ok(filterAt > 0, 'imagery must be kept out of the spoken-component list');
  assert.ok(passAt > 0, 'the imagery must be carried into the plan');
  assert.ok(stripAt > 0 && passAt > stripAt, 'and it must run AFTER the F4 benefit strip, which would otherwise scrub it back out');
});
