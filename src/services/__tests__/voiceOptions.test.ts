/**
 * Defect 2 (owner Faceless test, 2026-09-21) — regression tests:
 * female+serious must resolve to a FEMALE-presenting gpt-audio voice.
 *
 * Root cause: src/services/voiceOptions.ts mapped female + serious → 'ash',
 * which is MALE-presenting (OpenAI describes ash as firm/confident; the owner's
 * recorded MP4 measured median f0 = 131.1 Hz = male range 85–155 Hz). The
 * owner selected a female voice and heard a male voice.
 *
 * Fix: female+serious → 'sage' (calm/steady, clearly female).
 *
 * AUDIT TABLE (2026-09-21) — gpt-audio voice sex per OpenAI's own voice
 * descriptions + measured f0 evidence:
 *
 *   voice     sex       OpenAI description                 bucket use
 *   -------   --------  ---------------------------------  ----------------------------
 *   alloy     neutral   balanced                           (none — reserved)
 *   ash       MALE      firm, confident                    (REMOVED from female.serious)
 *   ballad    female    soft, expressive                   (none)
 *   coral     female    warm, engaging                     (none)
 *   echo      male      assertive, authoritative           male default (auto)
 *   fable     male      British accent, cheerful           male.calm / male.warm
 *   onyx      male      deep, expressive                   male.serious
 *   nova      female    warm, bright                       female.enthusiastic + female default
 *   sage      female    delicate, soft, calm               female.calm / female.serious (FIX)
 *   shimmer   female    animated, energetic                female.warm
 *   verse     male      slightly younger                   male.enthusiastic
 *
 * Every femaleByTone bucket → female voice; every maleByTone bucket → male
 * voice. Pure deterministic — no API calls, no paid renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoice } from '../voiceOptions.js';

const FEMALE_PRESENTING = new Set(['nova', 'sage', 'shimmer', 'ballad', 'coral']);
const MALE_PRESENTING = new Set(['ash', 'echo', 'fable', 'onyx', 'verse', 'alloy']);

test('female + serious resolves to a FEMALE voice (was ash → male)', () => {
  const v = resolveVoice('female', 'serious');
  assert.ok(v !== 'ash', `female+serious must never be 'ash' (male), got '${v}'`);
  assert.ok(FEMALE_PRESENTING.has(v), `expected a female-presenting voice, got '${v}'`);
  assert.equal(v, 'sage');
});

test('ALL femaleByTone buckets resolve to female-presenting voices', () => {
  for (const tone of ['enthusiastic', 'calm', 'serious', 'warm'] as const) {
    const v = resolveVoice('female', tone);
    assert.ok(FEMALE_PRESENTING.has(v), `female+${tone} → '${v}' is NOT female-presenting`);
  }
});

test('ALL maleByTone buckets resolve to male-presenting voices', () => {
  for (const tone of ['enthusiastic', 'calm', 'serious', 'warm'] as const) {
    const v = resolveVoice('male', tone);
    assert.ok(MALE_PRESENTING.has(v), `male+${tone} → '${v}' is NOT male-presenting`);
  }
});

test('auto / undefined tone keeps a clearly sexed default per gender (female nova, male echo)', () => {
  assert.equal(resolveVoice('female', 'auto'), 'nova');
  assert.equal(resolveVoice('male', 'auto'), 'echo');
  assert.equal(resolveVoice('female', undefined), 'nova');
  assert.equal(resolveVoice('male', undefined), 'echo');
});

test('gender defaults never return a voice of the opposite sex', () => {
  assert.notEqual(resolveVoice('female', 'auto'), 'onyx');
  assert.notEqual(resolveVoice('male', 'auto'), 'shimmer');
});