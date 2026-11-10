/**
 * NEURAL TWIN IS PARKED (owner Nov 9) — Twin is hidden from client accounts and
 * still working for the owner while its renderer is rebuilt.
 *
 * The rule this file exists to hold: HIDDEN MUST NOT MEAN MERELY INVISIBLE. A
 * client with an old page still open, or anyone calling the API directly, must
 * be refused on the server with a plain sentence — not handed a 500, not handed
 * a video, and not allowed to spend a cent of provider money on the way to being
 * refused. The owner's own account must keep reaching the renderer untouched.
 *
 * The refusal is asserted on the REAL renderer and the REAL route path, and it
 * is safe to run: the gate fires before any image/audio provider is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTwinAllowedForUser,
  twinAllowedForIdentity,
  twinRefusalBody,
  isTwinUnavailableError,
  TwinUnavailableError,
  TWIN_PARKED_CODE,
  TWIN_PARKED_MESSAGE,
} from '../twinAccess.js';
import { OWNER_USER_ID } from '../ownerIdentity.js';
import { cinemaEngineService } from '../cinemaEngineService.js';
import { cinemaController } from '../../controllers/cinemaController.js';

/** A perfectly ordinary client account id (never the owner). */
const CLIENT_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

// ─── The owner keeps Twin ────────────────────────────────────────────────────

test('OWNER KEEPS TWIN: the seeded owner zero-UUID is still allowed to render', async () => {
  assert.equal(await isTwinAllowedForUser(OWNER_USER_ID), true);
  assert.equal(twinAllowedForIdentity({ id: OWNER_USER_ID }), true);
});

test('OWNER KEEPS TWIN: her email and OWNER_MASTER tier are allowed too', () => {
  assert.equal(twinAllowedForIdentity({ id: 'x', email: 'Staci.Peabody@Gmail.com' }), true);
  assert.equal(twinAllowedForIdentity({ id: 'x', email: 'stacipeabody@gmail.com' }), true);
  assert.equal(twinAllowedForIdentity({ id: 'x', tier: 'OWNER_MASTER' }), true);
});

// ─── A client is refused ─────────────────────────────────────────────────────

test('A CLIENT IS REFUSED: a real client uuid is not allowed', async () => {
  assert.equal(await isTwinAllowedForUser(CLIENT_ID), false);
});

test('A CLIENT IS REFUSED: missing / sentinel / non-uuid identities fail closed', async () => {
  for (const id of ['', '   ', 'system', 'anonymous', 'not-a-uuid', null, undefined]) {
    assert.equal(await isTwinAllowedForUser(id as any), false, `expected refusal for ${JSON.stringify(id)}`);
  }
});

test('A CLIENT IS REFUSED: an unlimited BETA_TESTER is still a client, not the owner', () => {
  assert.equal(twinAllowedForIdentity({ id: 'x', tier: 'BETA_TESTER', email: 'beta@example.com' }), false);
});

// ─── The renderer is the choke point ─────────────────────────────────────────

test('THE RENDERER REFUSES A CLIENT before any provider call, with a typed error', async () => {
  await assert.rejects(
    () => cinemaEngineService.createNeuralTwin({
      userId: CLIENT_ID,
      photoUrl: '/tmp/does-not-matter.png',
      script: 'Anything at all',
    } as any),
    (err: any) => {
      assert.equal(isTwinUnavailableError(err), true, 'refusal must carry the TWIN_UNAVAILABLE code');
      assert.ok(err instanceof TwinUnavailableError);
      assert.equal(err.message, TWIN_PARKED_MESSAGE);
      return true;
    },
  );
});

// ─── The route a real request takes answers 403 + plain words ────────────────

test('THE REAL ROUTE PATH answers a client with 403 and the plain-language reason', async () => {
  const captured: { status?: number; body?: any } = {};
  const req: any = {
    body: { userId: CLIENT_ID, photoUrl: '/tmp/does-not-matter.png', script: 'Anything at all' },
    query: {},
    headers: {},
  };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(body: any) { captured.body = body; return res; },
  };

  await cinemaController.createNeuralTwin(req, res);

  assert.equal(captured.status, 403, 'a hidden Twin must be refused, not merely not-shown');
  assert.equal(captured.body?.code, TWIN_PARKED_CODE);
  assert.equal(captured.body?.error, TWIN_PARKED_MESSAGE);
  // Plain words, no internals: it must not leak a stack, a provider name or a code path.
  assert.doesNotMatch(TWIN_PARKED_MESSAGE, /undefined|TypeError|stack|api key|token/i);
  assert.match(TWIN_PARKED_MESSAGE, /paused/i);
  assert.match(TWIN_PARKED_MESSAGE, /Scene-Based and Faceless videos still work/i);
});

test('THE REFUSAL BODY is the one sentence, in the shape the client UI renders', () => {
  const body = twinRefusalBody();
  assert.equal(body.status, 'error');
  assert.equal(body.code, TWIN_PARKED_CODE);
  assert.equal(body.error, TWIN_PARKED_MESSAGE);
});
