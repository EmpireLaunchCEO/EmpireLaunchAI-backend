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
import { readFileSync } from 'node:fs';
import { db, schema } from '../../db/index.js';

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

// ─── REGENERATING ONE SCENE IS A PAID RENDER TOO ─────────────────────────────
//
// Hiding the Scene box closed new Scene projects but left the per-scene door
// open: a client holding an OLD Scene project could still re-render one scene,
// which buys a still and a Veo window on a mode we have closed. These tests run
// the REAL `regenerateScene` — the method the route calls — with a stub DB and
// stubbed processScene/processProject, so the decision is measured on the path a
// real request takes, not on a copy of the rule.

const SCENE_ID = '0f9e4b2c-3d1a-4c5e-8b7a-9c1d2e3f4a5b';
const PROJECT_ID = '5a2b7c8d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';

/**
 * Install a stub DB (scene + project, no users row — so a client resolves to
 * non-owner) and spies on the two paid stages, for one call of regenerateScene.
 * Restore always runs, so nothing leaks into the other tests in this file.
 */
function installRegenerationStubs(callerId: string, projectMetadata: any) {
  const scene = { id: SCENE_ID, projectId: PROJECT_ID, sceneNumber: 1, status: 'pending', duration: 5, assetUrl: null, audioUrl: null };
  const project = { id: PROJECT_ID, userId: callerId, status: 'completed', metadata: projectMetadata, finalVideoUrl: null, thumbnailUrl: null };
  const rowsFor = (table: any) =>
    table === schema.videoScenes ? [scene] : table === schema.videoProjects ? [project] : [];
  const realSelect = (db as any).select;
  (db as any).select = () => {
    let table: any = null;
    const builder: any = {
      from(t: any) { table = t; return builder; },
      where() { return builder; },
      orderBy() { return Promise.resolve(rowsFor(table)); },
      limit() { return Promise.resolve(rowsFor(table)); },
      then(ok: any, bad: any) { return Promise.resolve(rowsFor(table)).then(ok, bad); },
    };
    return builder;
  };
  const svc: any = sceneVideoPipelineService;
  const realProcessScene = svc.processScene;
  const realProcessProject = svc.processProject;
  const calls: string[] = [];
  svc.processScene = async () => { calls.push('processScene'); };
  svc.processProject = async () => { calls.push('processProject'); };
  return {
    calls,
    restore() {
      (db as any).select = realSelect;
      svc.processScene = realProcessScene;
      svc.processProject = realProcessProject;
    },
  };
}

test('REGENERATION IS REFUSED: a client re-rendering an OLD Scene project is stopped before any paid stage', async () => {
  const stubs = installRegenerationStubs(CLIENT_ID, { mode: 'scene', voice: 'female' });
  try {
    const started = Date.now();
    await assert.rejects(
      () => sceneVideoPipelineService.regenerateScene(SCENE_ID, CLIENT_ID),
      (err: any) => {
        assert.equal(isSceneUnavailableError(err), true, 'regeneration must raise the SCENE_UNAVAILABLE refusal');
        assert.equal(err.message, SCENE_PARKED_MESSAGE);
        return true;
      },
    );
    // No still, no Veo window, no assembly: the door closes before the spend.
    assert.deepEqual(stubs.calls, [], 'no paid stage may run for a refused regeneration');
    assert.ok(Date.now() - started < 5000, 'the refusal must not wait on a provider');
  } finally {
    stubs.restore();
  }
});

test('REGENERATION IS REFUSED: a legacy Scene project with no stored mode is refused too', async () => {
  // A project row from before `mode` was persisted renders as Scene, so it is
  // refused rather than defaulted into a paid Scene render.
  const stubs = installRegenerationStubs(CLIENT_ID, {});
  try {
    await assert.rejects(
      () => sceneVideoPipelineService.regenerateScene(SCENE_ID, CLIENT_ID),
      (err: any) => isSceneUnavailableError(err),
    );
    assert.deepEqual(stubs.calls, []);
  } finally {
    stubs.restore();
  }
});

test("REGENERATION STILL WORKS: the owner re-renders her own Scene project", async () => {
  const stubs = installRegenerationStubs(OWNER_USER_ID, { mode: 'scene', voice: 'female' });
  try {
    const projectId = await sceneVideoPipelineService.regenerateScene(SCENE_ID, OWNER_USER_ID);
    assert.equal(projectId, PROJECT_ID, 'the owner gets a project back, not a refusal');
    assert.deepEqual(stubs.calls, ['processScene', 'processProject'], 'the owner reaches the real render stages');
  } finally {
    stubs.restore();
  }
});

test('REGENERATION STILL WORKS: a client re-renders a FACELESS project — the live mode is never collateral damage', async () => {
  const stubs = installRegenerationStubs(CLIENT_ID, { mode: 'faceless', voice: 'female' });
  try {
    const projectId = await sceneVideoPipelineService.regenerateScene(SCENE_ID, CLIENT_ID);
    assert.equal(projectId, PROJECT_ID);
    assert.deepEqual(stubs.calls, ['processScene', 'processProject'], 'Faceless regeneration is untouched by the Scene park');
  } finally {
    stubs.restore();
  }
});

test('THE GATE IS ON THE REGENERATION PATH: the refusal is checked before processScene is called', () => {
  const src = readFileSync(new URL('../sceneVideoPipelineService.ts', import.meta.url), 'utf8');
  const regen = src.slice(src.indexOf('async regenerateScene('));
  const gate = regen.indexOf('sceneParkedForRequest(pmeta?.mode');
  assert.ok(gate > 0, 'regenerateScene must apply the one parked-Scene rule');
  assert.ok(gate < regen.indexOf('this.processScene('), 'the gate must run before the paid render');
  assert.ok(gate < regen.indexOf('this.processProject('), 'the gate must run before assembly');
});
