/**
 * Defect 3 (owner Faceless test, 2026-09-21) — regression tests:
 * pipeline completion/failure MUST merge into the project's existing create-time
 * metadata (voice, tone, conversation, components, plan, veoJobs) instead of
 * REPLACING it. The old behavior wiped those fields at completion
 * (metadata = { sceneCount, totalDuration, variantExportCount }), so
 * regenerateScene read pmeta.voice/pmeta.tone → undefined → silently defaulted
 * to nova, and the Veo exactly-once operation registry (metadata.veoJobs) was
 * destroyed. Pure deterministic helper — no DB, no paid renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCompletionMetadata } from '../sceneVideoPipelineService.js';

test('completion merge PRESERVES create-time metadata fields (voice/tone/plan/veoJobs)', () => {
  const prior = {
    voice: 'female' as const,
    tone: 'serious' as const,
    conversation: [{ role: 'user', content: 'scented candles for pet owners' }],
    components: ['CTA', 'colors'],
    componentsVerified: true,
    plan: { scenes: [{ sceneNumber: 1, duration: 5 }] },
    veoJobs: [{ operation: 'projects/veo-abc', status: 'in_progress' }],
  };
  const merged = mergeCompletionMetadata(prior, {
    sceneCount: 3,
    totalDuration: 15,
    variantExportCount: 3,
  });
  // Prior fields survive untouched:
  assert.equal(merged.voice, 'female');
  assert.equal(merged.tone, 'serious');
  assert.deepEqual(merged.plan, { scenes: [{ sceneNumber: 1, duration: 5 }] });
  assert.deepEqual(merged.veoJobs, [{ operation: 'projects/veo-abc', status: 'in_progress' }]);
  assert.deepEqual(merged.components, ['CTA', 'colors']);
  assert.equal(merged.componentsVerified, true);
  // Completion fields are present:
  assert.equal(merged.sceneCount, 3);
  assert.equal(merged.totalDuration, 15);
  assert.equal(merged.variantExportCount, 3);
});

test('completion merge overrides a PRIOR value for the same key (sceneCount refresh)', () => {
  const merged = mergeCompletionMetadata(
    { sceneCount: 0, voice: 'male' },
    { sceneCount: 4, totalDuration: 30, variantExportCount: 3 },
  );
  assert.equal(merged.sceneCount, 4);
  assert.equal(merged.voice, 'male');
});

test('merge with NO prior metadata (null/undefined) yields exactly the completion fields', () => {
  assert.deepEqual(mergeCompletionMetadata(undefined, { sceneCount: 2, totalDuration: 10, variantExportCount: 2 }), {
    sceneCount: 2,
    totalDuration: 10,
    variantExportCount: 2,
  });
  assert.deepEqual(mergeCompletionMetadata(null, { error: 'Assembly: boom', sceneCount: 1 }), {
    error: 'Assembly: boom',
    sceneCount: 1,
  });
});

test('merge does not mutate the prior object (no shared reference side effects)', () => {
  const prior = { voice: 'female', veoJobs: [{ op: 'x' }] };
  const copy = JSON.parse(JSON.stringify(prior));
  mergeCompletionMetadata(prior, { sceneCount: 1 });
  assert.deepEqual(prior, copy);
});