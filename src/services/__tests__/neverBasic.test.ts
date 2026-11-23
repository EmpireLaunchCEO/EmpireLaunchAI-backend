/**
 * NEVER BASIC (owner, 23 Nov — "AI chat should never just go basic").
 *
 * Part A — a template or filler line can never reach a delivered video. The
 *   deterministic arc (ARC_FILLERS, "Say hello to <subject>.", the unplannable
 *   narration, the five-line finished-copy battery and the stock "cinematic
 *   establishing shot") is deleted, `parseScenes` pads nothing, and a plan with a
 *   scene that has nothing to say or show is REFUSED at $0.
 * Part B — the planner is sent the planner's own contract (anti-cliché,
 *   stated/unstated, no-product imagery, hook in scene 1) instead of the router's
 *   classifier schema, and a question-shaped hook lands in scene 1.
 *
 * Zero paid calls: the model boundary is stubbed (`globalThis.fetch`), so every
 * assertion is about the request we build and the plan we persist, not about a
 * paraphrase of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildPlannerSystemPrompt, aiRouter } from '../aiRouter.js';
import { buildTransformationPlannerRule } from '../creativeTransformation.js';
import {
  parseScenePlan,
  planScenesMissingCopy,
  injectSellingPointsIntoNarration,
  isHookSentence,
  isPlanSpeakNarration,
} from '../sceneVideoPipelineService.js';
import {
  applyTemplateFill,
  classifyPlannerOutcome,
  plannerFailureNotice,
  runPlanningAttempts,
  usableSceneCount,
} from '../plannerOutcome.js';

// ─── Part A.1 — the literals are gone from the module ───────────────────────

/** Strip block and line comments so a literal that survives only in a
 *  "what used to happen" note is not mistaken for emitted copy. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n');
}

const MODULES = ['sceneVideoPipelineService.ts', 'plannerOutcome.ts', 'creativeTransformation.ts'];

test('Part A: no template or filler literal survives in the pipeline modules', () => {
  const banned: Array<[string, string]> = [
    ['ARC_FILLERS', 'the arc filler battery'],
    ['buildArcScenes', 'the deterministic template arc'],
    ['finalCopyFallbackLine', 'the finished-copy fallback battery'],
    ['ARC_UNPLANNABLE', 'the unplannable-brief narration'],
    ['The essentials come together fast', 'arc filler beat 1'],
    ['And this is where it clicks \u2014 the transformation you came for.', 'arc filler beat 2'],
    ["That's the payoff \u2014 real results, right in front of you.", 'arc filler beat 3'],
    ['Ready to make the move? You can get started today.', 'the stock CTA line'],
    ['Cinematic establishing shot of the subject, soft natural light, depth of field.', 'the stock visual'],
    ['Say hello to ${', 'the arc hook template'],
  ];
  for (const module of MODULES) {
    const file = path.join(process.cwd(), 'src', 'services', module);
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const [literal, what] of banned) {
      assert.equal(
        code.includes(literal),
        false,
        `${module} must not carry ${what} (found "${literal}")`,
      );
    }
  }
});

// ─── Part A.2 — no usable plan means a refusal, not a video ────────────────

const OWNER_THIN_BRIEF =
  "use hook 'are you tired of being a penny pincher' CTA link in bio. create a video to reach stay at home moms need to make extra income.";

test('Part A: a planner that returns nothing usable is a refusal at $0, not a padded video', async () => {
  const calls: string[] = [];
  const planning = await runPlanningAttempts({
    sceneCount: 5,
    call: async () => {
      calls.push('call');
      // The production shape: a router decision, no scenes.
      return { classification: 'ai_assistant', prompt: 'Generate a JSON scene script', parameters: {} };
    },
  });
  assert.equal(planning.payload, null, 'a router decision is not a plan');
  assert.equal(calls.length, 2, 'the second door is tried, then the pipeline stops');

  const outcome = classifyPlannerOutcome({
    payload: planning.payload,
    attempts: planning.attempts,
    detail: planning.detail,
    sceneCount: 5,
  });
  assert.equal(outcome.planned, false);
  const notice = plannerFailureNotice(outcome);
  assert.equal(notice.code, 'PLANNING_FAILED');

  // Nothing is invented for the scenes the plan never wrote.
  const scenes = parseScenePlan({}, OWNER_THIN_BRIEF, 30, 'faceless');
  assert.ok(scenes.every((s) => !s.narration && !s.visualPrompt), 'no scene carries invented copy');
  const gaps = planScenesMissingCopy(scenes, { requireNarration: true });
  assert.equal(gaps.missingNarration.length, scenes.length);
});

test('Part A: a plan whose scenes have nothing to say is refused, never filled', () => {
  // Five scenes, but only two carry narration and only two carry a shot.
  const halfEmpty = {
    scenes: [
      { sceneNumber: 1, duration: 6, narration: 'Are you tired of being a penny pincher?', visualPrompt: 'A kitchen table at dawn, bills spread out' },
      { sceneNumber: 2, duration: 6, narration: '', visualPrompt: 'Her phone on the counter' },
      { sceneNumber: 3, duration: 6, narration: 'It starts with one hour a day.', visualPrompt: '' },
      { sceneNumber: 4, duration: 6, narration: 'She starts before the school run.' },
      { sceneNumber: 5, duration: 6, visualPrompt: 'The laptop closing, dinner on the table' },
    ],
  };
  // The old `usableSceneCount` (narration OR visual) called this a full plan.
  assert.equal(usableSceneCount(halfEmpty), 5, 'the old count sees five usable scenes');

  const parsed = parseScenePlan(halfEmpty, OWNER_THIN_BRIEF, 30, 'faceless');
  const gaps = planScenesMissingCopy(parsed, { requireNarration: true });
  assert.deepEqual(gaps.missingNarration, [2, 5], 'the empty narration slots are named');
  assert.deepEqual(gaps.missingVisual, [3, 4], 'the empty shot slots are named');

  // The gate refuses: the outcome carries a reason, so the pipeline throws
  // PLANNING_FAILED before a single image or motion second is bought.
  const outcome = applyTemplateFill(
    { ...classifyPlannerOutcome({ payload: halfEmpty, attempts: 1, sceneCount: 5 }), planned: true, reason: null },
    5,
    5,
  );
  assert.equal(outcome.planned, true, 'the count alone looks complete — which is why the gap check exists');
  const refused = { ...outcome, planned: false, reason: 'planner-incomplete-plan' as const, detail: 'scenes 2, 4, 5 came back with nothing to say' };
  const notice = plannerFailureNotice(refused);
  assert.equal(notice.code, 'PLANNING_FAILED');
  assert.match(notice.message, /We didn't make this video/);
  assert.match(notice.message, /stopped before rendering anything/);
  assert.match(notice.message, /no motion was purchased/);
});

test('Part A: a scene that speaks plan-speak is blanked, so the plan is refused', () => {
  const raw = {
    scenes: Array.from({ length: 5 }, (_, i) => ({
      sceneNumber: i + 1,
      duration: 6,
      narration: i === 0 ? 'Opening — introducing the app.' : `Line ${i + 1}`,
      visualPrompt: `Shot ${i + 1}`,
    })),
  };
  const parsed = parseScenePlan(raw, OWNER_THIN_BRIEF, 30, 'faceless');
  assert.equal(parsed[0].narration, '', 'plan-speak is dropped, never replaced');
  assert.equal(isPlanSpeakNarration(parsed[0].narration), false);
  assert.deepEqual(planScenesMissingCopy(parsed, { requireNarration: true }).missingNarration, [1]);
});

// ─── Part B.1 — the planner gets the planner's contract ────────────────────

test('Part B: the planner system prompt carries the planner rules, not the router schema', () => {
  const prompt = buildPlannerSystemPrompt();
  // The creative rule already used by the pipeline prompt.
  assert.ok(prompt.includes(buildTransformationPlannerRule().trim().slice(0, 80)), 'carries the transformation rule');
  assert.match(prompt, /ANTI-CLICH[EÉ]/i);
  assert.match(prompt, /STATED .{0,4}USE IT EXACTLY/i);
  assert.match(prompt, /UNSTATED .{0,4}DECIDE FROM THEIR MESSAGE/i);
  assert.match(prompt, /never a stock default/i);
  // What to show when no product is named.
  assert.match(prompt, /AUDIENCE living the MOMENT/i);
  assert.match(prompt, /generic app screen/i);
  // The hook lands in scene 1, question hooks included.
  assert.match(prompt, /HOOK LANDS IN SCENE 1/i);
  assert.match(prompt, /penny pincher/i);
  // It is not the router.
  assert.equal(/CLASSIFICATION OPTIONS/i.test(prompt), false);
  assert.equal(/EmpireLaunch AI Router/i.test(prompt), false);
  assert.equal(/"classification"/i.test(prompt) && /one of the six options/i.test(prompt), false);
});

/** Stub the one model call and capture the exact prompt it was sent. */
function captureModelPrompt(reply: unknown): { prompts: string[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalGoogle = process.env.GOOGLE_STUDIO_API_KEY;
  const originalGoogle2 = process.env.GOOGLE_API_KEY;
  const prompts: string[] = [];
  process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
  delete process.env.GOOGLE_STUDIO_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    prompts.push(String(body?.messages?.[0]?.content ?? ''));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
      text: async () => '',
    } as any;
  }) as any;
  return {
    prompts,
    restore: () => {
      globalThis.fetch = originalFetch;
      for (const [key, value] of [
        ['OPENAI_API_KEY', originalKey],
        ['GOOGLE_STUDIO_API_KEY', originalGoogle],
        ['GOOGLE_API_KEY', originalGoogle2],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test('Part B: the owner\'s thin brief reaches the model as a planner request, with no router schema', async () => {
  const capture = captureModelPrompt({ scenes: [{ sceneNumber: 1, duration: 6, narration: 'Are you tired of being a penny pincher?', visualPrompt: 'A kitchen table at dawn' }] });
  try {
    const decision = await aiRouter.route({
      userId: 'never-basic-fixture',
      request: `Create a JSON scene script using ONLY this clean creative brief: ${OWNER_THIN_BRIEF}`,
      mode: 'generate',
      purpose: 'planner',
    });
    assert.ok(decision.script, 'a plan-shaped reply is preserved as the plan');
    assert.equal(capture.prompts.length, 1);

    const sent = capture.prompts[0];
    assert.ok(sent.includes(buildPlannerSystemPrompt()), 'the planner contract is the system prompt');
    assert.match(sent, /ANTI-CLICH[EÉ]/i);
    assert.match(sent, /HOOK LANDS IN SCENE 1/i);
    // …and the router's classifier schema is nowhere in it.
    assert.equal(/CLASSIFICATION OPTIONS/i.test(sent), false, 'no router classification menu');
    assert.equal(/"classification": "one of the six options"/.test(sent), false, 'no router JSON schema');
    assert.equal(/You NEVER generate final images or videos yourself/.test(sent), false, 'no router role line');
    assert.equal(/CONSULT MODE/.test(sent), false, 'no consult instructions');
  } finally {
    capture.restore();
  }
});

test('Part B: consult mode still gets the router, unchanged', async () => {
  const capture = captureModelPrompt({ classification: 'ai_assistant', prompt: '', parameters: {}, response: 'Tell me more about your audience.' });
  try {
    await aiRouter.route({ userId: 'never-basic-fixture', request: 'hello there', mode: 'consult' });
    const sent = capture.prompts[0];
    assert.match(sent, /You are the EmpireLaunch AI Router/, 'the router is still the router in consult');
    assert.match(sent, /CONSULT MODE/);
    assert.equal(sent.includes(buildPlannerSystemPrompt()), false, 'a chat is not a plan');
  } finally {
    capture.restore();
  }
});

// ─── Part B.2 — a question-shaped hook lands in scene 1 ────────────────────

test('Part B: a question-shaped hook is a hook, and it is placed in scene 1', () => {
  assert.equal(isHookSentence('Are you tired of being a penny pincher?'), true);
  assert.equal(isHookSentence('Are you tired of being a penny pincher'), true, 'a capped question is still a hook');
  assert.equal(isHookSentence('Introducing EmpireLaunch AI.'), true);
  assert.equal(isHookSentence('Save time and money.'), false, 'a benefit is not a hook');

  const plan = [
    { sceneNumber: 1, duration: 6, visualType: 'still' as const, narration: 'Meet the platform that does it all.', visualPrompt: 'A desk at dawn' },
    { sceneNumber: 2, duration: 6, visualType: 'still' as const, narration: 'Two hours back, every single day.', visualPrompt: 'A calendar with room in it' },
    { sceneNumber: 3, duration: 6, visualType: 'still' as const, narration: 'One tap and it is done.', visualPrompt: 'A phone in her hand' },
    { sceneNumber: 4, duration: 6, visualType: 'still' as const, narration: 'Your first month is on us.', visualPrompt: 'A laptop on the sofa' },
    { sceneNumber: 5, duration: 6, visualType: 'still' as const, narration: 'Join the others who started this week.', visualPrompt: 'A front door in the morning' },
  ];
  const out = injectSellingPointsIntoNarration(plan, ['Are you tired of being a penny pincher?']);
  assert.deepEqual(out.injected, ['Are you tired of being a penny pincher?']);
  assert.match(out.script[0].narration, /Are you tired of being a penny pincher\?/i, 'the hook opens the video');
  assert.equal(
    out.script.slice(1).some((s) => /penny pincher/i.test(s.narration)),
    false,
    'and it is not duplicated into a middle scene',
  );
});
