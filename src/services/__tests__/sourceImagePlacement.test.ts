/**
 * UPLOADED-PHOTO PLACEMENT — contract, deterministic parser, per-scene projection.
 *
 * Owner (Oct 30): "anything the client uploads or agrees to in chat must actually
 * change the output". PR #135 made the photo REACH the image model but the default
 * was scene 1 only and there was no way for anyone — chip or chat — to say WHERE it
 * belongs. This suite locks down the layer that lets a placement be STATED:
 *
 *   • parseSourceImagePlacement(text)  — pure, no model call, no I/O. Understands
 *     "background for the whole video", "use it in the background", "use it in
 *     scene 3", "scenes 2 and 4", "only the last scene", "first scene", "for the
 *     first 5 seconds", "from scene 3 on", "don't use the photo", "no photo" — and
 *     returns `undefined` (never a guess) when it is not confident.
 *   • WHOLE-SCENE QUANTIZATION: seconds become whole scenes, never a split scene.
 *   • normalizeSourceImagePlacement / resolveSourceImagePlacementInput — ONE helper
 *     for the persisted shape, strict at the routes (400 on malformed).
 *   • scenesForSourceImagePlacement / deriveSceneSourceImageMetadata — the per-scene
 *     projection: named scenes only, `background` = every scene, `none` = none, and
 *     ABSENT = scene 1 only (byte-identical to the pre-placement behaviour).
 *
 * ZERO paid calls, zero I/O — pure functions plus source-contract assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SOURCE_IMAGE_PLACEMENT,
  deriveSceneSourceImageMetadata,
  describeSourceImagePlacement,
  normalizeSourceImagePlacement,
  parseSourceImagePlacement,
  resolveProjectSourceImagePlacement,
  resolveSourceImagePlacementInput,
  scenesForSourceImagePlacement,
  sourceImageForScene,
  wholeScenesForSeconds,
} from '../sourceImagePlacement.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(SRC_ROOT, rel), 'utf8');

/** Five 6s scenes = 30s delivered video. */
const FIVE_SCENES = [
  { sceneNumber: 1, duration: 6 },
  { sceneNumber: 2, duration: 6 },
  { sceneNumber: 3, duration: 6 },
  { sceneNumber: 4, duration: 6 },
  { sceneNumber: 5, duration: 6 },
];
const CTX = { sceneCount: 5, sceneSeconds: [6, 6, 6, 6, 6] };

// ─── (a) the parser: the client's own words ─────────────────────────────────

test('(a1) "background for the whole video" ⇒ background, every scene', () => {
  const p = parseSourceImagePlacement('Use the photo in the background for the whole video', CTX);
  assert.ok(p);
  assert.equal(p.mode, 'background');
  assert.deepEqual(p.sceneNumbers, []);
  assert.equal(p.stated, true);
  assert.deepEqual(scenesForSourceImagePlacement(p, FIVE_SCENES), [1, 2, 3, 4, 5]);
});

test('(a2) "use it in the background" ⇒ background (no "whole video" needed)', () => {
  const p = parseSourceImagePlacement('Use it in the background', CTX);
  assert.ok(p);
  assert.equal(p.mode, 'background');
});

test('(a3) "use it in scene 3" ⇒ scene 3 only', () => {
  const p = parseSourceImagePlacement('use it in scene 3', CTX);
  assert.ok(p);
  assert.equal(p.mode, 'scene');
  assert.deepEqual(p.sceneNumbers, [3]);
  assert.deepEqual(scenesForSourceImagePlacement(p, FIVE_SCENES), [3]);
});

test('(a4) "scenes 2 and 4" ⇒ those two scenes, ascending', () => {
  const p = parseSourceImagePlacement('put my picture in scenes 4 and 2', CTX);
  assert.ok(p);
  assert.deepEqual(p.sceneNumbers, [2, 4]);
  assert.deepEqual(scenesForSourceImagePlacement(p, FIVE_SCENES), [2, 4]);
});

