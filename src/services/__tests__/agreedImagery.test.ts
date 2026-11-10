/**
 * AN AGREED BACKGROUND IS A STATED BACKGROUND (owner, 2026-11-09, rule 1:
 * "stated → use it exactly" / "if client or background isn't mentioned, the AI
 * should ask, and use what is stated").
 *
 * The consultant offers a concrete default in chat — aiRouter.ts:134's own
 * example is `"background: I'd suggest a cozy home-studio scene"` — and the
 * client answers "yes". That acceptance is a decision. It used to be thrown
 * away, because it lives only in an ASSISTANT turn and both userConversationText
 * and buildComponentInventory read `role === 'user'` only. The planner then
 * invented the background again, exactly as before PR #149.
 *
 * THE ASSERTION IS ON THE PROMPT THAT GOES OUT (design principle 13): every
 * check below reads `buildSceneImagePrompt(scene.visualPrompt)` — the exact
 * string processScene hands to renderingEngine.renderImage.
 *
 * FAILING FIRST (measured at origin/main 323429f, before the fix):
 *   `extractAgreedSuggestionImagery` did not exist and nothing read an accepted
 *   assistant turn, so every outbound prompt was the planner's own invention.
 *   → "EVERY SCENE CARRIES THE AGREED BACKGROUND: false".
 *
 * NO paid calls, NO network, NO ffmpeg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildComponentInventory,
  extractRequestedImagery,
  extractAgreedSuggestionImagery,
  mergeRequestedImagery,
  isRequestedImageryItem,
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
  type RequestedImagery,
} from '../sceneVideoPipelineService.js';
import { extractCreativeEssence, finishedEssenceSentences } from '../creativeTransformation.js';
import { userConversationText } from '../requestedVisuals.js';
import { soraCallBudget } from '../soraVideoService.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = readFileSync(path.resolve(TEST_DIR, '../sceneVideoPipelineService.ts'), 'utf8');

/** What the consultant actually offers, in its own words (aiRouter.ts:134). */
const AGREED_PHRASE = 'cozy home-studio scene';
const SUGGESTION =
  `Background: I'd suggest a ${AGREED_PHRASE} — it reads warm and personal. ` +
  `Vibe: I'd suggest warm and cosy for this. Want me to apply that?`;

const IDEA = 'A 30 second promo for my bakery.';
const DURATION = 30;

/** THE DEFECT: nothing here is typed by the client. She only says "yes". */
const CONVERSATION: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'I want a 30 second video for my bakery.' },
  { role: 'assistant', content: 'Love it — a 30s promo for your bakery. What should it look like?' },
  { role: 'user', content: 'I am not sure, you pick.' },
  { role: 'assistant', content: SUGGESTION },
  { role: 'user', content: 'yes, that works' },
];

/** The planner reply that CAUSES the defect: it never heard the agreed
 *  background, so it invents its own stock bakery picture. */
const PLANNER_RAW = {
  scenes: [
    { sceneNumber: 1, duration: 6, visualType: 'still', visualPrompt: 'Warm bakery counter at sunrise, fresh loaves, soft window light', narration: 'Fresh bread, baked before the sun comes up.' },
    { sceneNumber: 2, duration: 6, visualType: 'still', visualPrompt: 'Close-up of hands pulling a golden loaf from the oven', narration: 'Every loaf is made by hand, the same way every morning.' },
    { sceneNumber: 3, duration: 6, visualType: 'still', visualPrompt: 'A tidy pastry display case, morning light across the glass', narration: 'Take home something warm for the people you love.' },
    { sceneNumber: 4, duration: 6, visualType: 'still', visualPrompt: 'Coffee being poured beside a paper bakery bag', narration: 'The bread is the reason people come back.' },
    { sceneNumber: 5, duration: 6, visualType: 'still', visualPrompt: 'The bakery storefront at golden hour, open sign glowing', narration: 'Come by this weekend and try it yourself.' },
  ],
};

