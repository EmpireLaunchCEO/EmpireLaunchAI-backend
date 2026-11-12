/**
 * THE UPLOADED PHOTO GOES WHERE SHE SAID (owner Nov 11 — the audit's defect 1 and 2):
 *   "make sure that when a client uploads a photo it will be used how they want it used."
 *
 * WHAT WAS BROKEN (measured at origin/main `fb6eebd`):
 *   1. NOTHING produced the placement spec on the live path. The app never sends
 *      `sourceImagePlacement` and `createProject` never read her sentence, so every
 *      photo project fell through to the default — SCENE 1 ONLY, always. "Use it as
 *      the background for the whole video", "from scene 3 on", "don't use it" were
 *      all ignored.
 *   2. `treatment: 'blurred-backdrop'` was PROMISED ("your photo is the blurred
 *      background behind every scene") and never applied: the image prompt told the
 *      model the photo was "the hero and continuous subject … do NOT swap it", i.e.
 *      her backdrop photo became the SUBJECT of every scene — the opposite of the
 *      sentence she was shown.
 *
 * WHAT THIS PINS
 *   • `createProject`'s one resolver turns her own words into the persisted spec with
 *     the ONE parser (`parseSourceImagePlacement`) — never a second parser.
 *   • The spec that is persisted projects onto the RIGHT scenes (background ⇒ every
 *     scene, "scene 3" ⇒ [3], "from scene 3 on" ⇒ [3,4,5], "don't use it" ⇒ none).
 *   • A conversation with no placement sentence keeps today's behaviour (scene 1).
 *   • An explicit spec ALWAYS beats the chat.
 *   • A `blurred-backdrop` placement produces the backdrop instruction and NOT the
 *     hero/do-not-swap one; a `background` placement WITHOUT the treatment keeps the
 *     photo as the hero (unchanged, byte-identical prompt).
 *   • The treatment reaches the renderer through the SAME per-scene metadata the
 *     worker reads, on BOTH render paths (still + Veo seed still).
 *
 * ZERO PAID CALLS: pure deterministic functions, no network, no ffmpeg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildMotionWindowPrompt,
  buildSceneImagePrompt,
  buildWindowPrompt,
  deriveSceneSourceImageMetadata,
  parseScenePlan,
  resolveSourceImagePlacementSpec,
  scenesForSourceImagePlacement,
  sourceImageTreatmentForScene,
  normalizeSourceImagePlacement,
  type ConversationTurn,
} from '../sceneVideoPipelineService.js';

const SERVICE_SRC = readFileSync(path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'), 'utf8');

const PHOTO = 'https://cdn.example.com/uploads/studio-photo.png';
const IDEA = 'A 30 second promo for my bakery.';
/** The planner's real shape for a 30s Faceless video: five 6s scenes. */
const PLANNER_RAW = {
  scenes: [
    { sceneNumber: 1, duration: 6, visualType: 'still', visualPrompt: 'Warm bakery counter at sunrise', narration: 'Fresh bread, baked before the sun comes up.' },
    { sceneNumber: 2, duration: 6, visualType: 'still', visualPrompt: 'Hands pulling a golden loaf from the oven', narration: 'Every loaf is made by hand.' },
    { sceneNumber: 3, duration: 6, visualType: 'still', visualPrompt: 'A tidy pastry display case in morning light', narration: 'Take home something warm.' },
    { sceneNumber: 4, duration: 6, visualType: 'still', visualPrompt: 'Coffee being poured beside a paper bag', narration: 'The bread is why people come back.' },
    { sceneNumber: 5, duration: 6, visualType: 'still', visualPrompt: 'The bakery storefront at golden hour', narration: 'Come by this weekend.' },
  ],
};
const PLANNED = parseScenePlan(PLANNER_RAW, IDEA, 30, 'faceless');
const DURATION = PLANNED.reduce((sum, s) => sum + Number(s.duration || 0), 0);

const say = (content: string): ConversationTurn => ({ role: 'user', content });

/** What createProject does: explicit spec (there is none from the app) + her words. */
function resolveFromChat(content: string, explicit: unknown = undefined) {
  return resolveSourceImagePlacementSpec(
    explicit,
    { idea: IDEA, conversation: [say(content)] },
    PLANNED,
    DURATION,
  );
}

