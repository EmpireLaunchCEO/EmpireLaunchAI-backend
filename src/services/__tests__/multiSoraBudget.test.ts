/**
 * Unit tests for the MULTI-SORA HYBRID (owner directive, live Sep 8): duration-scaled
 * Sora call budget — 30s→1 call, ~1min→2, 2–3min→3, each a 20s max single take,
 * GPT elects WHICH 20-second blocks genuinely need motion; everything else renders
 * as gpt-image-2 stills animated with FFmpeg Ken Burns. At ~$0.40/call this caps
 * worst-case Sora spend at ~$15/month/client.
 *
 * NO paid renders — all pure/deterministic helpers (budget mapping, plan parsing
 * incl. legacy object coercion + per-block prompt pairing, budget capping of sora
 * scenes, and the shipped planning-QC helpers on multi-Sora plans).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  soraCallBudget,
  SORA_MOTION_SECONDS,
} from '../soraVideoService.js';
import {
  parseScenePlan,
  normalizePlanTimeBudget,
  verifyComponentsInScript,
  verifyArcCoverage,
  type SceneScript,
} from '../sceneVideoPipelineService.js';

const multiPlan = {
  soraContent: [
    { duration: 20, prompt: 'BLOCK-A hero take of the key benefit in action, no cuts, fluid motion.' },
    { duration: 20, prompt: 'BLOCK-B payoff take — the final result in motion, closing on the call to action, no cuts.' },
  ],
  scenes: [
    { sceneNumber: 1, duration: 8, type: 'gpt-image', visualPrompt: 'Opening shot of the subject, hook', narration: 'Opening: meet the subject.' },
    { sceneNumber: 2, duration: 20, type: 'sora', visualPrompt: 'Hero moment close-up', narration: 'This is the moment it comes together.' },
    { sceneNumber: 3, duration: 7, type: 'gpt-image', visualPrompt: 'Medium shot continuing the benefit', narration: 'Watch how it keeps delivering.' },
    { sceneNumber: 4, duration: 7, type: 'gpt-image', visualPrompt: 'Wide shot of the transformation', narration: 'The transformation is unmistakable.' },
    { sceneNumber: 5, duration: 8, type: 'sora', visualPrompt: 'Payoff close-up', narration: 'This is the payoff you can get.' },
    { sceneNumber: 6, duration: 10, type: 'gpt-image', visualPrompt: 'Confident closing, call to action', narration: 'Ready to take the next step?' },
  ],
};

test('soraCallBudget maps duration onto the owner 1/2/3 budget', () => {
  // Owner directive: 30s→1 call, 1 min→2 calls, 2 and 3 min→3 calls (20s each).
  assert.equal(soraCallBudget(15), 1);
  assert.equal(soraCallBudget(29), 1);
  assert.equal(soraCallBudget(30), 1);   // ≤30s → 1
  assert.equal(soraCallBudget(31), 2);   // just over 30s → 2
  assert.equal(soraCallBudget(45), 2);
  assert.equal(soraCallBudget(60), 2);   // ~1 min → 2
  assert.equal(soraCallBudget(61), 3);
  assert.equal(soraCallBudget(89), 3);
  assert.equal(soraCallBudget(90), 3);
  assert.equal(soraCallBudget(120), 3);  // 2 min → 3 (cap)
  assert.equal(soraCallBudget(180), 3);  // 3 min → 3 (cap)
  assert.equal(soraCallBudget(240), 3);  // never exceeds 3 calls — cost cap
  assert.equal(soraCallBudget(0), 1);    // degenerate → 1
  assert.equal(soraCallBudget(NaN), 1);  // degenerate → 1
  assert.equal(soraCallBudget(30.5), 2); // ceil of rounded 31/30
  assert.equal(soraCallBudget(-5), 1);   // clamp floor
});

test('parseScenePlan accepts the soraContent ARRAY form and pairs blocks in order', () => {
  const scenes = parseScenePlan(multiPlan, 'test subject', 60, 'scene');
  assert.equal(scenes.length, 6);
  const motion = scenes.filter(s => s.visualType === 'motion');
  const stills = scenes.filter(s => s.visualType === 'still');
  assert.equal(motion.length, 2, 'exactly the 2 budgeted blocks become motion scenes');
  assert.equal(stills.length, 4);
  // Scene #2 (index 1) pairs with soraContent[0]; scene #5 (index 4) with soraContent[1].
  assert.equal(scenes[1].soraBlock, 0);
  assert.ok(scenes[1].visualPrompt.includes('BLOCK-A hero take'), 'block 0 prompt appended to its scene');
  assert.equal(scenes[4].soraBlock, 1);
  assert.ok(scenes[4].visualPrompt.includes('BLOCK-B payoff take'), 'block 1 prompt appended to its scene');
  // Still scenes are NOT augmented with any block prompt.
  assert.ok(!scenes[0].visualPrompt.includes('BLOCK-'));
  assert.ok(!scenes[5].visualPrompt.includes('BLOCK-'));
  // Duration budget: 8+20+7+7+8+10 = 60 exactly.
  const total = scenes.reduce((a, s) => a + s.duration, 0);
  assert.equal(total, 60);
  // The hard time budget survives the whole pipeline (exact sum to target).
  const normalized = normalizePlanTimeBudget(scenes, 60);
  assert.equal(normalized.reduce((a, s) => a + s.duration, 0), 60);
});

test('parseScenePlan tolerates the legacy OBJECT soraContent (coerced to 1 block)', () => {
  const legacy = {
    soraContent: { duration: 20, prompt: 'LEGACY hero take, one continuous cinematic moment.' },
    scenes: [
      { sceneNumber: 1, duration: 8, type: 'gpt-image', visualPrompt: 'Opening shot, hook', narration: 'Opening.' },
      { sceneNumber: 2, duration: 20, type: 'sora', visualPrompt: 'Important block close-up', narration: 'The moment it comes together.' },
      { sceneNumber: 3, duration: 8, type: 'gpt-image', visualPrompt: 'Confident closing, call to action', narration: 'Ready to take the next step?' },
    ],
  };
  const scenes = parseScenePlan(legacy, 'test subject', 30, 'scene');
  assert.equal(scenes.length, 3);
  const motion = scenes.filter(s => s.visualType === 'motion');
  assert.equal(motion.length, 1, 'legacy object form yields exactly one motion scene');
  assert.equal(motion[0].soraBlock, 0);
  assert.ok(motion[0].visualPrompt.includes('LEGACY hero take'));
  // GPT duration drift (36 → target 30) is normalized to an exact 30s sum.
  const normalized = normalizePlanTimeBudget(scenes, 30);
  assert.equal(normalized.reduce((a, s) => a + s.duration, 0), 30);
});

test('sora scenes beyond the duration-scaled budget are coerced to stills (cost cap)', () => {
  const overBudget = {
    soraContent: [
      { duration: 20, prompt: 'BLOCK-1' },
      { duration: 20, prompt: 'BLOCK-2' },
    ],
    scenes: [
      { sceneNumber: 1, duration: 10, type: 'sora', visualPrompt: 'Hero open', narration: 'Open.' },
      { sceneNumber: 2, duration: 10, type: 'gpt-image', visualPrompt: 'About the subject', narration: 'About.' },
      { sceneNumber: 3, duration: 10, type: 'sora', visualPrompt: 'Mid transformation', narration: 'Mid.' },
      { sceneNumber: 4, duration: 10, type: 'gpt-image', visualPrompt: 'Detail shot', narration: 'Detail.' },
      { sceneNumber: 5, duration: 10, type: 'sora', visualPrompt: 'Payoff cta', narration: 'Payoff.' },
      { sceneNumber: 6, duration: 10, type: 'gpt-image', visualPrompt: 'Closing cta', narration: 'CTA.' },
    ],
  };
  // 60s → budget 2, but GPT typed 3 sora scenes → the FIRST 2 keep motion, the 3rd
  // is coerced to a still so spend never exceeds the owner's budget.
  const scenes = parseScenePlan(overBudget, 'test subject', 60, 'scene');
  const motion = scenes.filter(s => s.visualType === 'motion');
  assert.equal(motion.length, 2, 'motion scenes capped at the budget');
  assert.equal(scenes[0].soraBlock, 0);
  assert.ok(scenes[0].visualPrompt.includes('BLOCK-1'));
  assert.equal(scenes[2].soraBlock, 1);
  assert.ok(scenes[2].visualPrompt.includes('BLOCK-2'));
  assert.equal(scenes[4].visualType, 'still', 'the 3rd GPT sora scene is coerced to still');
  assert.ok(!scenes[4].visualPrompt.includes('BLOCK-'), 'coerced still carries no block prompt');
});

test('GPT may elect FEWER sora scenes than the budget (Sora only where motion is needed)', () => {
  const fewer = {
    soraContent: [
      { duration: 20, prompt: 'BLOCK-1' },
      { duration: 20, prompt: 'BLOCK-2' },
    ],
    scenes: [
      { sceneNumber: 1, duration: 20, type: 'gpt-image', visualPrompt: 'Hook intro', narration: 'Hook.' },
      { sceneNumber: 2, duration: 20, type: 'sora', visualPrompt: 'The one true motion beat', narration: 'The payoff.' },
      { sceneNumber: 3, duration: 20, type: 'gpt-image', visualPrompt: 'Call to action closing', narration: 'CTA.' },
    ],
  };
  const scenes = parseScenePlan(fewer, 'test subject', 60, 'scene');
  const motion = scenes.filter(s => s.visualType === 'motion');
  assert.equal(motion.length, 1, 'fewer than budget is allowed');
  assert.equal(motion[0].soraBlock, 0, 'uses the FIRST block prompt');
  assert.ok(motion[0].visualPrompt.includes('BLOCK-1'));
});

test('Faceless mode ignores soraContent entirely (ZERO Sora — owner hard-lock)', () => {
  const scenes = parseScenePlan(multiPlan, 'test subject', 60, 'faceless');
  assert.ok(scenes.length > 0);
  assert.ok(scenes.every(s => s.visualType === 'still'), 'Faceless never keeps motion');
  // Scene-Based normalization still applies (exact sum), defensively.
  const normalized = normalizePlanTimeBudget(scenes, 60);
  assert.equal(normalized.reduce((a, s) => a + s.duration, 0), 60);
});

test('malformed plan (no soraContent) falls back to ≤1 motion scene — never N', () => {
  const malformed = {
    scenes: [
      { sceneNumber: 1, duration: 10, visualType: 'sora', visualPrompt: 'A', narration: 'A' },
      { sceneNumber: 2, duration: 10, visualType: 'sora', visualPrompt: 'B', narration: 'B' },
      { sceneNumber: 3, duration: 10, visualType: 'still', visualPrompt: 'C', narration: 'C' },
    ],
  };
  const scenes = parseScenePlan(malformed, 'test subject', 30, 'scene');
  const motion = scenes.filter(s => s.visualType === 'motion');
  assert.equal(motion.length, 1, 'degraded fallback caps motion to the single most-important block');
  assert.equal(motion[0].soraBlock, 0);
});

test('planning QC stays green on multi-Sora plans (arc + components + exact budget)', () => {
  const scenes: SceneScript[] = parseScenePlan(multiPlan, 'test subject', 60, 'scene');
  assert.deepEqual(verifyArcCoverage(scenes), { hook: true, about: true, cta: true });
  // A relayed component present in the plan is verified; an absent one is reported.
  assert.deepEqual(verifyComponentsInScript(scenes, ['teal']).missing, ['teal']);
  assert.deepEqual(verifyComponentsInScript(scenes, ['call to action']).missing, []);
  assert.deepEqual(verifyComponentsInScript(scenes, []).missing, []);
  const normalized = normalizePlanTimeBudget(scenes, 60);
  assert.equal(normalized.reduce((a, s) => a + s.duration, 0), 60);
  const motion = normalized.filter(s => s.visualType === 'motion');
  assert.equal(motion.length, 2, 'multi-Sora motion count survives time-budget normalization');
  assert.ok(motion.every(s => s.soraBlock !== undefined), 'every motion scene keeps its block index');
});

test('SORA_MOTION_SECONDS policy is unchanged: every motion call is a 20s max single take', () => {
  assert.equal(SORA_MOTION_SECONDS, '20');
  // The budget says HOW MANY calls; the policy constant says HOW LONG each is.
  assert.equal(soraCallBudget(120), 3);
  assert.equal(SORA_MOTION_SECONDS, '20');
});