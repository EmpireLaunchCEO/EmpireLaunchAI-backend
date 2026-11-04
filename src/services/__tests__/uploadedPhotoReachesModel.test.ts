/**
 * UPLOADED PHOTO ACTUALLY REACHES THE IMAGE MODEL (owner Oct 30).
 *
 * Owner rule: "anything the client uploads or agrees to in chat must actually
 * change the output" — and if it cannot be used, the client must be TOLD, never
 * silently ignored.
 *
 * PROVEN DEFECT this file locks down:
 *   cinemaEngineService.storeUpload returns a bare FILESYSTEM PATH
 *   (`/app/public/assets/cinema/facial_dna/<uuid>.jpg`). It was handed to
 *   renderingEngine.generateFromInputImage, which called `fetch(path)` →
 *   `TypeError: Failed to parse URL` → caught and swallowed → the still silently
 *   fell back to text-to-image. The client's photo never reached OpenAI and
 *   never appeared in the video.
 *
 *   The same reference was also stamped on EVERY still scene (5 near-identical
 *   shots), and regenerateScene passed `undefined`, silently dropping the photo.
 *
 * ZERO paid calls: every fetch is a deterministic fake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderingEngine, loadReferenceImageBytes, describeReferenceImage } from '../renderingEngine.js';
import {
  normalizeSourceImagePlacement,
  scenesForSourceImagePlacement,
  sourceImageForScene,
} from '../sceneVideoPipelineService.js';

// renderImage refuses to run without a key; every fetch below is a fake, so a
// placeholder key is correct here (no network, no spend).
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-not-a-real-key';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = path.resolve(HERE, '..');

/** 1x1 opaque PNG — a real, decodable image (sharp accepts it). */
const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tmpPng(name = 'upload.png'): { dir: string; file: string; bytes: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-reach-'));
  const file = path.join(dir, name);
  const bytes = Buffer.from(ONE_PX_PNG_B64, 'base64');
  fs.writeFileSync(file, bytes);
  return { dir, file, bytes };
}

type CapturedCall = { url: string; body: any };

/**
 * Install a fake global fetch that records every call. `edits` / `generations`
 * answer the two gpt-image-2 endpoints; anything else throws (so an unexpected
 * network call fails the test loudly instead of hanging).
 */
