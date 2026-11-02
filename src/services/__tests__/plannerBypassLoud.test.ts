/**
 * PLANNER BYPASS — the loud-failure fixtures (owner Nov 2).
 *
 * The defect these pin down, from production: a video was planned by the
 * deterministic template arc instead of the model, and NOTHING on the project
 * said so. The narration read "Say hello to A 30-second product video for
 * Ember & Oak,." — the raw brief echoed back — while the candle, its scent, its
 * jar and its 50-hour burn never appeared.
 *
 * These fixtures execute the REAL decision graph with the model call stubbed at
 * its boundary (`runPlanningAttempts({ call })` is the same function production
 * runs against `aiRouter.route`), so they prove the pipeline's behaviour rather
 * than a paraphrase of it. Zero paid calls: no image, no narration, no motion,
 * no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTemplateFill,
  classifyPlannerOutcome,
  describeNonPlanResponse,
  planPayloadFromDecision,
  plannerFailureNotice,
  plannerRetryInstruction,
  runPlanningAttempts,
  suppliedScriptPlannerOutcome,
  usableSceneCount,
  PLANNING_FAILED_CODE,
} from '../plannerOutcome.js';
import { parseScenePlan, stripBriefMetaFraming } from '../sceneVideoPipelineService.js';
import { injectMoodIntoVisualPrompts } from '../plannerFidelity.js';

/** The owner's real brief from the failed production render (project 16622f81). */
const EMBER_BRIEF =
  "A 30-second product video for Ember & Oak, a small hand-poured soy candle business. " +
  "The candle is called 'Sunday Morning' — a warm vanilla-and-cedar scent poured into a matte amber glass jar with a kraft paper label. " +
  'The video should feel calm and cinematic: show the candle on a linen-covered table, the wax being hand-poured in a small studio, ' +
  'the wick being lit and the flame catching, the candle glowing on a bedside table at dusk beside an open book, and finally the finished candle wrapped in tissue in its kraft gift box. ' +
  'The selling point is that each candle is hand-poured in small batches with 100% soy wax and a cotton wick, so it burns clean for around fifty hours.';

/**
 * Byte-for-byte the shape production got back on 2026-10-11 (project a02014a3),
 * reconstructed from the Railway logs:
 *   [AiRouter] Raw AI response: { "classification": "ai_assistant",
 *                                 "prompt": "Generate a single JSON scene script …" }
 * `parseDecision` preserves only `script`, so this decision carries NO plan.
 */
const PRODUCTION_ROUTER_DECISION = {
  classification: 'ai_assistant',
  prompt:
    'Generate a single JSON scene script for a 30-second energetic promo video for EmpireLaunch AI, using only the provided creative brief components.',
  parameters: {},
  needsRefinement: false,
};

/** A real plan payload, shaped like the planner contract. */
const REAL_PLAN = {
  scenes: [
    { sceneNumber: 1, duration: 7, visualPrompt: 'The amber jar on a linen table, morning light', narration: 'Sunday Morning, poured by hand in small batches.' },
    { sceneNumber: 2, duration: 6, visualPrompt: 'Wax being poured in the studio', narration: 'One hundred percent soy wax, a cotton wick.' },
    { sceneNumber: 3, duration: 6, visualPrompt: 'The wick catching, flame rising', narration: 'Light it and the vanilla and cedar open up.' },
    { sceneNumber: 4, duration: 6, visualPrompt: 'Glowing on a bedside table at dusk', narration: 'Fifty hours of clean burn, right there.' },
    { sceneNumber: 5, duration: 5, visualPrompt: 'The kraft gift box, tissue paper', narration: 'Sunday Morning — wrapped and ready to give.' },
  ],
};

// ─── 1. The production defect, replayed ─────────────────────────────────────
test('production replay: a router decision is not a plan, and the second door names the real problem', async () => {
  const calls: Array<{ attempt: number; instruction: string }> = [];
  const result = await runPlanningAttempts({
    sceneCount: 5,
    call: async (attempt, instruction) => {
      calls.push({ attempt, instruction });
      return PRODUCTION_ROUTER_DECISION; // both doors answer the wrong schema
    },
  });

  assert.equal(result.payload, null, 'a router decision must never be treated as a plan');
  assert.equal(result.attempts, 2, 'the second door must actually be tried');
  assert.equal(calls.length, 2);
  assert.match(calls[1].instruction, /YOUR PREVIOUS REPLY WAS NOT A PLAN/, 'second door restates the contract');
  assert.match(result.detail, /router decision, not a plan/, 'the recorded detail names the real shape');
  assert.match(result.detail, /classification=ai_assistant/);
});