/** Mirror of createProject's post-plan sequence, in ITS order. */
function runLivePostPlan(
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>,
  raw: any = PLANNER_RAW,
  mode: 'scene' | 'faceless' = 'faceless',
) {
  const inventory = buildComponentInventory({ cleanBrief: IDEA, conversation });
  // THE WIRING UNDER TEST — exactly what createProject now does.
  const requestedImagery: RequestedImagery[] = mergeRequestedImagery(
    extractRequestedImagery(`${IDEA} ${userConversationText(conversation)}`),
    extractAgreedSuggestionImagery(conversation),
  );
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
  const f4Visual = stripBenefitTextFromVisualPrompts(
    actionPass.script,
    [...f4SellingPoints, ...inventoryForPlanner, ...inventoryForPlanner.map((c) => String(c ?? '').replace(/^[-–—•*\s]+/, ''))]
      .filter((c) => !/^EmpireLaunch AI\.$/i.test(c)),
  );
  const imageryPass = applyRequestedImagery(f4Visual.script, requestedImagery);
  return { planned: imageryPass.script, requestedImagery, imageryPass };
}

const outboundPrompts = (plan: SceneScript[]) => plan.map((s) => buildSceneImagePrompt(s.visualPrompt));

// ─── 1. THE DEFECT ITSELF ───────────────────────────────────────────────────
test('ACCEPTED SUGGESTION — every outbound image prompt carries the background she agreed to', () => {
  const { planned, imageryPass } = runLivePostPlan(CONVERSATION);
  assert.ok(planned.length >= 3, 'fixture: a real multi-scene plan');
  const carries = outboundPrompts(planned).every((p) => p.toLowerCase().includes(AGREED_PHRASE));
  assert.ok(carries, `ANY SCENE CARRIES THE AGREED BACKGROUND: false — ${JSON.stringify(outboundPrompts(planned))}`);
  assert.ok(imageryPass.applied.some((a) => a.toLowerCase().includes(AGREED_PHRASE)), 'the carry-through reports what it carried');
});

test('ACCEPTED SUGGESTION — DISCRIMINATOR: the planner\'s own plan never contained it', () => {
  const visualText = PLANNER_RAW.scenes.map((s) => s.visualPrompt).join(' ').toLowerCase();
  assert.ok(!visualText.includes(AGREED_PHRASE), 'fixture: the planner invented its own bakery picture');
});

// ─── 2. CONSERVATIVE STILL HOLDS ────────────────────────────────────────────
test('an assistant turn on its own is never promoted to imagery — a proposal that was ignored is not stated', () => {
  const ignored = CONVERSATION.slice(0, 4); // the suggestion, with no acceptance after it
  assert.deepEqual(extractAgreedSuggestionImagery(ignored), []);
  const { planned } = runLivePostPlan(ignored);
  for (const p of outboundPrompts(planned)) {
    assert.ok(!p.toLowerCase().includes(AGREED_PHRASE), `an unaccepted proposal must not reach the picture: "${p}"`);
  }
});

test('a client who says NO or picks something else is not overridden', () => {
  for (const refusal of ['no', 'no thanks', 'no, use a bright beach instead', 'not that one', 'actually make it a city rooftop']) {
    const conversation = [...CONVERSATION.slice(0, 4), { role: 'user' as const, content: refusal }];
    assert.deepEqual(
      extractAgreedSuggestionImagery(conversation),
      [],
      `"${refusal}" is not an acceptance of the suggested background`,
    );
  }
});

test('acceptance attaches to the suggestion just made, not to an unrelated earlier assistant message', () => {
  const conversation = [
    { role: 'user' as const, content: 'I want a 30 second video for my bakery.' },
    { role: 'assistant' as const, content: "Background: I'd suggest a city rooftop at night — it feels premium." },
    { role: 'user' as const, content: 'before that, what does it cost?' },
    { role: 'assistant' as const, content: SUGGESTION },
    { role: 'user' as const, content: 'sounds good' },
  ];
  const imagery = extractAgreedSuggestionImagery(conversation);
  assert.equal(imagery.length, 1, `expected exactly the last suggestion, got ${JSON.stringify(imagery)}`);
  assert.ok(imagery[0].phrase.toLowerCase().includes(AGREED_PHRASE));
  assert.ok(!imagery[0].phrase.toLowerCase().includes('rooftop'), 'the earlier, unrelated proposal must not be carried');
});