test('(a5) "only the last scene" / "first scene" resolve against the real scene count', () => {
  const last = parseSourceImagePlacement('only the last scene', CTX);
  assert.ok(last);
  assert.deepEqual(last.sceneNumbers, [5]);
  assert.equal(last.anchor, 'end');
  const first = parseSourceImagePlacement('use the photo in the first scene', CTX);
  assert.ok(first);
  assert.deepEqual(first.sceneNumbers, [1]);
});

test('(a6) "from scene 3 on" ⇒ 3,4,5 (needs the scene count to be honest)', () => {
  const p = parseSourceImagePlacement('use my photo from scene 3 on', CTX);
  assert.ok(p);
  assert.deepEqual(p.sceneNumbers, [3, 4, 5]);
  assert.equal(parseSourceImagePlacement('use my photo from scene 3 on'), undefined, 'no scene count ⇒ not confident');
});

test('(a7) "scenes 2 through 4" ⇒ an inclusive whole-scene range', () => {
  const p = parseSourceImagePlacement('use the photo in scenes 2 through 4', CTX);
  assert.ok(p);
  assert.deepEqual(p.sceneNumbers, [2, 3, 4]);
});

test('(a8) "for the first 5 seconds" ⇒ WHOLE scenes, never a split scene', () => {
  const p = parseSourceImagePlacement('show it for the first 5 seconds', CTX);
  assert.ok(p);
  assert.equal(p.mode, 'scene');
  assert.deepEqual(p.sceneNumbers, [1], '5s inside a 6s scene = one whole scene');
  assert.equal(p.requestedSeconds, 5);
  assert.equal(p.effectiveSeconds, 6, 'the delivered length is a whole scene, not 5s');
  assert.equal(p.anchor, 'start');
});

test('(a9) quantization: 20s of a 30s/5-scene video = 3 whole scenes (never 3.33)', () => {
  const p = parseSourceImagePlacement('use the photo for the first 20 seconds', CTX);
  assert.ok(p);
  assert.deepEqual(p.sceneNumbers, [1, 2, 3]);
  assert.equal(p.effectiveSeconds, 18);
  // Longer than the video clamps to every scene — effectively a background.
  const all = parseSourceImagePlacement('use the photo for the first 90 seconds', CTX);
  assert.ok(all);
  assert.deepEqual(all.sceneNumbers, [1, 2, 3, 4, 5]);
  // Whole scenes only — every derived length is a sum of complete scene durations.
  for (const seconds of [1, 4, 7, 13, 21, 29]) {
    const q = wholeScenesForSeconds(seconds, CTX, 'start');
    assert.ok(q);
    assert.equal(q.effectiveSeconds, q.sceneNumbers.length * 6, `never a fractional scene (${seconds}s)`);
  }
});

test('(a10) spoken numbers work ("for the first five seconds")', () => {
  const p = parseSourceImagePlacement('show the photo for the first five seconds', CTX);
  assert.ok(p);
  assert.equal(p.requestedSeconds, 5);
});

test('(a11) "don\'t use the photo" / "no photo" ⇒ none', () => {
  for (const text of ["don't use the photo", 'no photo please', 'do not use the picture at all', 'the photo is not needed']) {
    const p = parseSourceImagePlacement(text, CTX);
    assert.ok(p, text);
    assert.equal(p.mode, 'none', text);
    assert.deepEqual(scenesForSourceImagePlacement(p, FIVE_SCENES), [], text);
  }
});

test('(a12) explicit object beats the parser (precedence)', () => {
  const fromObject = resolveSourceImagePlacementInput({ mode: 'scene', sceneNumbers: [4] }, CTX);
  assert.ok(fromObject.ok);
  assert.deepEqual(fromObject.placement?.sceneNumbers, [4]);
  // A JSON string of an object is an object too — never run through the parser.
  const fromJson = resolveSourceImagePlacementInput('{"mode":"background"}', CTX);
  assert.ok(fromJson.ok);
  assert.equal(fromJson.placement?.mode, 'background');
});

