/**
 * Locked quota model (owner Sep 24 rebalance) — regression guard for the
 * reporting fix (task 76a1c47e): cinemaController.getUsage used to hardcode
 * limit:7 for customize/faceless/neural while the backend actually enforced
 * 4/10/5, so Studio chips lied. The controller now reads the SAME exported
 * constants the enforcement path uses — these tests pin those constants so the
 * two can never drift again. Values (owner Sep 24; Faceless raised by the owner's
 * Nov 19 decision to 60/month = 15/wk): Scene 2/wk (8/mo), Faceless 15/wk
 * (60/mo), Twin 5/wk (20/mo), Design 50/mo. No DB: the non-UUID fast path
 * returns the full allowance without querying Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKLY_SCENE_LIMIT,
  WEEKLY_FACELESS_LIMIT,
  WEEKLY_TWIN_LIMIT,
  MONTHLY_DESIGN_LIMIT,
  usageService,
} from '../usageService.js';

test('locked weekly/monthly limits are 2/15/5/50 (owner Sep 24 rebalance; Faceless 60/mo Nov 19)', () => {
  assert.equal(WEEKLY_SCENE_LIMIT, 2);      // customize_video (Scene-Based) — 8/mo
  assert.equal(WEEKLY_FACELESS_LIMIT, 15);  // faceless — 60/mo (owner: 60/month)
  assert.equal(WEEKLY_TWIN_LIMIT, 5);       // neural_twin — 20/mo
  assert.equal(MONTHLY_DESIGN_LIMIT, 50);   // high_res_design
});

test('monthly derivation matches the owner-approved model (2/15/5 weekly → 8/60/20 monthly)', () => {
  assert.equal(WEEKLY_SCENE_LIMIT * 4, 8);      // Scene 2/wk → 8/mo
  assert.equal(WEEKLY_FACELESS_LIMIT * 4, 60);  // Faceless 15/wk → 60/mo
  assert.equal(WEEKLY_TWIN_LIMIT * 4, 20);      // Twin 5/wk → 20/mo
  assert.equal(MONTHLY_DESIGN_LIMIT, 50);       // Design 50/mo (unchanged)
});

test('getDailyRemaining non-UUID path reports the SAME constants (enforcement == reporting)', async () => {
  // Non-UUID callers get the full allowance without any DB query — this is the
  // exact branch the endpoint relies on for anonymous/resolveUserId failures,
  // and it must agree with the constants the controller reports as `limit`.
  assert.equal(await usageService.getDailyRemaining('anonymous', 'customize_video'), WEEKLY_SCENE_LIMIT);
  assert.equal(await usageService.getDailyRemaining('anonymous', 'faceless'), WEEKLY_FACELESS_LIMIT);
  assert.equal(await usageService.getDailyRemaining('anonymous', 'neural_twin'), WEEKLY_TWIN_LIMIT);
  assert.equal(await usageService.getDailyRemaining('anonymous', 'high_res_design'), MONTHLY_DESIGN_LIMIT);
  assert.equal(await usageService.getDailyRemaining('anonymous', 'enhanced_video'), 'unlimited');
  assert.equal(await usageService.getDailyRemaining('anonymous', 'edits'), 'unlimited');
});