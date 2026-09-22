/**
 * Locked quota model (owner Sep 18) — regression guard for the reporting fix
 * (task 76a1c47e): cinemaController.getUsage used to hardcode limit:7 for
 * customize/faceless/neural while the backend actually enforced 4/10/5, so
 * Studio chips lied. The controller now reads the SAME exported constants the
 * enforcement path uses — these tests pin those constants so the two can never
 * drift again. No DB: the non-UUID fast path returns the full allowance without
 * querying Postgres.
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

test('locked weekly/monthly limits are 4/10/5/50 (owner Sep 18 model)', () => {
  assert.equal(WEEKLY_SCENE_LIMIT, 4);      // customize_video (Scene-Based)
  assert.equal(WEEKLY_FACELESS_LIMIT, 10);  // faceless
  assert.equal(WEEKLY_TWIN_LIMIT, 5);       // neural_twin
  assert.equal(MONTHLY_DESIGN_LIMIT, 50);   // high_res_design
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