function installFakeFetch(): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  const json = (payload: any) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const href = typeof url === 'string' ? url : String(url?.url ?? url);
    calls.push({ url: href, body: init?.body });
    if (href.endsWith('/v1/images/edits') || href.endsWith('/v1/images/generations')) {
      return json({ data: [{ b64_json: ONE_PX_PNG_B64 }] });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

const callsTo = (calls: CapturedCall[], suffix: string) => calls.filter((c) => c.url.endsWith(suffix));

// ─── (a) a LOCAL PATH reference produces an edits call with REAL BYTES ───────

test('(a) a local-path reference reaches the edits endpoint with the real uploaded bytes', async () => {
  const { dir, file, bytes } = tmpPng('client-product-photo.png');
  const fake = installFakeFetch();
  try {
    const result = await renderingEngine.renderImage('a hero shot of the product', undefined, file, {
      size: '1024x1792',
      noText: true,
    });

    assert.equal(result.success, true, `renderImage must succeed: ${result.error}`);
    assert.deepEqual(result.sourceImage, { used: true, reference: file }, 'the project must be told the photo WAS used');

    const edits = callsTo(fake.calls, '/v1/images/edits');
    const generations = callsTo(fake.calls, '/v1/images/generations');
    assert.equal(edits.length, 1, 'exactly ONE edits call — the reference must be sent, not skipped');
    assert.equal(generations.length, 0, 'a usable reference must NOT fall back to text-to-image');

    // The bytes really on the wire are the client's file, not an empty placeholder.
    const form = edits[0].body as FormData;
    const imagePart = form.get('image') as File;
    assert.ok(imagePart, 'the multipart body must carry an `image` part');
    const sent = Buffer.from(await imagePart.arrayBuffer());
    assert.equal(sent.length, bytes.length, 'the image part must carry the full file, not 0 bytes');
    assert.ok(sent.equals(bytes), 'the image part must be byte-identical to the uploaded file');
    assert.equal(imagePart.type, 'image/png');
    assert.equal(form.get('model'), 'gpt-image-2');
    assert.match(String(form.get('prompt')), /hero shot of the product/);
  } finally {
    fake.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('(a2) a data: URI reference also reaches the edits endpoint (no fetch of the reference)', async () => {
  const dataUri = `data:image/png;base64,${ONE_PX_PNG_B64}`;
  const fake = installFakeFetch();
  try {
    const result = await renderingEngine.renderImage('hero', undefined, dataUri, { size: '1024x1792', noText: true });
    assert.equal(result.success, true, result.error);
    assert.equal(result.sourceImage?.used, true);
    assert.equal(callsTo(fake.calls, '/v1/images/edits').length, 1);
    // The data URI must never be echoed into a log line in full.
    assert.ok(describeReferenceImage(dataUri).length < 80);
    assert.match(describeReferenceImage(dataUri), /^data-uri\(image\/png/);
  } finally {
    fake.restore();
  }
});

// ─── (5) an UNREADABLE reference is loud, recorded, and never crashes ────────

test('(5) an unreadable reference falls back to text-to-image but REPORTS the failure', async () => {
  const fake = installFakeFetch();
  try {
    const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`, 'ghost.png');
    const result = await renderingEngine.renderImage('hero', undefined, missing, { size: '1024x1792', noText: true });

    assert.equal(result.success, true, 'a broken reference must never fail the render');
    assert.equal(result.sourceImage?.used, false, 'the drop must be RECORDED, not silent');
    assert.match(String(result.sourceImage?.reason), /not readable/, 'the reason must name the real problem');
    assert.equal(callsTo(fake.calls, '/v1/images/edits').length, 0);
    assert.equal(callsTo(fake.calls, '/v1/images/generations').length, 1, 'text-to-image is the documented fallback');
  } finally {
    fake.restore();
  }
});

test('loadReferenceImageBytes rejects a bare non-existent path with a specific error (never "Failed to parse URL")', async () => {
  await assert.rejects(
    () => loadReferenceImageBytes('/app/public/assets/cinema/facial_dna/nope.jpg'),
    (err: any) => {
      assert.match(err.message, /reference image is not readable/);
      assert.doesNotMatch(err.message, /Failed to parse URL/);
      return true;
    },
  );
});

// ─── (e) a photo-less project takes the UNCHANGED text-to-image path ────────

test('(e) no uploaded photo ⇒ exactly the old text-to-image call, no edits call, no sourceImage outcome', async () => {
  const fake = installFakeFetch();
  try {
    const result = await renderingEngine.renderImage('a flat lay of the product', undefined, undefined, {
      size: '1024x1792',
      noText: true,
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.sourceImage, undefined, 'nothing to report when the client uploaded nothing');
    assert.equal(callsTo(fake.calls, '/v1/images/edits').length, 0, 'never call the edits endpoint without a reference');
    assert.equal(callsTo(fake.calls, '/v1/images/generations').length, 1);
    const body = JSON.parse(String((callsTo(fake.calls, '/v1/images/generations')[0].body)));
    assert.equal(body.model, 'gpt-image-2');
    assert.equal(body.n, 1);
    assert.equal(body.size, '1024x1792');
    assert.match(body.prompt, /flat lay of the product/);
  } finally {
    fake.restore();
  }
});

// ─── (b) NO placement spec ⇒ ONLY scene 1 receives the reference ─────────────

const FIVE_SCENES = [
  { sceneNumber: 1, duration: 6 },
  { sceneNumber: 2, duration: 6 },
  { sceneNumber: 3, duration: 6 },
  { sceneNumber: 4, duration: 6 },
  { sceneNumber: 5, duration: 6 },
];

test('(b) with no placement spec only scene 1 receives the reference', () => {
  assert.deepEqual(scenesForSourceImagePlacement(null, FIVE_SCENES), [1]);
  assert.deepEqual(scenesForSourceImagePlacement(undefined, FIVE_SCENES), [1]);

  const hero = 'https://r2.example/brands/u1/cinema/uploads/photo.jpg';
  assert.equal(sourceImageForScene(hero, null, FIVE_SCENES, 1), hero, 'scene 1 (the hook) gets the photo');
  for (const n of [2, 3, 4, 5]) {
    assert.equal(sourceImageForScene(hero, null, FIVE_SCENES, n), undefined, `scene ${n} must NOT be stamped with the photo`);
  }
});

// ─── (c) {mode:'scene', sceneNumber:3} ⇒ ONLY scene 3 ───────────────────────

test("(c) placement {mode:'scene',sceneNumber:3} sends the reference to scene 3 only", () => {
  const placement = normalizeSourceImagePlacement({ mode: 'scene', sceneNumber: 3 });
  // Shape upgraded (owner Oct 30) to the canonical spec: the legacy sceneNumber
  // still maps to the same single scene, and the defaults are filled in.
  assert.deepEqual(placement, { mode: 'scene', sceneNumbers: [3], anchor: 'start', fit: 'cover', treatment: 'full', stated: true });
  assert.deepEqual(scenesForSourceImagePlacement(placement, FIVE_SCENES), [3]);

  const hero = '/app/public/assets/cinema/facial_dna/abc.png';
  assert.equal(sourceImageForScene(hero, placement, FIVE_SCENES, 3), hero);
  for (const n of [1, 2, 4, 5]) {
    assert.equal(sourceImageForScene(hero, placement, FIVE_SCENES, n), undefined);
  }
});

test("(c2) placement {mode:'time'} maps a timestamp window onto the scenes that overlap it", () => {
  // 5 x 6s scenes → scene 3 covers t=[12,18)
  const placement = normalizeSourceImagePlacement({ mode: 'time', startSec: 12, endSec: 18 });
  assert.deepEqual(scenesForSourceImagePlacement(placement, FIVE_SCENES), [3]);
  // open-ended window from 18s ⇒ the last two scenes
  assert.deepEqual(scenesForSourceImagePlacement(normalizeSourceImagePlacement({ mode: 'time', startSec: 18 }), FIVE_SCENES), [4, 5]);
});

test("(c3) placement {mode:'background'} is the explicit opt-in to every scene", () => {
  const placement = normalizeSourceImagePlacement({ mode: 'background' });
  assert.deepEqual(placement, { mode: 'background', sceneNumbers: [], anchor: 'start', fit: 'cover', treatment: 'full', stated: true });
  assert.deepEqual(scenesForSourceImagePlacement(placement, FIVE_SCENES), [1, 2, 3, 4, 5]);
});

test('normaliser degrades junk to "no spec" (⇒ scene 1) instead of crashing', () => {
  assert.equal(normalizeSourceImagePlacement(undefined), null);
  assert.equal(normalizeSourceImagePlacement(''), null);
  assert.equal(normalizeSourceImagePlacement('not json'), null);
  assert.equal(normalizeSourceImagePlacement({ mode: 'nowhere' }), null);
  assert.equal(normalizeSourceImagePlacement({ mode: 'scene' }), null, 'a scene mode with no sceneNumber is not usable');
  assert.equal(normalizeSourceImagePlacement({ mode: 'time' }), null, 'a time mode with no window is not usable');
  assert.deepEqual(normalizeSourceImagePlacement('{"mode":"scene","sceneNumber":"4"}'), { mode: 'scene', sceneNumbers: [4], anchor: 'start', fit: 'cover', treatment: 'full', stated: true });
});

// ─── (d) regeneration keeps the reference ───────────────────────────────────

test('(d) regeneration resolves the SAME reference for the same placement target', () => {
  const hero = 'https://r2.example/brands/u1/cinema/uploads/photo.jpg';
  // This is exactly what regenerateScene feeds into processScene (studio path).
  const noSpec = sourceImageForScene(hero, normalizeSourceImagePlacement(undefined), FIVE_SCENES, 1);
  assert.equal(noSpec, hero, 'regenerating scene 1 must keep the uploaded photo');
  const scene3 = sourceImageForScene(hero, normalizeSourceImagePlacement({ mode: 'scene', sceneNumber: 3 }), FIVE_SCENES, 3);
  assert.equal(scene3, hero, 'regenerating the placement target must keep the uploaded photo');
});

test('(d2) SOURCE CONTRACT: regenerateScene no longer passes `undefined` as the source image', () => {
  const src = fs.readFileSync(path.join(SERVICE_SRC, 'sceneVideoPipelineService.ts'), 'utf8');
  const regen = src.slice(src.indexOf('async regenerateScene('));
  assert.ok(regen.length > 0, 'regenerateScene must exist');
  assert.doesNotMatch(
    regen,
    /processScene\(scene,userId,pmeta\.voice,pmeta\.tone,undefined,/,
    'regenerateScene must never drop the uploaded photo again',
  );
  assert.match(regen, /sourceImageForScene\(/, 'regenerateScene must use the shared placement rule');
  assert.match(regen, /refreshR2Url\(/, 'regenerateScene must re-sign an expired R2 link');
  assert.match(regen, /processScene\(scene,userId,pmeta\.voice,pmeta\.tone,regenSourceImage,/, 'the resolved reference is what is passed');
});

// ─── (1)/(2) upload path: durable R2 URL + local path kept ──────────────────

test('(2) SOURCE CONTRACT: the upload path publishes to R2 and returns photoUrl + photoPath', () => {
  const engine = fs.readFileSync(path.join(SERVICE_SRC, 'cinemaEngineService.ts'), 'utf8');
  assert.match(engine, /async storeUploadAndPublish\(/, 'the R2-publishing upload method must exist');
  assert.match(engine, /r2Storage\.uploadFile\(localPath, userId \|\| 'anonymous', 'cinema\/uploads', mime\)/, 'the photo must be published to R2');
  assert.match(engine, /return \{ localPath, publicUrl, r2Key: upload\.key \}/, 'both the local path and the durable URL are returned');

  const controller = fs.readFileSync(path.join(SERVICE_SRC, '..', 'controllers', 'cinemaController.ts'), 'utf8');
  assert.match(controller, /storeUploadAndPublish\(filePath, 'photo', userId\)/, 'uploadPhoto must use the publishing upload');
  assert.match(controller, /photoUrl,/, 'photoUrl (the durable R2 URL) is what the client persists as its source image');
  assert.match(controller, /photoPath: storedPath,/, "photoPath stays available for Neural Twin's on-disk facial-DNA read");
});

// ─── (3)/(5) renderer wiring: placement honoured, outcome recorded ──────────

test('(3)/(5) SOURCE CONTRACT: processProject gates the reference by placement and records the outcome', () => {
  const src = fs.readFileSync(path.join(SERVICE_SRC, 'sceneVideoPipelineService.ts'), 'utf8');
  assert.match(src, /scenesForSourceImagePlacement\(sourceImagePlacement, scenes\.map/, 'the worker must resolve placement targets');
  assert.match(
    src,
    /sourceImageTargetScenes\.includes\(scene\.sceneNumber\) \? heroSource : undefined/,
    'only placement targets may receive the reference — never every scene',
  );
  assert.match(src, /sourceImageUsed: targetSceneNumbers\.length > 0 && unusedTargets\.length === 0/, 'the project must record whether the photo was used');
  assert.match(src, /sourceImageSkippedReason/, 'and WHY not, when it was not');
  // A project with NO photo must not enter any of this.
  assert.match(src, /if \(heroSource\) \{\n      await this\.recordSourceImageOutcome/, 'outcome recording is skipped entirely without an upload');
});
