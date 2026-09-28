/**
 * Regression (owner Sep 28 follow-up, task 9b45d92b): completion/failure MUST
 * merge into the project's LIVE metadata — the row state AFTER mid-run writers
 * (persistVeoTakeOperation / markVeoJobStatus / soraJobs) have added veoJobs /
 * soraJobs — NOT the stale in-memory `pmeta` snapshot taken at processProject
 * start. Merging into the stale snapshot re-stamps the OLD base and WIPES the
 * live veoJobs/soraJobs at completion (breaks exactly-once resume + regenerate
 * voicing). Pure deterministic — no DB, no paid renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCompletionMetadata } from '../sceneVideoPipelineService.js';

test('LIVE metadata beats the stale start snapshot when both are merged (wipe fix)', () => {
  // Snapshot captured at worker start — before Veo window takes persisted jobs.
  const staleSnapshot = {
    voice: 'female',
    tone: 'serious',
    plan: { scenes: [{ sceneNumber: 1, duration: 5 }] },
    // NO veoJobs — they were persisted to the DB row AFTER this snapshot.
  };
  // The DB row at completion time (what liveProjectMetadata() re-reads):
  const liveRowMetadata = {
    ...staleSnapshot,
    veoJobs: {
      span_1: { operation: 'projects/veo-abc', status: 'completed', createdAt: '2026-09-28T00:00:00.000Z' },
    },
  };
  const completeMeta = mergeCompletionMetadata(liveRowMetadata, {
    sceneCount: 1,
    totalDuration: 5,
    variantExportCount: 3,
  });
  // The live veoJobs MUST survive the completion write:
  assert.ok(completeMeta.veoJobs, 'veoJobs missing — live metadata was wiped');
  assert.equal((completeMeta.veoJobs as { span_1: { status: string } }).span_1.status, 'completed');
  assert.equal(completeMeta.voice, 'female');
  assert.equal(completeMeta.sceneCount, 1);
});

test('stale-snapshot-only merge (old bug) WOULD lose veoJobs — pins why we re-read live', () => {
  const staleSnapshot = { voice: 'female', plan: { scenes: [] } };
  const buggyMeta = mergeCompletionMetadata(staleSnapshot, { sceneCount: 2 });
  assert.equal(buggyMeta.voice, 'female'); // create-time fields survive even via stale base
  assert.equal(buggyMeta.veoJobs, undefined); // but mid-run additions are gone — the bug
});