/** The scenes the WORKER would hand the photo to, from the PERSISTED spec. */
function scenesWithPhoto(placement: ReturnType<typeof resolveFromChat>): number[] {
  return scenesForSourceImagePlacement(
    placement,
    PLANNED.map((s) => ({ sceneNumber: s.sceneNumber, duration: s.duration })),
  );
}

/* ─────────── 1. her words become the spec that is persisted ─────────── */

test('her words: "background for the whole video" ⇒ the photo covers EVERY scene', () => {
  const placement = resolveFromChat('Use my photo as the background for the whole video.');
  assert.ok(placement, 'the placement must be produced from her own sentence');
  assert.equal(placement!.mode, 'background');
  assert.equal(placement!.stated, true, 'it is a STATED placement, not the default');
  assert.deepEqual(scenesWithPhoto(placement), [1, 2, 3, 4, 5]);
});

test('her words: one named scene ⇒ only that scene gets the photo', () => {
  const placement = resolveFromChat('Put my picture in scene 3 only.');
  assert.ok(placement);
  assert.equal(placement!.mode, 'scene');
  assert.deepEqual(placement!.sceneNumbers, [3]);
  assert.deepEqual(scenesWithPhoto(placement), [3]);
});

test('her words: "from this point on" ⇒ that scene and every scene after it', () => {
  const placement = resolveFromChat('Use my photo from scene 3 on.');
  assert.ok(placement);
  assert.equal(placement!.mode, 'scene');
  assert.deepEqual(placement!.sceneNumbers, [3, 4, 5]);
  assert.deepEqual(scenesWithPhoto(placement), [3, 4, 5]);
});

test('her words: "don\'t use it" ⇒ the photo is in NO scene', () => {
  const placement = resolveFromChat("Don't use the photo at all.");
  assert.ok(placement);
  assert.equal(placement!.mode, 'none');
  assert.deepEqual(scenesWithPhoto(placement), []);
});

test('no placement sentence in the chat ⇒ unchanged behaviour (scene 1 only)', () => {
  const placement = resolveFromChat('Make it feel warm and premium, and keep it 30 seconds.');
  assert.equal(placement, null, 'never guess a placement she did not state');
  // Exactly what the pipeline did before this change: the opening scene.
  assert.deepEqual(scenesWithPhoto(placement), [1]);
});

test('an EXPLICIT spec beats her chat', () => {
  const explicit = { mode: 'scene', sceneNumbers: [2] };
  const placement = resolveFromChat('Use my photo as the background for the whole video.', explicit);
  assert.equal(placement!.mode, 'scene');
  assert.deepEqual(scenesWithPhoto(placement), [2]);
});

test('an explicit placement SENTENCE is read by the same parser, before the chat', () => {
  const placement = resolveFromChat('Use my photo as the background for the whole video.', 'only the last scene');
  assert.equal(placement!.mode, 'scene');
  assert.deepEqual(scenesWithPhoto(placement), [5]);
});

test('the persisted spec projects the treatment onto every scene it covers', () => {
  const placement = resolveFromChat('Use my photo as the background for the whole video.');
  const projection = deriveSceneSourceImageMetadata(
    placement,
    PLANNED.map((s) => ({ sceneNumber: s.sceneNumber, duration: s.duration })),
  );
  assert.deepEqual(Object.keys(projection).map(Number).sort(), [1, 2, 3, 4, 5]);
  for (const n of [1, 2, 3, 4, 5]) assert.equal(projection[n].role, 'full-frame');
});

/* ─────────── 2. the blurred backdrop is actually instructed ─────────── */

test('a blurred-backdrop placement asks for a BACKDROP and never the hero', () => {
  const prompt = buildSceneImagePrompt('Warm bakery counter at sunrise', PHOTO, 'blurred-backdrop');
  assert.match(prompt, /blurred BACKGROUND PLATE behind this scene/);
  assert.match(prompt, /out of focus/);
  assert.ok(prompt.includes(PHOTO), 'the photo must still be named as the plate');
  assert.ok(prompt.includes('Warm bakery counter at sunrise'), 'the planned subject survives');
  assert.ok(!/hero and continuous subject/i.test(prompt), 'the photo is NOT the hero');
  assert.ok(!/do NOT swap it/i.test(prompt), 'the do-not-swap instruction is gone');
});