test('(a13) NOT confident ⇒ undefined (never a guess)', () => {
  const cases = [
    '',                                 // nothing at all
    'make the video 30 seconds',        // no photo reference
    'background music for the whole video', // a music instruction
    'make the last scene longer',       // editing a scene, not placing a photo
    'use the photo',                    // no placement stated at all
  ];
  for (const text of cases) {
    assert.equal(parseSourceImagePlacement(text, CTX), undefined, text);
  }
  // Needs a scene count / scene length we do not have ⇒ refuse rather than guess.
  assert.equal(parseSourceImagePlacement('only the last scene'), undefined);
  assert.equal(parseSourceImagePlacement('use the photo for the first 5 seconds'), undefined);
});

test('(a14) multi-sentence chat: the video length never becomes the photo duration', () => {
  const p = parseSourceImagePlacement('Make the video 30 seconds. Use my photo in scene 3.', CTX);
  assert.ok(p);
  assert.deepEqual(p.sceneNumbers, [3]);
  assert.equal(p.requestedSeconds, undefined, '30s is the video, not the photo');
  const bg = parseSourceImagePlacement('Use my photo. Background for the whole video.', CTX);
  assert.ok(bg);
  assert.equal(bg.mode, 'background');
});

// ─── (b) the persisted shape ────────────────────────────────────────────────

test('(b1) canonical object round-trips and defaults are filled in', () => {
  const p = normalizeSourceImagePlacement({ mode: 'scene', sceneNumbers: [2, 4] });
  assert.deepEqual(p, {
    mode: 'scene',
    sceneNumbers: [2, 4],
    anchor: 'start',
    fit: 'cover',
    treatment: 'full',
    stated: true,
  });
  const bg = normalizeSourceImagePlacement({ mode: 'background', treatment: 'blurred-backdrop', fit: 'contain', anchor: 'end' });
  assert.equal(bg?.mode, 'background');
  assert.equal(bg?.treatment, 'blurred-backdrop');
  assert.equal(bg?.fit, 'contain');
  assert.equal(bg?.anchor, 'end');
});

test('(b2) legacy shapes still normalise (sceneNumber / time window / JSON string)', () => {
  assert.deepEqual(normalizeSourceImagePlacement({ mode: 'scene', sceneNumber: 3 })?.sceneNumbers, [3]);
  const window = normalizeSourceImagePlacement({ mode: 'time', startSec: 12, endSec: 18 });
  assert.ok(window);
  assert.deepEqual(window.window, { startSec: 12, endSec: 18 });
  assert.deepEqual(scenesForSourceImagePlacement(window, FIVE_SCENES), [3], 'a window is projected to whole scenes by overlap');
  assert.deepEqual(normalizeSourceImagePlacement('{"mode":"scene","sceneNumbers":[4]}')?.sceneNumbers, [4]);
});

test('(b3) junk degrades to null, never a throw', () => {
  for (const junk of [undefined, null, '', '   ', 'not json', { mode: 'nowhere' }, { mode: 'scene' }, { mode: 'time' }, [], 42]) {
    assert.equal(normalizeSourceImagePlacement(junk), null, String(junk));
  }
});

test('(b4) strict route input: absent ⇒ null, malformed ⇒ readable 400 error', () => {
  assert.deepEqual(resolveSourceImagePlacementInput(undefined), { ok: true, placement: null });
  assert.deepEqual(resolveSourceImagePlacementInput(''), { ok: true, placement: null });
  for (const bad of [{ mode: 'nowhere' }, { mode: 'scene' }, { mode: 'time' }, [], 42, '{bad json']) {
    const r = resolveSourceImagePlacementInput(bad, CTX);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.ok(r.error.length > 20 && /sourceImagePlacement|photo/i.test(r.error), r.error);
  }
  const vague = resolveSourceImagePlacementInput('make it pop', CTX);
  assert.equal(vague.ok, false, 'a sentence we cannot place must be told, not stored');
});

// ─── (c) the per-scene projection ───────────────────────────────────────────

