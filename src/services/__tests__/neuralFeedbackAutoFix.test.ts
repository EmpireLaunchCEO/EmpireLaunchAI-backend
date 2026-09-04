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
import { classifyFeedback, parseLineChange, matchLineToScene, r2KeyFromUrl } from '../neuralFeedbackClassifier.js';

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

// ── LINE_CHANGE intent (Phase 1, task 7793564b) ─────────────────────────────
test('classifyFeedback: line_change intent', () => {
  assert.equal(classifyFeedback('change this line to "we save you money"'), 'line_change');
  assert.equal(classifyFeedback('the line about pricing should say "starting at $9"'), 'line_change');
  assert.equal(classifyFeedback('scene 3 line should say "ready to begin?"'), 'line_change');
  assert.equal(classifyFeedback('change the line "call now" to "text us instead"'), 'line_change');
  assert.equal(classifyFeedback('reword the last line'), 'line_change');
  assert.equal(classifyFeedback('fix the script, line 2 says the wrong thing, make it "we ship free"'), 'line_change');
});

test('classifyFeedback: line_change does NOT hijack audio/smoothness', () => {
  // "line" appears, but the complaint is AUDIO (bleed/voice) or SMOOTHNESS — must NOT classify as line_change.
  assert.equal(classifyFeedback('fix the line audio, there is a second voice'), 'audio');
  assert.equal(classifyFeedback('the line audio is too quiet'), 'audio');
  assert.equal(classifyFeedback('the line is choppy / stutters'), 'smoothness');
  assert.equal(classifyFeedback('the line freezes mid-video'), 'smoothness');
});

// ── parseLineChange ─────────────────────────────────────────────────────────
test('parseLineChange: scene number + new text', () => {
  const r = parseLineChange('scene 3 line should say "ready to begin?"');
  assert.equal(r.sceneNumber, 3);
  assert.equal(r.newText, 'ready to begin?');
});

test('parseLineChange: change this line to X', () => {
  const r = parseLineChange('change this line to "we save you money"');
  assert.equal(r.newText, 'we save you money');
});

test('parseLineChange: the line to X / replace with X', () => {
  const r1 = parseLineChange('change the line "call now" to "text us instead"');
  assert.equal(r1.newText, 'text us instead');
  const r2 = parseLineChange('replace the line with "we ship free"');
  assert.equal(r2.newText, 'we ship free');
});

test('parseLineChange: this line: OLD I want NEW (colon form)', () => {
  const r = parseLineChange('this line: "call now" I want "text us instead"');
  assert.equal(r.newText, 'text us instead');
  assert.equal(r.oldText, 'call now');
});

test('parseLineChange: no replacement → empty newText', () => {
  const r = parseLineChange('reword the last line');
  assert.equal(r.newText, undefined);
  assert.equal(r.sceneNumber, undefined);
});

// ── matchLineToScene ────────────────────────────────────────────────────────
const fakeScenes = [
  { sceneNumber: 1, narration: 'Opening: meet the product.' },
  { sceneNumber: 2, narration: 'This is the moment it comes together.' },
  { sceneNumber: 3, narration: 'Ready to take the next step?' },
];

test('matchLineToScene: by explicit scene number', () => {
  const r = matchLineToScene(fakeScenes, { sceneNumber: 2 });
  assert.deepEqual(r, { sceneNumber: 2, narration: 'This is the moment it comes together.' });
});

test('matchLineToScene: by exact narration match', () => {
  const r = matchLineToScene(fakeScenes, { oldText: 'Ready to take the next step?' });
  assert.deepEqual(r, { sceneNumber: 3, narration: 'Ready to take the next step?' });
});

test('matchLineToScene: by normalized contains match', () => {
  const r = matchLineToScene(fakeScenes, { oldText: 'moment it comes together' });
  assert.deepEqual(r, { sceneNumber: 2, narration: 'This is the moment it comes together.' });
});

test('matchLineToScene: no match → null (ask, never guess)', () => {
  const r = matchLineToScene(fakeScenes, { oldText: 'something totally unrelated' });
  assert.equal(r, null);
});

test('matchLineToScene: explicit scene number out of range → null', () => {
  const r = matchLineToScene(fakeScenes, { sceneNumber: 99 });
  assert.equal(r, null);
});

test('r2KeyFromUrl: R2 host extraction', () => {
  const url = 'https://empirelaunchai.abc123.r2.cloudflarestorage.com/user-123/video-projects/final.mp4';
  assert.equal(r2KeyFromUrl(url), 'user-123/video-projects/final.mp4');
});

test('r2KeyFromUrl: R2 path-style signed URL (prod ground truth)', () => {
  // Exact shape stored in prod video_scenes: path-style
  // https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>/<KEY>?X-Amz-...
  const url = 'https://2ac5a2e3cb490826386d96fe89d58ab4.r2.cloudflarestorage.com/empirelaunchai/brands/00000000-0000-0000-0000-000000000000/video-scenes/3df3bfe9-9949-4624-8fc0-df2d65cdf36e.r2-upload?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=dd1d2076d072673c171563d8a8c2e912%2F20260903%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260903T011528Z&X-Amz-Expires=3600&X-Amz-Signature=d6844b661814bae7f04a57d9bea57c043cd2ccca56dd25658262334f53d77da1&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject';
  assert.equal(r2KeyFromUrl(url), 'brands/00000000-0000-0000-0000-000000000000/video-scenes/3df3bfe9-9949-4624-8fc0-df2d65cdf36e.r2-upload');
});

test('r2KeyFromUrl: virtual-host R2 (bucket in hostname, non-hex label)', () => {
  const url = 'https://mybucket.myaccount.r2.cloudflarestorage.com/brands/user-1/video-scenes/abc.mp4';
  assert.equal(r2KeyFromUrl(url), 'brands/user-1/video-scenes/abc.mp4');
});

test('r2KeyFromUrl: custom/public domain (no bucket segment)', () => {
  const url = 'https://media.empirelaunch.ai/user-123/video-projects/final.mp4';
  assert.equal(r2KeyFromUrl(url), 'user-123/video-projects/final.mp4');
});

test('r2KeyFromUrl: null/empty', () => {
  assert.equal(r2KeyFromUrl(null), null);
  assert.equal(r2KeyFromUrl(''), null);
});