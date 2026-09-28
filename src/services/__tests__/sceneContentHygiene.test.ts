import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlanSpeakNarration,
  finalCopyFallbackLine,
  parseScenePlan,
} from '../sceneVideoPipelineService.js';

// ─── CONTENT HYGIENE (owner Sep 28): narration is FINISHED COPY ONLY ────────
// The owner's Faceless video narrated the assistant's greeting / plan-speak
// ("Opening — introducing What niche should we dominate?."). These tests lock
// the guard that keeps plan-speak out of GPT-Audio, plus the finished-copy arc
// templates.

test('isPlanSpeakNarration: flags arc-template plan-speak (the owner\u2019s defect)', () => {
  assert.equal(isPlanSpeakNarration('Opening — introducing New AI platform.'), true);
  assert.equal(isPlanSpeakNarration('Getting started: the essentials come into focus.'), true);
  assert.equal(isPlanSpeakNarration('Now it comes together — the transformation key benefit.'), true);
  assert.equal(isPlanSpeakNarration('The payoff: look at the result it delivers.'), true);
  assert.equal(isPlanSpeakNarration('Call to action: ready to take the next step?'), true);
  assert.equal(isPlanSpeakNarration('Step 1 of 3: open the app.'), true);
});

test('isPlanSpeakNarration: flags planner/prompt echoes', () => {
  assert.equal(isPlanSpeakNarration("we'll walk you through the whole process"), true);
  assert.equal(isPlanSpeakNarration('In this video, you will learn'), true);
  assert.equal(isPlanSpeakNarration('Visual prompt: a dark-mode dashboard'), true);
  assert.equal(isPlanSpeakNarration('What niche should we dominate? Describe the vibe.'), true);
  assert.equal(isPlanSpeakNarration("Let's design your video \u2014 one quick detail..."), true);
});

test('isPlanSpeakNarration: leaves real finished-copy narration untouched', () => {
  assert.equal(isPlanSpeakNarration('Say hello to the new editor — it makes everything easier.'), false);
  assert.equal(isPlanSpeakNarration('The essentials come together fast, and it is simpler than it looks.'), false);
  assert.equal(isPlanSpeakNarration('The upload takes two seconds and it is already processing.'), false);
  assert.equal(isPlanSpeakNarration('That\u2019s the result \u2014 real, fast, right in front of you.'), false);
  assert.equal(isPlanSpeakNarration('Ready to try it? Tap the link in bio.'), false);
  // content-bearing copy that merely STARTS with the same word is NOT plan-speak
  assert.equal(isPlanSpeakNarration('Opening with the lavender palette and the red accents all visible.'), false);
  assert.equal(isPlanSpeakNarration(''), false);
  assert.equal(isPlanSpeakNarration(null), false);
});

test('finalCopyFallbackLine: deterministic, varied across seeds', () => {
  const a = finalCopyFallbackLine('scene-A', 0);
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 10);
  // Same seed+beat → same line; different seed can differ.
  assert.equal(finalCopyFallbackLine('scene-A', 0), a);
  const b = finalCopyFallbackLine('scene-B', 0);
  assert.equal(typeof b, 'string');
});

test('parseScenes: plan-speak GPT candidate narration is swapped to the finished arc line', () => {
  const raw = {
    scenes: Array.from({ length: 5 }, (_, i) => ({
      sceneNumber: i + 1,
      duration: 6,
      visualType: 'still',
      narration: i === 0 ? 'Opening — introducing the new app.' : 'Narration ' + (i + 1),
      visualPrompt: `Cinematic visual ${i + 1}`,
    })),
  };
  const plan = parseScenePlan(raw as any, 'a clean brief subject', 30, 'scene');
  assert.equal(plan[0].narration, "Say hello to a clean brief subject — it's about to make things a lot easier.");
  assert.equal(isPlanSpeakNarration(plan[0].narration), false);
});

test('parseScenes: finished GPT copy survives (never replaced by the generic arc line)', () => {
  const raw = {
    scenes: Array.from({ length: 5 }, (_, i) => ({
      sceneNumber: i + 1,
      duration: 6,
      visualType: 'still',
      narration: i === 0 ? 'The upload takes two seconds and it is already processing.' : 'Narration ' + (i + 1),
      visualPrompt: `Cinematic visual ${i + 1}`,
    })),
  };
  const plan = parseScenePlan(raw as any, 'subject', 30, 'scene');
  assert.equal(plan[0].narration, 'The upload takes two seconds and it is already processing.');
});