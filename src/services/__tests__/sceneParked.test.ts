/**
 * SCENE-BASED IS PARKED — owner decision, Nov 9.
 *
 * The owner keeps Scene in her own account; every client is refused. These
 * tests measure the rule the way the product uses it:
 *
 *   1. the owner is recognised three ways (seeded zero-UUID, her email in any
 *      Gmail dot-variant, the OWNER_MASTER tier) and keeps Scene,
 *   2. a client — including an unlimited BETA_TESTER — is refused,
 *   3. an omitted `mode` is refused too, because the pipeline renders it as
 *      Scene (that omission is how the Studio route reaches the paid path),
 *   4. a FACELESS request is never refused by this gate (the live mode must not
 *      be collateral damage),
 *   5. the REAL renderer refuses a client with a typed error BEFORE the planner
 *      or any image/motion/audio provider is called.
 *
 * It is safe to run: the gate fires before any paid provider call, and the
 * refusal path writes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSceneAllowedForUser,
  sceneAllowedForIdentity,
  sceneParkedForRequest,
  sceneRefusalBody,
  isSceneUnavailableError,
  SceneUnavailableError,
  SCENE_PARKED_CODE,
  SCENE_PARKED_MESSAGE,
} from '../sceneAccess.js';
import { OWNER_USER_ID } from '../ownerIdentity.js';
import { sceneVideoPipelineService } from '../sceneVideoPipelineService.js';

/** A perfectly ordinary client account id (never the owner). */
const CLIENT_ID = '7c1e5b2a-9d34-4f68-a1b0-2c3d4e5f6a7b';

// ─── The owner keeps Scene ───────────────────────────────────────────────────

test('OWNER KEEPS SCENE: the seeded owner zero-UUID is still allowed to render', async () => {
  assert.equal(await isSceneAllowedForUser(OWNER_USER_ID), true);
  assert.equal(sceneAllowedForIdentity({ id: OWNER_USER_ID }), true);
});

test('OWNER KEEPS SCENE: her email and OWNER_MASTER tier are allowed too', () => {
  assert.equal(sceneAllowedForIdentity({ id: 'x', email: 'Staci.Peabody@Gmail.com' }), true);
  assert.equal(sceneAllowedForIdentity({ id: 'x', email: 'stacipeabody@gmail.com' }), true);
  assert.equal(sceneAllowedForIdentity({ id: 'x', tier: 'OWNER_MASTER' }), true);
});

test('OWNER KEEPS SCENE: the renderer rule lets the owner through', () => {
  assert.equal(sceneParkedForRequest('scene', true), false);
  assert.equal(sceneParkedForRequest(undefined, true), false);
});

// ─── A client is refused ─────────────────────────────────────────────────────

test('A CLIENT IS REFUSED: a real client uuid is not allowed', async () => {
  assert.equal(await isSceneAllowedForUser(CLIENT_ID), false);
});

test('A CLIENT IS REFUSED: missing / sentinel / non-uuid identities fail closed', async () => {
  for (const id of ['', '   ', 'system', 'anonymous', 'not-a-uuid', null, undefined]) {
    assert.equal(await isSceneAllowedForUser(id as any), false, `expected refusal for ${JSON.stringify(id)}`);
  }
});

test('A CLIENT IS REFUSED: an unlimited BETA_TESTER is still a client, not the owner', () => {
  assert.equal(sceneAllowedForIdentity({ id: 'x', tier: 'BETA_TESTER', email: 'beta@example.com' }), false);
});

test('A CLIENT IS REFUSED: an OMITTED mode is refused, because it renders as Scene', () => {
  // The Studio route never passes `mode`, so this is the shape of a real client
  // request. It must not fall through into a paid Scene render.
  assert.equal(sceneParkedForRequest(undefined, false), true);
  assert.equal(sceneParkedForRequest(null, false), true);
  assert.equal(sceneParkedForRequest('scene', false), true);
});

test('FACELESS IS NOT REFUSED: the live mode is never collateral damage', () => {
  // Same client, same account: Faceless still renders. If this ever flips, a
  // parked Scene has broken the one mode the business launches on.
  assert.equal(sceneParkedForRequest('faceless', false), false);
  assert.equal(sceneParkedForRequest('faceless', true), false);
});

// ─── The renderer is the choke point ─────────────────────────────────────────

test('THE RENDERER REFUSES A CLIENT before any provider call, with a typed error', async () => {
  const started = Date.now();
  await assert.rejects(
    () => sceneVideoPipelineService.createProject({
      userId: CLIENT_ID,
      title: 'Anything at all',
      idea: 'A happy family spending time together in a bright kitchen',
      durationTarget: 30,
    } as any),
    (err: any) => {
      assert.equal(isSceneUnavailableError(err), true, 'refusal must carry the SCENE_UNAVAILABLE code');
      assert.ok(err instanceof SceneUnavailableError);
      assert.equal(err.message, SCENE_PARKED_MESSAGE);
      return true;
    },
  );
  // No planner, no image, no motion, no audio: a refusal is immediate.
  assert.ok(Date.now() - started < 5000, 'the refusal must not wait on a provider');
});

test('THE RENDERER REFUSES A CLIENT who asks for Scene explicitly, too', async () => {
  await assert.rejects(
    () => sceneVideoPipelineService.createProject({
      userId: CLIENT_ID,
      title: 'Explicit scene',
      idea: 'A happy family spending time together',
      durationTarget: 30,
      mode: 'scene',
    } as any),
    (err: any) => isSceneUnavailableError(err),
  );
});

// ─── The answer a refused client receives ────────────────────────────────────

test('THE REFUSAL BODY is the one sentence, in the shape the client UI renders', () => {
  const body = sceneRefusalBody();
  assert.equal(body.status, 'error');
  assert.equal(body.code, SCENE_PARKED_CODE);
  assert.equal(body.error, SCENE_PARKED_MESSAGE);
  // Plain words, no internals: no stack, no provider name, no code path.
  assert.doesNotMatch(SCENE_PARKED_MESSAGE, /undefined|TypeError|stack|api key|token|sora|veo/i);
  assert.match(SCENE_PARKED_MESSAGE, /paused/i);
  assert.match(SCENE_PARKED_MESSAGE, /Faceless videos still work/i);
});
