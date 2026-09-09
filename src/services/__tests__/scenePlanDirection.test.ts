import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNarrationRoles,
  looksLikeFirstPersonDialogue,
  extractAvatarLook,
  enforceAvatarConsistency,
  verifyActionDirection,
  applyActionBackstop,
  buildPlannerActionSection,
  buildPlannerAvatarSection,
  buildReplanFeedback,
  parseScenePlan,
  shouldGenerateSceneNarration,
} from '../sceneVideoPipelineService.js';

type S = Parameters<typeof resolveNarrationRoles>[0][number];
const scene = (over: Partial<S>): S => ({ sceneNumber: 1, duration: 6, visualType: 'still', narration: '', visualPrompt: '', ...over });

// ─── AVATAR-VOICE RULE v3 (owner final wording): narration is suppressed ONLY for
// ─── a TALKING avatar (lips moving); static avatar / no avatar keeps narrator. ───
test('resolveNarrationRoles: explicit GPT role wins', () => {
  const out = resolveNarrationRoles([scene({ narrationRole: 'avatar-dialogue' }), scene({ narrationRole: 'narrator' })]);
  assert.equal(out[0].narrationRole, 'avatar-dialogue');
  assert.equal(out[1].narrationRole, 'narrator');
});
test('resolveNarrationRoles: talking avatar (speaking to camera) → avatar-dialogue', () => {
  const out = resolveNarrationRoles([scene({ visualPrompt: 'Animated host talking to the camera while the app UI follows her taps', narration: "I'm going to show you the exact steps" })]);
  assert.equal(out[0].narrationRole, 'avatar-dialogue');
});
test('resolveNarrationRoles: STATIC avatar (photo, not speaking) → narrator (v3 — do NOT suppress)', () => {
  const out = resolveNarrationRoles([scene({ visualPrompt: 'Static portrait photo of the host beside the product' }), scene({ visualPrompt: 'The host sits still behind the desk, not speaking' })]);
  assert.equal(out[0].narrationRole, 'narrator');
  assert.equal(out[1].narrationRole, 'narrator');
});
test('resolveNarrationRoles: no avatar → narrator (Faceless status quo)', () => {
  const out = resolveNarrationRoles([scene({ visualPrompt: 'Close-up on the app home screen, finger tapping upload' })]);
  assert.equal(out[0].narrationRole, 'narrator');
});
test('resolveNarrationRoles: mixed video — talking avatar scene + narrator scenes', () => {
  const out = resolveNarrationRoles([
    scene({ sceneNumber: 1, visualPrompt: 'App screen recording, upload progress' }),
    scene({ sceneNumber: 2, visualPrompt: 'Host speaking directly to camera while demonstrating', narration: 'Watch how I do this.' }),
    scene({ sceneNumber: 3, visualPrompt: 'Before/after result split' }),
  ]);
  assert.deepEqual(out.map(s => s.narrationRole), ['narrator', 'avatar-dialogue', 'narrator']);
});
test('looksLikeFirstPersonDialogue: avatar words vs third-person narrator', () => {
  assert.equal(looksLikeFirstPersonDialogue("I'm going to show you the exact steps I use."), true);
  assert.equal(looksLikeFirstPersonDialogue('We just launched the new dashboard.'), true);
  assert.equal(looksLikeFirstPersonDialogue('This video explains the product features in three easy steps.'), false);
  assert.equal(looksLikeFirstPersonDialogue(''), false);
});
// ─── SAME avatar consistency ─────────────────────────────────────────────────
test('extractAvatarLook: reads top-level avatarLook / avatar_look', () => {
  assert.equal(extractAvatarLook({ avatarLook: 'the same teal-haired host' }), 'the same teal-haired host');
  assert.equal(extractAvatarLook({ avatar_look: 'host A' }), 'host A');
  assert.equal(extractAvatarLook({}), '');
  assert.equal(extractAvatarLook(null), '');
});
test('enforceAvatarConsistency: injects the shared look into every avatar scene', () => {
  const out = enforceAvatarConsistency([
    scene({ sceneNumber: 1, narrationRole: 'avatar-dialogue', visualPrompt: 'Host on camera' }),
    scene({ sceneNumber: 2, narrationRole: 'avatar-dialogue', visualPrompt: 'Host continues the demo' }),
    scene({ sceneNumber: 3, narrationRole: 'narrator', visualPrompt: 'App screen recording' }),
  ], 'Maya, a friendly host with teal hair');
  assert.match(out.script[0].visualPrompt, /Maya, a friendly host with teal hair/);
  assert.match(out.script[1].visualPrompt, /Maya, a friendly host with teal hair/);
  assert.doesNotMatch(out.script[2].visualPrompt, /Maya/); // narrator scene untouched
  assert.equal(out.avatarLook, 'Maya, a friendly host with teal hair');
});
test('enforceAvatarConsistency: no avatar scenes → no-op, empty look', () => {
  const out = enforceAvatarConsistency([scene({ sceneNumber: 1, narrationRole: 'narrator' })], '');
  assert.deepEqual(out, { script: [scene({ sceneNumber: 1, narrationRole: 'narrator' })], avatarLook: '' });
});
test('enforceAvatarConsistency: missing avatarLook derives from the first avatar scene (deterministic)', () => {
  const out = enforceAvatarConsistency([
    scene({ sceneNumber: 1, narrationRole: 'avatar-dialogue', visualPrompt: 'Same teal-haired host at her desk' }),
    scene({ sceneNumber: 2, narrationRole: 'avatar-dialogue', visualPrompt: 'Host taps the screen' }),
  ], '');
  assert.match(out.script[1].visualPrompt, /Same teal-haired host at her desk/);
  assert.ok(out.avatarLook.length > 0);
});
// ─── ACTIONS NOT THOUGHTS ────────────────────────────────────────────────────
test('verifyActionDirection: concrete action/evidence visuals pass; abstract fail', () => {
  const { visualAbstract } = verifyActionDirection([
    scene({ sceneNumber: 1, visualPrompt: 'Close-up on the app home screen, finger tapping the upload button' }),
    scene({ sceneNumber: 2, visualPrompt: 'Before/after result showing the transformation' }),
    scene({ sceneNumber: 3, visualPrompt: 'A conceptual pitch about simplifying workflows' }),
  ]);
  assert.deepEqual(visualAbstract, [3]);
});
test('verifyActionDirection: narration with concrete steps passes; abstract fails', () => {
  const { narrationAbstract } = verifyActionDirection([
    scene({ sceneNumber: 1, narration: 'Tap here, upload your design, and the result appears in seconds.' }),
    scene({ sceneNumber: 2, narration: 'It is about helping you work in a more efficient way with less effort over time.' }),
  ]);
  assert.deepEqual(narrationAbstract, [2]);
});
test('applyActionBackstop: appends deterministic SHOW-THIS-BEING-DONE to abstract visuals only', () => {
  const { script, injectedInto } = applyActionBackstop([
    scene({ sceneNumber: 1, visualPrompt: 'A conceptual pitch about simplifying workflows' }),
    scene({ sceneNumber: 2, visualPrompt: 'Dashboard showing the growth chart, cursor clicking export' }),
  ]);
  assert.match(script[0].visualPrompt, /SHOW THIS BEING DONE/);
  assert.doesNotMatch(script[1].visualPrompt, /SHOW THIS BEING DONE/);
  assert.deepEqual(injectedInto, [1]);
});
// ─── planner prompt sections carry the rules ─────────────────────────────────
test('buildPlannerActionSection / AvatarSection carry the owner rules verbatim', () => {
  assert.match(buildPlannerActionSection(), /ACTIONS NOT THOUGHTS/);
  assert.match(buildPlannerActionSection(), /DEMONSTRATE DOING/);
  assert.match(buildPlannerAvatarSection(), /lips moving/i);
  assert.match(buildPlannerAvatarSection(), /avatar-dialogue/);
  assert.match(buildPlannerAvatarSection(), /narrator/);
});
test('buildReplanFeedback: includes avatar-role + abstract-narration feedback when extras present', () => {
  const fb = buildReplanFeedback([], { hook: true, about: true, cta: true }, { avatarRoleViolations: [2], narrationAbstract: [3] });
  assert.match(fb, /AVATAR-VOICE RULE VIOLATION/);
  assert.match(fb, /scene\(s\) 2/);
  assert.match(fb, /NARRATION TOO ABSTRACT/);
  assert.match(fb, /scene\(s\) 3/);
  assert.equal(buildReplanFeedback([], { hook: true, about: true, cta: true }), '');
});
// ─── parser keeps narrationRole through both shapes ──────────────────────────
test('parseScenePlan: hybrid carries narrationRole + avatar fields shape', () => {
  const raw = {
    avatarLook: 'same host',
    soraContent: [{ duration: 20, prompt: 'one continuous take' }],
    scenes: [
      { sceneNumber: 1, duration: 10, type: 'gpt-image', visualPrompt: 'App screen', narration: 'Step one.', narrationRole: 'narrator' },
      { sceneNumber: 2, duration: 20, type: 'sora', visualPrompt: 'Host speaks', narration: 'I will show you.', narrationRole: 'avatar-dialogue' },
    ],
  };
  const out = parseScenePlan(raw, 'idea', 30, 'scene');
  assert.equal(out[0].narrationRole, 'narrator');
  assert.equal(out[1].narrationRole, 'avatar-dialogue');
  // duration budget exact
  assert.equal(out.reduce((a, s) => a + s.duration, 0), 30);
});
test('parseScenePlan: legacy scene shape also carries narrationRole', () => {
  const raw = { scenes: [
    { sceneNumber: 1, duration: 6, visualType: 'still', visualPrompt: 'App ui', narration: 'How to.', narrationRole: 'avatar-dialogue' },
  ] };
  const out = parseScenePlan(raw, 'idea', 30, 'faceless');
  assert.equal(out.length, 5); // padded to sceneCount for 30s
  assert.equal(out[0].narrationRole, 'avatar-dialogue');
  // Faceless hard-lock intact
  assert.ok(out.every(s => s.visualType === 'still'));
});
// ─── silent mode untouched ───────────────────────────────────────────────────
test('voice:none still suppresses narration (silent mode untouched)', () => {
  assert.equal(shouldGenerateSceneNarration('Step one.', 'none'), false);
  assert.equal(shouldGenerateSceneNarration('Step one.', 'female'), true);
  assert.equal(shouldGenerateSceneNarration('', 'female'), false);
});