test('a background placement WITHOUT the treatment keeps the photo as the hero (unchanged)', () => {
  const legacy = buildSceneImagePrompt('Warm bakery counter at sunrise', PHOTO);
  const full = buildSceneImagePrompt('Warm bakery counter at sunrise', PHOTO, 'full');
  assert.equal(full, legacy, 'the default prompt is byte-identical to before this change');
  assert.match(legacy, /hero and continuous subject/);
  assert.ok(!/BACKGROUND PLATE/.test(legacy));
});

test('no photo ⇒ no instruction, whatever the treatment', () => {
  assert.equal(buildSceneImagePrompt('Warm bakery counter', undefined, 'blurred-backdrop'), 'Warm bakery counter');
});

test('the treatment reaches the renderer through the scene metadata the worker reads', () => {
  const sceneTimings = PLANNED.map((s) => ({ sceneNumber: s.sceneNumber, duration: s.duration }));
  const backdropPlacement = normalizeSourceImagePlacement({
    mode: 'background',
    treatment: 'blurred-backdrop',
    stated: true,
  })!;
  const backdropMeta = deriveSceneSourceImageMetadata(backdropPlacement, sceneTimings);
  const sceneRow = { sceneNumber: 3, visualPrompt: 'A tidy pastry display case', metadata: { sourceImage: backdropMeta[3] } };
  assert.equal(backdropMeta[3].role, 'backdrop');
  assert.equal(sourceImageTreatmentForScene(sceneRow), 'blurred-backdrop');
  assert.match(buildSceneImagePrompt(sceneRow.visualPrompt, PHOTO, sourceImageTreatmentForScene(sceneRow)), /BACKGROUND PLATE/);

  // The same chain for a plain background: role 'full-frame' ⇒ the hero prompt.
  const fullMeta = deriveSceneSourceImageMetadata(
    normalizeSourceImagePlacement({ mode: 'background', stated: true })!,
    sceneTimings,
  );
  assert.equal(sourceImageTreatmentForScene({ metadata: { sourceImage: fullMeta[3] } }), 'full');
  assert.match(buildSceneImagePrompt(sceneRow.visualPrompt, PHOTO, 'full'), /hero and continuous subject/);
});

/* ─────────── 3. the Veo MOTION prompt carries the same treatment ─────────── */

test('her words alone produce the blurred backdrop, all the way to the Veo motion prompt', () => {
  const placement = resolveFromChat('Blur my photo into the background for the whole video.');
  assert.ok(placement, 'her sentence must produce a placement');
  assert.equal(placement!.mode, 'background');
  assert.equal(placement!.treatment, 'blurred-backdrop', '"blur my photo" must not become a sharp hero');

  const sceneTimings = PLANNED.map((s) => ({ sceneNumber: s.sceneNumber, duration: s.duration }));
  const meta = deriveSceneSourceImageMetadata(placement, sceneTimings);
  const sceneRow = {
    sceneNumber: 3,
    duration: 6,
    visualPrompt: 'A tidy pastry display case in morning light',
    metadata: { sourceImage: meta[3] },
  };
  assert.equal(meta[3].role, 'backdrop');

  // THE STRING THAT ACTUALLY REACHES VEO for this scene's motion window.
  const window = { sceneNumber: 3, motionStartSeconds: 0, motionSeconds: 6 };
  const motionPrompt = buildMotionWindowPrompt(window, sceneRow, PHOTO);
  assert.match(motionPrompt, /blurred BACKGROUND PLATE behind this scene/);
  assert.ok(motionPrompt.includes(PHOTO), 'the photo is still named as the plate');
  assert.ok(!/hero and continuous subject/i.test(motionPrompt), 'the motion clip must NOT call the photo the hero');
  assert.ok(!/do NOT swap it/i.test(motionPrompt));

  // …and the seed still for the SAME scene says the same thing: no contradiction
  // between the first frame and the motion that follows it.
  assert.match(buildSceneImagePrompt(sceneRow.visualPrompt, PHOTO, sourceImageTreatmentForScene(sceneRow)), /blurred BACKGROUND PLATE/);
});