test('production replay: the bypass is classified as a planner bypass, never as success', () => {
  const outcome = classifyPlannerOutcome({
    payload: null,
    attempts: 2,
    detail: describeNonPlanResponse(PRODUCTION_ROUTER_DECISION),
    sceneCount: 5,
  });

  assert.equal(outcome.planned, false);
  assert.equal(outcome.source, 'template');
  assert.equal(outcome.reason, 'planner-returned-no-plan');
  assert.equal(outcome.templateScenes, 5, 'all five scenes would have been invented');
  assert.equal(outcome.plannerScenes, 0);
  assert.ok(outcome.detail.length > 0, 'the project row must carry the reason');
});

// ─── 2. The second door recovers without spending on media ──────────────────
test('second door: a retry that returns the real plan is accepted and marked planned', async () => {
  let n = 0;
  const result = await runPlanningAttempts({
    sceneCount: 5,
    call: async () => (++n === 1 ? PRODUCTION_ROUTER_DECISION : REAL_PLAN),
  });

  assert.notEqual(result.payload, null);
  assert.equal(result.attempts, 2);
  assert.equal(usableSceneCount(result.payload), 5);

  const outcome = applyTemplateFill(
    classifyPlannerOutcome({ payload: result.payload, attempts: result.attempts, sceneCount: 5 }),
    5,
    5,
  );
  assert.equal(outcome.source, 'planner');
  assert.equal(outcome.planned, true);
  assert.equal(outcome.reason, null);
  assert.equal(outcome.templateScenes, 0);
});

// ─── 3. A call that throws is named, not swallowed ─────────────────────────
test('a planning call that throws becomes planner-call-failed with the provider message', () => {
  const error = new Error('429 rate limited by the planning provider');
  // This mirrors the pipeline's catch block exactly.
  let detail = '';
  try {
    throw error;
  } catch (e: any) {
    detail = `planner call failed: ${e?.message || e}`;
  }
  const outcome = classifyPlannerOutcome({ payload: undefined, attempts: 1, detail, sceneCount: 5 });

  assert.equal(outcome.reason, 'planner-call-failed');
  assert.match(outcome.detail, /429 rate limited/);
  assert.equal(outcome.planned, false);
});

// ─── 4. A short plan is a bypass for the scenes it did not write ────────────
test('incomplete plan: 3 of 5 scenes is a planner bypass, not a silent pad', () => {
  const shortPlan = { scenes: REAL_PLAN.scenes.slice(0, 3) };
  const outcome = applyTemplateFill(
    classifyPlannerOutcome({ payload: shortPlan, attempts: 1, sceneCount: 5 }),
    3,
    5,
  );

  assert.equal(outcome.reason, 'planner-incomplete-plan');
  assert.equal(outcome.plannerScenes, 3);
  assert.equal(outcome.templateScenes, 2);
  assert.equal(outcome.planned, false);
  assert.match(outcome.detail, /3 of 5/);
});

test('a caller-supplied script is recorded as such and is never a planner bypass', () => {
  const supplied = suppliedScriptPlannerOutcome();
  assert.equal(supplied.source, 'supplied-script');
  assert.equal(supplied.reason, null);
  assert.equal(supplied.planned, false);
  const padded = applyTemplateFill(supplied, 3, 5);
  assert.equal(padded.reason, null, 'the owner-dictated path must not start failing');
  assert.equal(padded.templateScenes, 2, 'but the padding is still recorded');
});

