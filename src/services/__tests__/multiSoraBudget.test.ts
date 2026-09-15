/**
 * Unit tests for the SORA ONE-CALL HYBRID (owner directive, live Sep 14):
 * EXACTLY ONE 16s Sora call per Scene/Customize video at EVERY length —
 * soraCallBudget(any duration) === 1. GPT elects WHICH scenes' important-seconds
 * beats deserve motion; everything else renders as gpt-image-2 stills animated
 * with FFmpeg Ken Burns. Worst-case Sora spend ≈ $1.60/video (~$0.40/call era
 * superseded — the 20s multi-call budget is retired; legacy multi-block plans are
 * still TOLERATED at parse time (only the first block's prompt is paired / a
 * coerced single motion scene) so no previously-valid plan is rejected).
 *
 * NO paid renders — all pure/deterministic helpers (budget mapping, plan parsing
 * incl. legacy object coercion + per-block prompt pairing, budget capping of sora
 * scenes, and the shipped planning-QC helpers on one-call plans).
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

test('soraCallBudget is EXACTLY 1 at EVERY duration (one 16s take per Scene video)', () => {
  // Owner Sep 14: one call per video, ALL lengths — supersedes the old 1/2/3 scale.
  assert.equal(soraCallBudget(1), 1);
  assert.equal(soraCallBudget(15), 1);
  assert.equal(soraCallBudget(29), 1);
  assert.equal(soraCallBudget(30), 1);
  assert.equal(soraCallBudget(31), 1);   // was 2
  assert.equal(soraCallBudget(45), 1);
  assert.equal(soraCallBudget(60), 1);   // ~1 min → STILL 1
  assert.equal(soraCallBudget(61), 1);
  assert.equal(soraCallBudget(90), 1);
  assert.equal(soraCallBudget(120), 1);  // 2 min → STILL 1
  assert.equal(soraCallBudget(180), 1);  // 3 min → STILL 1
  assert.equal(soraCallBudget(240), 1);  // never more than one call — $1.60 hard cap
  assert.equal(soraCallBudget(0), 1);
  assert.equal(soraCallBudget(NaN), 1);
  assert.equal(soraCallBudget(30.5), 1);
  assert.equal(soraCallBudget(-5), 1);
});

test('parseScenePlan accepts the soraContent ARRAY form and pairs the ONE budgeted block', () => {
  const scenes = parseScenePlan(multiPlan, 'test subject', 60, 'scene');
  assert.equal(scenes.length, 6);
  const motion = scenes.filter(s => s.visualType === 'motion');
  const stills = scenes.filter(s => s.visualType === 'still');
  assert.equal(motion.length, 1, 'budget is exactly 1 — only the FIRST block becomes motion (the 16s take spans every elected beat)');
  assert.equal(stills.length, 5);
  // Scene #2 (index 1) pairs with soraContent[0]; scene #5 (index 4) is RE-BUDGETED
  // to a still (a 2nd block would mean a 2nd paid call — never allowed now).
  assert.equal(scenes[1].soraBlock, 0);
  assert.ok(scenes[1].visualPrompt.includes('BLOCK-A hero take'), 'block 0 prompt appended to its scene');
  assert.equal(scenes[4].visualType, 'still', 'the extra GPT block is coerced to Ken Burns');
  assert.ok(!scenes[4].visualPrompt.includes('BLOCK-'), 'coerced still carries no block prompt');
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

test('sora scenes beyond the ONE-call budget are coerced to stills (cost cap)', () => {
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
  // 60s → budget 1: GPT typed 3 sora scenes → the FIRST keeps motion, the other 2 are
  // coerced to stills so spend never exceeds ONE 16s call.
  const scenes = parseScenePlan(overBudget, 'test subject', 60, 'scene');
  const motion = scenes.filter(s => s.visualType === 'motion');
  assert.equal(motion.length, 1, 'motion scenes capped at the one-call budget');
  assert.equal(scenes[0].soraBlock, 0);
  assert.ok(scenes[0].visualPrompt.includes('BLOCK-1'));
  assert.equal(scenes[2].visualType, 'still', 'the 2nd GPT sora scene is coerced to still');
  assert.ok(!scenes[2].visualPrompt.includes('BLOCK-2'), 'coerced still carries no block prompt');
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
  assert.equal(motion.length, 1, 'at most the one-call budget');
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

test('planning QC stays green on one-call plans (arc + components + exact budget)', () => {
  const scenes: SceneScript[] = parseScenePlan(multiPlan, 'test subject', 60, 'scene');
  assert.deepEqual(verifyArcCoverage(scenes), { hook: true, about: true, cta: true });
  // A relayed component present in the plan is verified; an absent one is reported.
  assert.deepEqual(verifyComponentsInScript(scenes, ['teal']).missing, ['teal']);
  assert.deepEqual(verifyComponentsInScript(scenes, ['call to action']).missing, []);
  assert.deepEqual(verifyComponentsInScript(scenes, []).missing, []);
  const normalized = normalizePlanTimeBudget(scenes, 60);
  assert.equal(normalized.reduce((a, s) => a + s.duration, 0), 60);
  const motion = normalized.filter(s => s.visualType === 'motion');
  assert.equal(motion.length, 1, 'one-call motion count survives time-budget normalization');
  assert.ok(motion.every(s => s.soraBlock !== undefined), 'every motion scene keeps its block index');
});

test('SORA_MOTION_SECONDS stays the generic UNANSWERED default; ONE-CALL budget retires the old 20s scale', () => {
  assert.equal(SORA_MOTION_SECONDS, '20'); // generic gate default when no target is supplied — every Scene take now supplies needSeconds ≤ 16
  // The budget says HOW MANY calls — exactly 1 at every length (Scene always lands on "16").
  assert.equal(soraCallBudget(120), 1);
  assert.equal(soraCallBudget(180), 1);
});