test('a plain background scene keeps the OLD hero motion prompt, byte-identical', () => {
  const sceneTimings = PLANNED.map((s) => ({ sceneNumber: s.sceneNumber, duration: s.duration }));
  const fullMeta = deriveSceneSourceImageMetadata(
    normalizeSourceImagePlacement({ mode: 'background', stated: true })!,
    sceneTimings,
  );
  const sceneRow = {
    sceneNumber: 3,
    duration: 6,
    visualPrompt: 'A tidy pastry display case in morning light',
    metadata: { sourceImage: fullMeta[3] },
  };
  const window = { sceneNumber: 3, motionStartSeconds: 0, motionSeconds: 6 };
  const now = buildMotionWindowPrompt(window, sceneRow, PHOTO);
  // Exactly how the window prompt was composed before the treatment existed.
  const before = buildSceneImagePrompt(buildWindowPrompt(window, sceneRow), PHOTO, 'full');
  assert.equal(now, before, 'the default motion prompt must not change for a non-blurred photo');
  assert.match(now, /hero and continuous subject/);
});

test('the Veo window prompt is built by the one function that applies the treatment', () => {
  const at = SERVICE_SRC.indexOf('private async generateOneVeoWindow(');
  assert.ok(at > 0, 'generateOneVeoWindow must exist');
  const body = SERVICE_SRC.slice(at, SERVICE_SRC.indexOf('for (let attempt', at));
  assert.match(body, /const windowPrompt = buildMotionWindowPrompt\(w, scene, heroSource\)/, 'the window prompt must carry the treatment');
  // …and that helper is the ONLY place a Veo window prompt is composed, so no call
  // site can quietly go back to a treatment-less (sharp-hero) motion prompt.
  const builderAt = SERVICE_SRC.indexOf('export function buildMotionWindowPrompt(');
  assert.ok(builderAt > 0, 'buildMotionWindowPrompt must exist');
  assert.match(
    SERVICE_SRC.slice(builderAt, builderAt + 400),
    /withSourceSubject\(buildWindowPrompt\(w, scene\), heroSource \|\| undefined, sourceImageTreatmentForScene\(scene\)\)/,
    'the helper must pass the scene treatment',
  );
  const compositions = SERVICE_SRC.split('withSourceSubject(buildWindowPrompt').length - 1;
  assert.equal(compositions, 1, 'the treatment-carrying helper must be the only window-prompt composition');
});

/* ─────────── wiring: the rules above are on the REAL request path ─────────── */

test('createProject resolves the spec from her words and persists it', () => {
  const at = SERVICE_SRC.indexOf('async createProject(input: VideoProjectInput)');
  assert.ok(at > 0, 'createProject must exist');
  const body = SERVICE_SRC.slice(at, SERVICE_SRC.indexOf('async processProject(', at));
  assert.ok(
    /sourceImagePlacementMeta = hasUploadedPhoto\s*\?\s*resolveSourceImagePlacementSpec\(/.test(body),
    'createProject must resolve the placement (explicit spec first, then her own words)',
  );
  assert.ok(/\.\.\.\(sourceImagePlacementMeta\?\{sourceImagePlacement:sourceImagePlacementMeta\}:/.test(body), 'the resolved spec is what gets persisted');
  assert.ok(!/sourceImagePlacementMeta = normalizeSourceImagePlacement\(input\.sourceImagePlacement\)/.test(body), 'the old normalise-only path must be gone');
});

test('both render paths apply the scene treatment (still + Veo seed still)', () => {
  const stillAt = SERVICE_SRC.indexOf('const subjectPrompt = buildSceneImagePrompt(');
  assert.ok(stillAt > 0, 'the still path must build its prompt');
  assert.match(SERVICE_SRC.slice(stillAt, stillAt + 300), /sourceImageTreatmentForScene\(scene\)/, 'the still prompt must carry the treatment');
  const motionAt = SERVICE_SRC.indexOf('private async renderSceneStillForMotion(');
  assert.ok(motionAt > 0);
  const motionBody = SERVICE_SRC.slice(motionAt, SERVICE_SRC.indexOf('private async ', motionAt + 10));
  assert.match(motionBody, /buildSceneImagePrompt\(visualPrompt, usableSource, sourceImageTreatmentForScene\(scene\)\)/, 'the Veo seed still must carry the same treatment');
});