// ─── 5. What the client is told ────────────────────────────────────────────
test('the client is told plainly, in the app\'s voice, that no video was made', () => {
  const outcome = classifyPlannerOutcome({
    payload: null,
    attempts: 2,
    detail: describeNonPlanResponse(PRODUCTION_ROUTER_DECISION),
    sceneCount: 5,
  });
  const failure = plannerFailureNotice(outcome);

  assert.equal(failure.code, PLANNING_FAILED_CODE);
  assert.match(failure.message, /We didn't make this video\./);
  assert.match(failure.message, /stopped before rendering anything/);
  assert.match(failure.message, /Your brief is saved/);
  // No internal vocabulary leaks to a paying client.
  for (const word of ['planner', 'model', 'template', 'fallback', 'GPT', 'OpenAI', 'router']) {
    assert.equal(
      new RegExp(`\\b${word}\\b`, 'i').test(failure.message),
      false,
      `client copy must not say "${word}"`,
    );
  }
});

// ─── 6. The template can no longer echo the request ────────────────────────
test('template arc: the request framing is stripped from the subject', () => {
  const stripped = stripBriefMetaFraming(EMBER_BRIEF);
  assert.equal(/30-second product video for/i.test(stripped), false, 'the request framing is gone');
  assert.match(stripped, /^Ember & Oak,/, 'the advertised thing is what is left');
  assert.equal(
    stripBriefMetaFraming('Make me a 30-second product video for Ember & Oak'),
    'Ember & Oak',
  );
});

test('template arc: narration names the product and never recites the brief', () => {
  const scenes = parseScenePlan({}, EMBER_BRIEF, 30, 'scene');

  assert.equal(scenes.length, 5);
  for (const s of scenes) {
    assert.ok(s.narration && s.narration.trim().length > 0, `scene ${s.sceneNumber} must have narration`);
    assert.equal(/product video for/i.test(s.narration), false, `scene ${s.sceneNumber} echoes the request`);
    assert.equal(/30-second/i.test(s.narration), false, `scene ${s.sceneNumber} echoes the duration ask`);
    assert.equal(/product video for/i.test(s.visualPrompt), false, `scene ${s.sceneNumber} prompt echoes the request`);
  }
  assert.match(scenes[0].narration, /Ember & Oak/, 'the product is named in the hook');
  // The client's own words are used where the template has nothing of its own.
  const spoken = scenes.map(s => s.narration).join(' ');
  assert.match(spoken, /Sunday Morning|candle|soy|wick|vanilla/i, 'the brief\'s own content survives');
});

test('template arc: with nothing to work with it refuses instead of inventing', () => {
  const scenes = parseScenePlan({}, '   ', 30, 'scene');
  assert.equal(scenes.length, 5);
  for (const s of scenes) {
    assert.match(
      s.narration,
      /could not be turned into a plan/i,
      'an empty brief must produce an honest refusal, not a confident generic line',
    );
  }
});

// ─── 7. The invented "family" scene ────────────────────────────────────────
test('mood: a tone word alone can no longer invent a family scene', () => {
  const scenes = parseScenePlan({}, EMBER_BRIEF, 30, 'scene');
  const mood = 'calm and cinematic: show the candle on a linen-covered table, the wax being hand-poured in a small studio';
  const out = injectMoodIntoVisualPrompts(scenes as any, mood);

  assert.deepEqual(out.injectedScenes, [], 'a "calm" tone must not inject a payoff story');
  for (const s of out.script) {
    assert.equal(/famil|relaxed|enjoying time/i.test(String(s.visualPrompt)), false, 'nobody mentioned a family');
  }
});

test('mood: the owner\'s stressed-then-relaxing sequence still works when it is actually stated', () => {
  const scenes = parseScenePlan({}, EMBER_BRIEF, 30, 'scene');
  const out = injectMoodIntoVisualPrompts(
    scenes as any,
    'someone stressed and overworked at a desk, then relaxing with family',
  );
  assert.ok(out.injectedScenes.length > 0, 'a stated before/after story still lands');
  assert.match(String(out.script[0].visualPrompt), /stressed and overworked/i);
  assert.match(String(out.script[out.script.length - 1].visualPrompt), /relaxed and enjoying time with family/i);
});

// ─── 8. Guards on the primitives ───────────────────────────────────────────
test('planPayloadFromDecision accepts the three real shapes and rejects everything else', () => {
  assert.equal(planPayloadFromDecision({ script: REAL_PLAN }), REAL_PLAN);
  assert.equal(planPayloadFromDecision({ parameters: { script: REAL_PLAN } }), REAL_PLAN);
  assert.deepEqual(planPayloadFromDecision({ scenes: REAL_PLAN.scenes }).scenes.length, 5);
  assert.equal(planPayloadFromDecision({ script: { scenes: [] } }), null, 'an empty plan is no plan');
  assert.equal(planPayloadFromDecision(PRODUCTION_ROUTER_DECISION), null);
  assert.equal(planPayloadFromDecision(null), null);
  assert.equal(planPayloadFromDecision(undefined), null);
  assert.equal(planPayloadFromDecision('a prose answer'), null);
});

test('retry instruction asks for the plan and nothing else', () => {
  const text = plannerRetryInstruction(5);
  assert.match(text, /exactly 5 objects/);
  assert.match(text, /No "classification"/);
  assert.match(text, /nothing else/);
});
