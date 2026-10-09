/**
 * Unit tests for collectApprovalSweepIds — the DELETE /api/studio/creation/:id
 * approval sweep set (ghost-card fix, owner Oct 9). Pure, no DB, no paid calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectApprovalSweepIds } from '../deleteApprovalSweep.js';

test('collectApprovalSweepIds: keeps faceless + scene + project ids of a run', () => {
  const ids = collectApprovalSweepIds({
    creationId: 'creation-1',
    projectId: 'proj-1',
    sceneIds: ['scene-a', 'scene-b', 'scene-c', 'scene-d'],
    approvalAssetId: 'proj-1',
    approvalProjectId: 'proj-1',
  });
  assert.deepEqual(ids, ['creation-1', 'proj-1', 'scene-a', 'scene-b', 'scene-c', 'scene-d']);
});

test('collectApprovalSweepIds: dedupes overlapping namespaces (project appears 3x)', () => {
  const ids = collectApprovalSweepIds({
    creationId: 'proj-1',
    projectId: 'proj-1',
    sceneIds: [],
    approvalAssetId: 'proj-1',
    approvalProjectId: 'proj-1',
  });
  assert.deepEqual(ids, ['proj-1']);
});

test('collectApprovalSweepIds: drops null/undefined (orphan-approval click, no project)', () => {
  const ids = collectApprovalSweepIds({
    creationId: null,
    projectId: undefined,
    sceneIds: undefined,
    approvalAssetId: 'orphan-run-id',
    approvalProjectId: null,
  });
  assert.deepEqual(ids, ['orphan-run-id']);
});

test('collectApprovalSweepIds: scene ids are kept even without a project (never lose receipts)', () => {
  const ids = collectApprovalSweepIds({
    creationId: undefined,
    projectId: null,
    sceneIds: ['scene-z'],
    approvalAssetId: 'scene-z',
    approvalProjectId: undefined,
  });
  assert.deepEqual(ids, ['scene-z']);
});

test('collectApprovalSweepIds: empty run input yields empty sweep (route early-returns)', () => {
  const ids = collectApprovalSweepIds({});
  assert.deepEqual(ids, []);
});