test('(c1) background ⇒ every scene; named ⇒ only those; none ⇒ no scene', () => {
  const hero = 'https://r2.example/brands/u1/cinema/uploads/photo.jpg?sig=abc';
  const background = normalizeSourceImagePlacement({ mode: 'background' });
  assert.deepEqual(scenesForSourceImagePlacement(background, FIVE_SCENES), [1, 2, 3, 4, 5]);
  for (const n of [1, 2, 3, 4, 5]) assert.equal(sourceImageForScene(hero, background, FIVE_SCENES, n), hero);

  const named = normalizeSourceImagePlacement({ mode: 'scene', sceneNumbers: [2, 4] });
  assert.deepEqual(scenesForSourceImagePlacement(named, FIVE_SCENES), [2, 4]);
  assert.equal(sourceImageForScene(hero, named, FIVE_SCENES, 2), hero);
  assert.equal(sourceImageForScene(hero, named, FIVE_SCENES, 3), undefined);
  assert.equal(sourceImageForScene(hero, named, FIVE_SCENES, 4), hero);

  const none = normalizeSourceImagePlacement({ mode: 'none' });
  assert.deepEqual(scenesForSourceImagePlacement(none, FIVE_SCENES), []);
  for (const n of [1, 2, 3, 4, 5]) assert.equal(sourceImageForScene(hero, none, FIVE_SCENES, n), undefined);
});

test('(c2) ABSENT placement ⇒ scene 1 only (unchanged legacy default)', () => {
  const hero = 'https://r2.example/brands/u1/cinema/uploads/photo.jpg';
  for (const absent of [null, undefined, normalizeSourceImagePlacement(undefined)]) {
    assert.deepEqual(scenesForSourceImagePlacement(absent, FIVE_SCENES), [1]);
    assert.equal(sourceImageForScene(hero, absent, FIVE_SCENES, 1), hero);
    for (const n of [2, 3, 4, 5]) assert.equal(sourceImageForScene(hero, absent, FIVE_SCENES, n), undefined);
  }
  assert.deepEqual(DEFAULT_SOURCE_IMAGE_PLACEMENT, {
    mode: 'scene', sceneNumbers: [1], anchor: 'start', fit: 'cover', treatment: 'full', stated: false,
  });
});

test('(c3) a scene number outside the plan never invents a scene', () => {
  const p = normalizeSourceImagePlacement({ mode: 'scene', sceneNumbers: [9] });
  assert.deepEqual(scenesForSourceImagePlacement(p, FIVE_SCENES), []);
});

test('(c4) derived metadata.sourceImage per scene (role / placementIndex), visualPrompt untouched', () => {
  const background = normalizeSourceImagePlacement({ mode: 'background' });
  const bgMeta = deriveSceneSourceImageMetadata(background, FIVE_SCENES);
  assert.deepEqual(Object.keys(bgMeta).sort(), ['1', '2', '3', '4', '5']);
  assert.deepEqual(bgMeta[1], { role: 'full-frame', placementIndex: 0 });

  const backdrop = normalizeSourceImagePlacement({ mode: 'scene', sceneNumbers: [2, 4], treatment: 'blurred-backdrop' });
  const meta = deriveSceneSourceImageMetadata(backdrop, FIVE_SCENES);
  assert.deepEqual(Object.keys(meta).sort(), ['2', '4']);
  assert.deepEqual(meta[2], { role: 'backdrop', placementIndex: 0 });
  assert.deepEqual(meta[4], { role: 'backdrop', placementIndex: 1 });

  const none = deriveSceneSourceImageMetadata(normalizeSourceImagePlacement({ mode: 'none' }), FIVE_SCENES);
  assert.deepEqual(none, {});
});

// ─── (d) what the app shows back ────────────────────────────────────────────

test('(d1) receipts describe what was understood', () => {
  const bg = normalizeSourceImagePlacement({ mode: 'background' });
  assert.match(describeSourceImagePlacement(bg, [1, 2, 3, 4, 5]), /whole video/i);
  const named = normalizeSourceImagePlacement({ mode: 'scene', sceneNumbers: [3] });
  assert.match(describeSourceImagePlacement(named, [3]), /scene 3/);
  const none = normalizeSourceImagePlacement({ mode: 'none' });
  assert.match(describeSourceImagePlacement(none, []), /not used/i);
  // Never stated ⇒ tell the client what we did AND how to change it.
  assert.match(describeSourceImagePlacement(null, [1]), /opening scene/i);
  assert.match(describeSourceImagePlacement(null, [1]), /background/);
});

