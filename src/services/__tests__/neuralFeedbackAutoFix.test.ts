/**
 * Unit tests for the Neural Feedback → auto-fix classifier + R2 key extraction.
 * NO paid renders, NO Sora, NO DB/network — pure deterministic functions.
 *
 * Context: owner direction — feedback like "fix the audio" on an Operations video
 * should trigger a deterministic cleanup re-mix from STORED components (~$0),
 * never auto-spend Sora. These tests pin the cheap classifier + key extractor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFeedback, r2KeyFromUrl } from '../neuralFeedbackClassifier.js';

test('classifyFeedback: audio intent', () => {
  assert.equal(classifyFeedback('fix the audio'), 'audio');
  assert.equal(classifyFeedback('there is a second voice / background voice bleed'), 'audio');
  assert.equal(classifyFeedback('the narration is too quiet, turn it up'), 'audio');
  assert.equal(classifyFeedback('voiceover'), 'audio');
});

test('classifyFeedback: smoothness intent', () => {
  assert.equal(classifyFeedback('the video is choppy'), 'smoothness');
  assert.equal(classifyFeedback('judder / stutter near the transitions'), 'smoothness');
  assert.equal(classifyFeedback('make it smoother, frame rate issues'), 'smoothness');
  assert.equal(classifyFeedback('it freezes mid-video'), 'smoothness');
});

test('classifyFeedback: note-only', () => {
  assert.equal(classifyFeedback('the colors look off, use warmer tones'), 'none');
  assert.equal(classifyFeedback('add more scenes please'), 'none');
  assert.equal(classifyFeedback(''), 'none');
});

test('r2KeyFromUrl: R2 host extraction', () => {
  const url = 'https://empirelaunchai.abc123.r2.cloudflarestorage.com/user-123/video-projects/final.mp4';
  assert.equal(r2KeyFromUrl(url), 'user-123/video-projects/final.mp4');
});

test('r2KeyFromUrl: custom/public domain (no bucket segment)', () => {
  const url = 'https://media.empirelaunch.ai/user-123/video-projects/final.mp4';
  assert.equal(r2KeyFromUrl(url), 'user-123/video-projects/final.mp4');
});

test('r2KeyFromUrl: null/empty', () => {
  assert.equal(r2KeyFromUrl(null), null);
  assert.equal(r2KeyFromUrl(''), null);
});