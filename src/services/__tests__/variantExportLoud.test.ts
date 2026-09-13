import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variantExportIssue } from '../sceneVideoPipelineService.js';

// ─── Variant-export loud-failure policy (owner run b5f88145) ─────────────
// Variants are a product feature: a 0-variant result while the local source
// exists and R2 is up is a DEFECT and must surface (trace + project metadata),
// never a silent count=0 skip. These tests pin that policy + the reorder guard.

test('variantExportIssue: 3/3 variants produced → no issue (undefined)', () => {
  assert.equal(variantExportIssue(3, true, true), undefined);
});

test('variantExportIssue: partial 2/3 → not a silent-zero, no issue raised', () => {
  // Partial failures are already traced per-variant inside the export service.
  assert.equal(variantExportIssue(2, true, true), undefined);
});

test('variantExportIssue: R2 unavailable → stage legitimately no-ops (undefined)', () => {
  // With R2 off there is nowhere to publish variants; not a defect.
  assert.equal(variantExportIssue(0, false, true), undefined);
});

test('variantExportIssue: source present + R2 up + 0 variants → LOUD error', () => {
  const issue = variantExportIssue(0, true, true);
  assert.ok(issue, 'expected an issue to be reported');
  assert.match(issue, /0\/3 variants exported/);
});

test('variantExportIssue: source missing → LOUD error (reorder guard)', () => {
  // After the fix the variant pass runs BEFORE the master upload, so the source
  // must exist; if it does not, that is a loud defect — never a silent skip.
  const issue = variantExportIssue(0, true, false);
  assert.ok(issue, 'expected an issue to be reported');
  assert.match(issue, /source missing/);
});

test('variantExportIssue: source missing but R2 off → still no issue (no publish target)', () => {
  assert.equal(variantExportIssue(0, false, false), undefined);
});