test('(d2) read-path resolution: exposed when there is a photo or a stated placement', () => {
  const resolved = resolveProjectSourceImagePlacement(
    { sourceImages: ['https://r2.example/p.jpg?sig=abc'], sourceImagePlacement: { mode: 'background' } },
    FIVE_SCENES,
  );
  assert.ok(resolved);
  assert.equal(resolved.mode, 'background');
  assert.deepEqual(resolved.targetScenes, [1, 2, 3, 4, 5]);
  assert.equal(resolved.photoPresent, true);
  assert.match(resolved.summary, /whole video/i);

  // Photo, no placement ⇒ the legacy default, clearly labelled as not stated.
  const legacy = resolveProjectSourceImagePlacement({ sourceImages: ['https://r2.example/p.jpg'] }, FIVE_SCENES);
  assert.ok(legacy);
  assert.equal(legacy.stated, false);
  assert.deepEqual(legacy.targetScenes, [1]);

  // No photo and no placement ⇒ nothing added to the payload at all.
  assert.equal(resolveProjectSourceImagePlacement({}, FIVE_SCENES), undefined);
});

// ─── (e) wiring: the routes and the pipeline use the ONE helper ─────────────

test('(e1) both create routes validate through the shared helper and answer 400', () => {
  const studio = read('routes/studioRoutes.ts');
  assert.match(studio, /resolveSourceImagePlacementInput\(/, 'studio create route must validate placement');
  assert.match(studio, /placementInput\.ok[\s\S]{0,200}status\(400\)/, 'malformed placement must be a 400');
  assert.match(studio, /sourceImagePlacement: placementInput\.placement/, 'the VALIDATED spec must be what is stored');

  const approval = read('controllers/approvalController.ts');
  assert.match(approval, /resolveSourceImagePlacementInput\(/, 'faceless create path must validate placement');
  assert.match(approval, /sourceImagePlacementInput\.ok[\s\S]{0,200}status\(400\)/, 'malformed placement must be a 400');
});

test('(e2) createProject persists the spec and writes the derived per-scene projection', () => {
  const pipeline = read('services/sceneVideoPipelineService.ts');
  assert.match(pipeline, /sourceImagePlacementMeta\?\{sourceImagePlacement:sourceImagePlacementMeta\}/, 'spec must be persisted on the project');
  assert.match(pipeline, /deriveSceneSourceImageMetadata\(/, 'scenes must get the derived projection');
  assert.match(pipeline, /\.\.\.\(sceneSourceImageMeta\[s\.sceneNumber\] \? \{ sourceImage: sceneSourceImageMeta\[s\.sceneNumber\] \} : \{\}\)/, 'per-scene metadata.sourceImage');
  // The projection must never touch the prompt the image model reads.
  assert.ok(
    !/sceneSourceImageMeta[\s\S]{0,200}visualPrompt:/.test(pipeline),
    'the placement must never rewrite visualPrompt',
  );
});

test('(e3) the read path exposes the resolved placement the app polls', () => {
  const pipeline = read('services/sceneVideoPipelineService.ts');
  assert.match(pipeline, /resolveProjectSourceImagePlacement\(/, 'getProject must expose the resolved placement');
  assert.match(pipeline, /sourceImagePlacement: resolvedPlacement/, 'returned as sourceImagePlacement on the project payload');
});

test('(e4) the worker and regeneration still resolve the reference from the same rule', () => {
  const pipeline = read('services/sceneVideoPipelineService.ts');
  assert.match(pipeline, /scenesForSourceImagePlacement\(sourceImagePlacement, scenes\.map/, 'worker placement targets');
  assert.match(pipeline, /sourceImageForScene\(/, 'regenerateScene must use the shared rule');
});

test('(e5) the placement module is the single implementation (no duplicate normaliser)', () => {
  const pipeline = read('services/sceneVideoPipelineService.ts');
  assert.ok(
    !/export function normalizeSourceImagePlacement/.test(pipeline),
    'the normaliser must live only in sourceImagePlacement.ts',
  );
  assert.match(pipeline, /from '\.\/sourceImagePlacement\.js'/, 'the pipeline must import the shared contract');
});
