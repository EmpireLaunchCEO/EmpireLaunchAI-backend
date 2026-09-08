/**
 * Unit tests for the NO-VOICEOVER mode (voice:'none') decision + the always-20s
 * Sora single-take policy. NO paid renders, NO Sora/audio mocks needed — these
 * are the pure deterministic helpers the pipeline calls.
 *
 * Context: owner directive (live) — before she creates new Scene-Based videos the
 * pipeline must (a) request the Sora 2 20s MAX on every motion scene (continuous
 * single takes, no loop-padded repetition) and (b) support a real no-voiceover
 * mode so the Aug 30-style GPT-Audio narration NEVER plays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SORA_MOTION_SECONDS } from '../soraVideoService.js';
import { shouldGenerateSceneNarration } from '../sceneVideoPipelineService.js';

test('shouldGenerateSceneNarration: voice "none" skips narration entirely', () => {
  // Owner directive: 'none' means no GPT-Audio call and no audioUrl on the scene —
  // the final MP4 is silent by design (0 audio streams is OK for QC).
  assert.equal(shouldGenerateSceneNarration('Welcome to my shop', 'none'), false);
  assert.equal(shouldGenerateSceneNarration('A hero moment of this product', 'none'), false);
  assert.equal(shouldGenerateSceneNarration('Any text at all', 'none'), false);
});

test('shouldGenerateSceneNarration: real voices generate narration', () => {
  assert.equal(shouldGenerateSceneNarration('Welcome to my shop', 'female'), true);
  assert.equal(shouldGenerateSceneNarration('Welcome to my shop', 'male'), true);
  assert.equal(shouldGenerateSceneNarration('Welcome to my shop', undefined), true);
  assert.equal(shouldGenerateSceneNarration('Welcome to my shop', ''), true);
});

test('shouldGenerateSceneNarration: no narration text never generates audio', () => {
  assert.equal(shouldGenerateSceneNarration(undefined, 'female'), false);
  assert.equal(shouldGenerateSceneNarration(null, 'male'), false);
  assert.equal(shouldGenerateSceneNarration('', 'female'), false);
  assert.equal(shouldGenerateSceneNarration(undefined, 'none'), false);
});

test('SORA_MOTION_SECONDS is the 20s max single-take policy for every motion scene', () => {
  // The pipeline sends this constant on EVERY Sora motion call, regardless of the
  // scene's target duration; renderClip `-t` trims the 20s take to the scene window.
  assert.equal(SORA_MOTION_SECONDS, '20');
  assert.ok(['4', '8', '12', '16', '20'].includes(SORA_MOTION_SECONDS));
});