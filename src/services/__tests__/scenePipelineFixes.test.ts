/**
 * Unit tests for the BLOCKER-FIX pass on the owner's live Scene-Based test
 * (project f3773f0a — all 5 scenes failed with ENOENT + plan elected zero Sora
 * + relayed components never flowed into the stored plan):
 *
 *   (a) URL-vs-local handling for still uploads — ensureLocalFile turns an R2
 *       presigned URL into a REAL local file (fs.copyFileSync on a URL = ENOENT,
 *       the owner's live failure) and passes local paths through untouched.
 *   (b) SCENE MOTION FLOOR — a parsed plan with zero sora scenes gets ≥1 motion
 *       scene with soraBlock=0; the over-budget cap is preserved; plans that
 *       already carry motion are untouched; Faceless never calls this.
 *   (c) COMPONENT INJECTION — relayed components that survive neither GPT's plan
 *       nor the one replan still flow VERBATIM into the final scene prompts
 *       (CTA → final scene, colors/platforms/offers → middle, chunks → hook).
 *   (d) parse-layer TRUNCATION (not discard) of long component-bearing copy.
 *   (e) consultGenerateReply — actionHint-driven closing line (suppressWand).
 *
 * NO paid renders, NO mocks of upstream providers — all pure deterministic
 * helpers, so this respects the paid-render QA policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  isRemoteUrl,
  ensureLocalFile,
  parseScenePlan,
  applySceneMotionFloor,
  verifyComponentsInScript,
  injectMissingComponents,
  type SceneScript,
} from '../sceneVideoPipelineService.js';
import { consultGenerateReply } from '../aiRouter.js';

const still = (n: number, visualPrompt: string, narration = '', duration = 6): SceneScript => ({
  sceneNumber: n, duration, visualType: 'still', visualPrompt, narration,
});
const SIX_STILLS = (): SceneScript[] => Array.from({ length: 6 }, (_, i) =>
  still(i + 1, `Cinematic scene ${i + 1} of the subject`, `Narration ${i + 1} about the subject.`),
);

// ─── (a) URL-vs-local handling for still upload ─────────────────────────────
test('isRemoteUrl: http(s) URLs are remote, local paths are not', () => {
  assert.equal(isRemoteUrl('https://2ac5a2e3c.r2.cloudflarestorage.com/empirelaunchai/a.png?X-Amz-Signature=x'), true);
  assert.equal(isRemoteUrl('http://localhost:3001/x.png'), true);
  assert.equal(isRemoteUrl('/tmp/temp/scene_00.png'), false);
  assert.equal(isRemoteUrl('C:\\temp\\scene_00.png'), false);
  assert.equal(isRemoteUrl(''), false);
});

test('ensureLocalFile: a LOCAL path passes through untouched (same file, no download)', async () => {
  const tmp = path.join(os.tmpdir(), `scene-fix-local-${Date.now()}.png`);
  fs.writeFileSync(tmp, Buffer.from('fixture'));
  const out = await ensureLocalFile(tmp, 'still image', async () => { throw new Error('must not fetch'); });
  assert.equal(out, tmp);
  fs.rmSync(tmp, { force: true });
});

test('ensureLocalFile: an R2 presigned URL is downloaded to a real local file (the ENOENT fix)', async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const fakeFetch = async (_url: string) => ({
    ok: true,
    status: 200,
    // Exact byte range of the fixture (Buffer pool backing stores may be larger).
    arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.length) as ArrayBuffer,
  });
  const url = 'https://2ac5a2e3c.r2.cloudflarestorage.com/empirelaunchai/brands/00000000-0000/renders/images/7e5015d6.png?X-Amz-Expires=3600&X-Amz-Signature=abc';
  const local = await ensureLocalFile(url, 'still image scene 1', fakeFetch as any);
  // Real file on disk with the downloaded bytes; .png extension from the URL path.
  assert.ok(local.startsWith(path.join(process.cwd(), 'temp', 'scene-assets')), `returns temp path, got ${local}`);
  assert.ok(local.endsWith('.png'), 'keeps the remote extension');
  assert.deepEqual(fs.readFileSync(local), pngBytes);
  fs.rmSync(local, { force: true });
});

test('ensureLocalFile: a failed download throws a clear error (never a silent ENOENT)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    ensureLocalFile('https://x.r2.cloudflarestorage.com/bucket/key.png', 'still image', fakeFetch as any),
    /download failed \(HTTP 403\)/,
  );
});

// ─── (b) SCENE MOTION FLOOR → SPAN ────────────────────────────────────────────
test('applySceneMotionFloor: zero-sora plan promotes a CONTIGUOUS SPAN of short scenes sharing soraBlock=0', () => {
  const plan = SIX_STILLS(); // 6 × 6s
  const out = applySceneMotionFloor(plan, ['One continuous 20s cinematic take of the hero key-benefit moment, no cuts'], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  // hero-overlap = scene 1 (keyword tie), forward run 1,2,3 = 18s ≤ 20 → K=3
  assert.equal(motions.length, 3, 'promotes a SPAN of short scenes, not a lone scene');
  assert.deepEqual(motions.map(s => s.sceneNumber), [1, 2, 3], 'contiguous run starting at the hero beat');
  assert.ok(motions.every(s => s.soraBlock === 0), 'every span scene shares soraBlock 0 (ONE Sora call)');
  assert.equal(motions.reduce((a, s) => a + s.duration, 0), 18, 'span sum ≤ one 20s take');
  assert.ok(motions[0].visualPrompt.toLowerCase().includes('hero'), 'lead scene carries the block prompt');
  // one take covers the run: every span scene pairs with the SAME soraBlock
  assert.equal(new Set(motions.map(s => s.soraBlock)).size, 1);
  // durations untouched (time budget preserved)
  assert.deepEqual(out.map(s => s.duration), plan.map(s => s.duration));
  // everything else stays still
  assert.equal(out.filter(s => s.visualType === 'still').length, plan.length - 3);
});

test('applySceneMotionFloor: respects the budget cap and leaves existing motion untouched', () => {
  const withMotion = SIX_STILLS().map((s, i) => (i === 2 ? { ...s, visualType: 'motion' as const, soraBlock: 0 } : s));
  const out = applySceneMotionFloor(withMotion, ['some block'], 1);
  assert.equal(out.filter(s => s.visualType === 'motion').length, 1, 'never adds beyond the cap');
  assert.equal(out[2].soraBlock, 0);
});

test('applySceneMotionFloor: budget 0 / empty plan are no-ops (Faceless-style zero-Sora safety)', () => {
  const plan = SIX_STILLS();
  const out = applySceneMotionFloor(plan, ['any block'], 0);
  assert.equal(out.filter(s => s.visualType === 'motion').length, 0, 'budget 0 → no motion added');
  assert.equal(applySceneMotionFloor([], ['any'], 1).length, 0);
});

test('applySceneMotionFloor: no soraContent block → deterministic MIDDLE scene starts the span', () => {
  const plan = SIX_STILLS();
  const out = applySceneMotionFloor(plan, [], 1);
  const motions = out.filter(s => s.visualType === 'motion');
  assert.equal(motions[0].sceneNumber, Math.floor(6 / 2) + 1, 'middle scene is the hero fallback');
  assert.deepEqual(motions.map(s => s.sceneNumber), [4, 5, 6], 'contiguous forward span from the middle beat');
  assert.equal(motions.length, 3);
  assert.ok(motions.every(s => s.soraBlock === 0));
});

test('applySceneMotionFloor: promoted scene pairs with soraContent[0] (block prompt appended)', () => {
  const plan = SIX_STILLS();
  const block = 'One continuous 20s take of the lavender payoff moment';
  const out = applySceneMotionFloor(plan, [block], 1);
  const motion = out.find(s => s.visualType === 'motion')!;
  assert.ok(motion.visualPrompt.includes(block), 'block prompt appended to the motion scene prompt');
});

// ─── (c) COMPONENT INJECTION ────────────────────────────────────────────────
test('injectMissingComponents: every relayed component flows verbatim into the final plan', () => {
  // The owner\'s live project: generic 5-scene plan (exact prod shape) + relayed inventory.
  const generic = [
    still(1, 'Cinematic establishing shot: hook intro of the subject', 'Opening — introducing the subject.'),
    still(2, 'Cinematic medium shot: setting up the fundamentals', 'Getting started: the essentials come into focus.'),
    still(3, 'Cinematic wide shot: the transformation in progress', 'Now it comes together — the key benefit in action.'),
    still(4, 'Cinematic close-up: the payoff result', 'The payoff: look at the result it delivers.'),
    still(5, 'Cinematic closing shot: confident ending', 'Call to action: ready to take the next step?'),
  ];
  const inventory = ['My new platform brings content creation', 'red', 'TikTok', 'lavender', '50% off', 'Comment'];
  const before = verifyComponentsInScript(generic, inventory);
  assert.equal(before.missing.length, inventory.length, 'fixture: generic plan carries NONE of the components');

  const { script: out, injected, stillMissing } = injectMissingComponents(generic, inventory);
  assert.equal(stillMissing.length, 0, 'deterministically no still-missing components');
  assert.equal(injected.length, inventory.length);
  assert.equal(verifyComponentsInScript(out, inventory).missing.length, 0, 'verifyComponentsInScript passes after injection');

  // CTA wording lands on the FINAL scene; color/platform/offer on the middle scene;
  // the subject chunk on the hook (scene 1).
  assert.ok(out[4].visualPrompt.includes('Comment'), 'CTA on final scene');
  assert.ok(out[2].visualPrompt.toLowerCase().includes('tiktok') || out[2].visualPrompt.includes('TikTok'), 'platform on middle scene');
  assert.ok(out[0].visualPrompt.includes('My new platform brings content creation'), 'subject chunk on hook (scene 1)');
  // Durations untouched — exact time budget holds.
  assert.deepEqual(out.map(s => s.duration), generic.map(s => s.duration));
});

test('injectMissingComponents: already-complete plans are untouched (no phantom injection)', () => {
  const complete = SIX_STILLS().map(s => (s.sceneNumber === 5 ? { ...s, visualPrompt: `${s.visualPrompt} — Comment and follow @acme` } : s));
  const { script: out, injected, stillMissing } = injectMissingComponents(complete, ['Comment']);
  assert.equal(injected.length, 0);
  assert.equal(stillMissing.length, 0);
  assert.deepEqual(out, complete);
});

test('injectMissingComponents + motion floor work together (owner path: parse → floor → inject)', () => {
  // Reconstruct the owner flow: GPT returns NO sora-typed scenes (hybrid gate off →
  // generic fallback), motion floor promotes the middle beat, injection adds the
  // components. The delivered plan must have motion AND all components.
  const raw = { scenes: Array.from({ length: 5 }, (_, i) => ({ sceneNumber: i + 1, duration: 6, type: 'gpt-image', visualPrompt: `Generic visual ${i + 1}`, narration: `Generic narration ${i + 1}` })) };
  const parsed = parseScenePlan(raw, 'Still using multiple apps just to create one video?', 30, 'scene');
  const floored = applySceneMotionFloor(parsed, ['one continuous take of the hero payoff'], 1);
  const inventory = ['red', 'TikTok', '50% off', 'Comment'];
  const { script: plan, stillMissing } = injectMissingComponents(floored, inventory);
  assert.equal(stillMissing.length, 0, 'all relayed components present after injection');
  assert.equal(plan.filter(s => s.visualType === 'motion').length, 3, 'motion floor holds (3×6s span)');
  const motions = plan.filter(s => s.visualType === 'motion');
  assert.deepEqual(motions.map(s => s.sceneNumber), [3, 4, 5], 'middle-hero spans forward scenes 3,4,5');
  assert.ok(motions.every(s => s.soraBlock === 0), 'one shared Sora take for the whole span');
  assert.ok(plan.some(s => s.visualPrompt.includes('Comment')), 'CTA wording on screen');
  assert.equal(plan.reduce((a, s) => a + s.duration, 0), 30, 'exact time budget preserved');
});

// ─── (d) parse-layer TRUNCATION keeps component-bearing copy ────────────────
test('parseScenePlan: long component-bearing narration is TRUNCATED, never discarded to generic arc', () => {
  const raw = {
    scenes: Array.from({ length: 5 }, (_, i) => ({
      sceneNumber: i + 1,
      duration: 6,
      type: 'gpt-image',
      visualPrompt: `Cinematic visual ${i + 1}`,
      narration: i === 0
        ? 'Opening with the lavender palette and the red accents and the TikTok banner and the fifty percent off offer all clearly visible in frame for the viewer to notice right away.'
        : `Narration ${i + 1}`,
    })),
  };
  const plan = parseScenePlan(raw, 'subject', 30, 'scene');
  const n1 = plan[0].narration;
  assert.ok(n1.toLowerCase().includes('lavender'), 'component survives truncation');
  assert.ok(!n1.startsWith('Opening — introducing'), 'NOT the generic arc fallback');
  assert.ok(n1.split(/\s+/).length <= 17, 'truncated to the scene word cap (6s scene)');
});

// ─── (e) actionHint-driven consultant closing line ──────────────────────────
test('consultGenerateReply: wand default when no actionHint, real button when supplied', () => {
  assert.equal(consultGenerateReply(), 'Great, tap the wand to generate!');
  assert.equal(consultGenerateReply(''), 'Great, tap the wand to generate!');
  assert.equal(consultGenerateReply('   '), 'Great, tap the wand to generate!');
  assert.equal(consultGenerateReply('press Launch Project to generate your video'), 'press Launch Project to generate your video');
});