// ─── 3. IT REACHES THE PICTURE THE SAME WAY A TYPED ONE DOES ────────────────
test('an agreed background is scope "background" — it applies to every scene, like a typed one', () => {
  const [im] = extractAgreedSuggestionImagery(CONVERSATION);
  assert.equal(im.scope, 'background');
  assert.ok(!/I'd suggest/i.test(im.phrase), 'the consultant\'s framing must not reach the image prompt');
  assert.ok(!/vibe|cosy for this/i.test(im.phrase), 'only the visual proposal is carried, not the vibe suggestion');
});

test('SCENE mode carries it too (it is the mode that buys motion)', () => {
  const { planned } = runLivePostPlan(CONVERSATION, PLANNER_RAW, 'scene');
  assert.ok(planned.some((s) => s.visualType === 'motion'), 'fixture: scene entered its own branch');
  for (const p of outboundPrompts(planned)) {
    assert.ok(p.toLowerCase().includes(AGREED_PHRASE), `scene image prompt lost the agreed background: "${p}"`);
  }
});

test('what the client TYPED still wins over an earlier suggestion (no double background)', () => {
  const typed = [
    ...CONVERSATION.slice(0, 4),
    { role: 'user' as const, content: 'Also, the background should be a happy family spending time together.' },
  ];
  const merged = mergeRequestedImagery(
    extractRequestedImagery(`${IDEA} ${userConversationText(typed)}`),
    extractAgreedSuggestionImagery(typed),
  );
  assert.ok(merged.some((m) => m.phrase.toLowerCase().includes('happy family')), 'her typed background is present');
});

// ─── 4. IT NEVER BLOCKS A RENDER ────────────────────────────────────────────
test('no acceptance / an ambiguous acceptance falls through to today\'s behaviour — no gate, no throw', () => {
  for (const conversation of [
    [] as Array<{ role: string; content: string }>,
    [{ role: 'user', content: 'make me a bakery video' }],
    [{ role: 'user', content: 'make me a bakery video' }, { role: 'assistant', content: SUGGESTION }],
    [{ role: 'user', content: 'hmm' }, { role: 'assistant', content: SUGGESTION }, { role: 'user', content: 'hmm, maybe' }],
  ]) {
    assert.deepEqual(extractAgreedSuggestionImagery(conversation as any), []);
  }
  const { planned } = runLivePostPlan(CONVERSATION);
  assert.ok(planned.length > 0, 'the render always continues');
});

// ─── 5. WIRING PIN: the fixture above must match what production runs ───────
test('createProject merges the agreed suggestion into requestedImagery before the planner section and the carry-through', () => {
  const agreedAt = SERVICE_SRC.indexOf('extractAgreedSuggestionImagery(input.conversation)');
  const mergeAt = SERVICE_SRC.indexOf('mergeRequestedImagery(');
  const sectionAt = SERVICE_SRC.indexOf('buildPlannerImagerySection(requestedImagery)');
  const stripAt = SERVICE_SRC.indexOf('const f4Visual = f4Voice');
  const passAt = SERVICE_SRC.indexOf('applyRequestedImagery(planned, requestedImagery)');
  assert.ok(agreedAt > 0, 'createProject must read the accepted suggestion');
  assert.ok(mergeAt > 0 && mergeAt < agreedAt, 'it must be merged into the imagery list, not used beside it');
  assert.ok(sectionAt > agreedAt, 'the planner must be told about it');
  assert.ok(stripAt > 0 && passAt > stripAt, 'and it must still be carried AFTER the F4 strip, which would scrub it back out');
});
