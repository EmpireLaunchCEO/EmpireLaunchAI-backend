/**
 * Faceless draft-mode fix (cross-stamping diagnosis 717c9194 → task 77847655):
 * completion drafts for the Operations feed must carry the project's REAL engine
 * mode, not the hardcoded 'scene' that made every Faceless submission consume a
 * Scene quota slot (usageService counts DISTINCT projectId WHERE
 * payload->>'mode'='scene'). Pure deterministic helper — no DB, no paid renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftBase } from '../sceneVideoPipelineService.js';

test('faceless project: completion drafts carry mode faceless + category faceless-video', () => {
  const base = buildDraftBase('proj-faceless-1', { mode: 'faceless', voice: 'female' });
  assert.equal(base.projectId, 'proj-faceless-1');
  assert.equal(base.mode, 'faceless');
  assert.equal(base.category, 'faceless-video');
  assert.equal(base.provider, 'ffmpeg');
  assert.equal(base.saved, false);
});

test('faceless draft is EXCLUDED from the Scene quota count (payload.mode != scene)', () => {
  // Exact predicate used by usageService.getDailyRemaining('customize_video'):
  //   SELECT DISTINCT payload->>'projectId' FROM approvals
  //   WHERE payload->>'mode' = 'scene'  AND payload->>'projectId' IS NOT NULL
  const facelessBase = buildDraftBase('proj-faceless-2', { mode: 'faceless' });
  const sceneBase = buildDraftBase('proj-scene-1', { mode: 'scene' });
  const scenePids = [
    { pid: facelessBase.projectId, mode: facelessBase.mode },
    { pid: sceneBase.projectId, mode: sceneBase.mode },
  ]
    .filter((r) => r.mode === 'scene')
    .map((r) => r.pid);
  assert.deepEqual(scenePids, ['proj-scene-1']);
  assert.equal(scenePids.includes('proj-faceless-2'), false);
});

test('scene project: completion drafts keep mode scene and NO faceless category', () => {
  const base = buildDraftBase('proj-scene-2', { mode: 'scene', voice: 'male' });
  assert.equal(base.mode, 'scene');
  assert.equal('category' in base, false);
  assert.equal(base.projectId, 'proj-scene-2');
});

test('legacy project without persisted mode defaults to scene (pre-fix behavior preserved)', () => {
  // Projects created before create-time metadata persisted `mode` must keep the
  // old default so existing drafts/quota counting are unaffected.
  assert.equal(buildDraftBase('proj-legacy', undefined).mode, 'scene');
  assert.equal(buildDraftBase('proj-legacy', null).mode, 'scene');
  assert.equal(buildDraftBase('proj-legacy', { voice: 'male' }).mode, 'scene');
  assert.equal(buildDraftBase('proj-legacy', {}).mode, 'scene');
});

test('qc report attached only when present (never blocks)', () => {
  const withQc = buildDraftBase('proj-1', { mode: 'scene' }, { ok: true, flags: [] });
  assert.deepEqual(withQc.qc, { ok: true, flags: [] });
  const noQc = buildDraftBase('proj-2', { mode: 'faceless' }, undefined);
  assert.equal('qc' in noQc, false);
  assert.equal('qc' in buildDraftBase('proj-3', { mode: 'scene' }, null), false);
});