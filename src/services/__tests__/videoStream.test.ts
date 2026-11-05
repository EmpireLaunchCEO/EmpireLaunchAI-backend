/**
 * Unit tests for the finished-video streaming logic
 * (GET /api/studio/video/:projectId/stream).
 *
 * NO paid renders, NO DB, NO network — every rule under test is pure. The route
 * itself only wires these helpers to Postgres + R2; the decisions a browser
 * actually feels (which status, which Content-Type, which byte window) live here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStreamTarget,
  extractR2KeyFromUrl,
  parseByteRange,
  buildStreamHeaders,
  inlineDisposition,
  s3RangeHeader,
  authorizeStreamAccess,
  streamNotFoundBody,
  streamUserIdRequiredBody,
  StreamProjectLike,
} from '../videoStreamService.js';

// The owner's stuck case: project 5365af90 rendered nothing — status FAILED,
// final_video_url NULL, no usable key in metadata.
const failedNoVideo: StreamProjectLike = {
  id: '5365af90-59a2-4fc6-9e2a-9f066a0305f9',
  status: 'failed',
  finalVideoUrl: null,
  metadata: { error: 'Stream map 0:v:0 matches no streams' },
};

const completedWithUrl: StreamProjectLike = {
  id: 'f3773f0a-0000-4000-8000-000000000000',
  status: 'completed',
  finalVideoUrl: 'https://acct.r2.cloudflarestorage.com/empirelaunchai/brands/u/video-projects/abc.mp4?X-Amz-Signature=deadbeef',
  metadata: {},
};

// Legacy row: final_video_url holds a dead local path, the real key survived in metadata.
const legacyLocalPathWithMetaKey: StreamProjectLike = {
  id: 'f3773f0a-0000-4000-8000-000000000001',
  status: 'completed',
  finalVideoUrl: '/assets/cinema/renders/twin_x.mp4',
  metadata: { r2Key: 'brands/u/video-projects/legacy.mp4' },
};

const stillGenerating: StreamProjectLike = {
  id: 'f3773f0a-0000-4000-8000-000000000002',
  status: 'assembling',
  finalVideoUrl: null,
  metadata: {},
};

// ─── project lookup → stream target ─────────────────────────────────────────

test('resolveStreamTarget: completed project with an R2 URL → ok + bucket key', () => {
  const t = resolveStreamTarget(completedWithUrl);
  assert.equal(t.kind, 'ok');
  if (t.kind === 'ok') assert.equal(t.r2Key, 'brands/u/video-projects/abc.mp4');
});

test('resolveStreamTarget: no project row → readable 404 (not an HTML page)', () => {
  const t = resolveStreamTarget(null);
  assert.equal(t.kind, 'not-found');
  assert.equal(t.status, 404);
  assert.match(String(t.body.error), /No video project with that id/);
});

test('resolveStreamTarget: failed project with no file → 404 with plain words', () => {
  const t = resolveStreamTarget(failedNoVideo);
  assert.equal(t.kind, 'no-video');
  assert.equal(t.status, 404);
  assert.equal(t.body.failed, true);
  assert.equal(t.body.processing, false);
  assert.match(String(t.body.error), /did not finish rendering/);
  assert.equal(t.body.id, failedNoVideo.id);
});

test('resolveStreamTarget: still rendering → 404 that says it is still being made', () => {
  const t = resolveStreamTarget(stillGenerating);
  assert.equal(t.kind, 'no-video');
  assert.equal(t.body.processing, true);
  assert.equal(t.body.failed, false);
  assert.match(String(t.body.error), /still being made/);
});

test('resolveStreamTarget: dead local path rescued by metadata.r2Key', () => {
  const t = resolveStreamTarget(legacyLocalPathWithMetaKey);
  assert.equal(t.kind, 'ok');
  if (t.kind === 'ok') assert.equal(t.r2Key, 'brands/u/video-projects/legacy.mp4');
});

test('resolveStreamTarget: metadata.finalVideoUrl is a last-resort fallback', () => {
  const t = resolveStreamTarget({
    id: 'f3773f0a-0000-4000-8000-000000000003',
    status: 'completed',
    finalVideoUrl: null,
    metadata: { finalVideoUrl: 'https://acct.r2.cloudflarestorage.com/empirelaunchai/brands/u/v.mp4' },
  });
  assert.equal(t.kind, 'ok');
  if (t.kind === 'ok') assert.equal(t.r2Key, 'brands/u/v.mp4');
});

test('extractR2KeyFromUrl: bare local path is NOT a key (would 404 from the backend)', () => {
  assert.equal(extractR2KeyFromUrl('/assets/cinema/renders/x.mp4'), null);
  assert.equal(extractR2KeyFromUrl(null), null);
  assert.equal(extractR2KeyFromUrl(''), null);
});

test('extractR2KeyFromUrl: presigned URL drops the query string', () => {
  assert.equal(
    extractR2KeyFromUrl('https://acct.r2.cloudflarestorage.com/bucket/brands/b/video-projects/x.mp4?X-Amz-Signature=1'),
    'brands/b/video-projects/x.mp4',
  );
});

// ─── byte ranges (browsers cannot seek without these) ───────────────────────

test('parseByteRange: no header → whole file', () => {
  assert.equal(parseByteRange(null, 1000), 'none');
  assert.equal(parseByteRange(undefined, 1000), 'none');
  assert.equal(parseByteRange('', 1000), 'none');
});

test('parseByteRange: bytes=0-99 → first 100 bytes', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 });
});

test('parseByteRange: open-ended bytes=500- → to the last byte', () => {
  assert.deepEqual(parseByteRange('bytes=500-', 1000), { start: 500, end: 999 });
});

test('parseByteRange: suffix bytes=-100 → last 100 bytes', () => {
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 });
});

test('parseByteRange: end beyond size is clamped, not rejected', () => {
  assert.deepEqual(parseByteRange('bytes=0-99999', 1000), { start: 0, end: 999 });
});

test('parseByteRange: start beyond size → unsatisfiable (416)', () => {
  assert.equal(parseByteRange('bytes=5000-', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=-0', 1000), 'unsatisfiable');
});

test('parseByteRange: multi-range reduced to the first range', () => {
  assert.deepEqual(parseByteRange('bytes=0-9,20-29', 1000), { start: 0, end: 9 });
});

test('s3RangeHeader: 206 window becomes an S3 Range, none/416 become undefined', () => {
  assert.equal(s3RangeHeader({ start: 0, end: 99 }), 'bytes=0-99');
  assert.equal(s3RangeHeader('none'), undefined);
  assert.equal(s3RangeHeader('unsatisfiable'), undefined);
});

// ─── response headers (the part a browser actually reads) ───────────────────

test('buildStreamHeaders: full request → 200, video/mp4, inline, Accept-Ranges', () => {
  const plan = buildStreamHeaders({ id: '5365af90-59a2-4fc6-9e2a-9f066a0305f9', size: 1234 });
  assert.equal(plan.status, 200);
  assert.equal(plan.headers['Content-Type'], 'video/mp4');
  assert.equal(plan.headers['Accept-Ranges'], 'bytes');
  assert.equal(plan.headers['Content-Length'], '1234');
  assert.match(plan.headers['Content-Disposition'], /^inline;/);
  assert.equal(plan.headers['Content-Range'], undefined);
});

test('buildStreamHeaders: Range request → 206 with an exact Content-Range', () => {
  const plan = buildStreamHeaders({ id: 'abc', size: 1000, rangeHeader: 'bytes=0-99' });
  assert.equal(plan.status, 206);
  assert.equal(plan.headers['Content-Range'], 'bytes 0-99/1000');
  assert.equal(plan.headers['Content-Length'], '100');
  assert.equal(plan.headers['Content-Type'], 'video/mp4');
  assert.equal(plan.headers['Content-Disposition'], inlineDisposition('abc'));
});

test('buildStreamHeaders: unsatisfiable Range → 416 advertising the real size', () => {
  const plan = buildStreamHeaders({ id: 'abc', size: 1000, rangeHeader: 'bytes=5000-' });
  assert.equal(plan.status, 416);
  assert.equal(plan.headers['Content-Range'], 'bytes */1000');
});

test('inlineDisposition: inline (play), not attachment (download)', () => {
  const d = inlineDisposition('5365af90-59a2-4fc6-9e2a-9f066a0305f9');
  assert.match(d, /^inline; /);
  assert.match(d, /\.mp4"$/);
  assert.ok(!d.startsWith('attachment'));
});

// ─── OWNERSHIP GATE (a project id is not a credential) ──────────────────────
//
// GET /api/studio/video/:projectId/stream must be scoped to the owner exactly
// like /api/studio/download/:id. Before this gate existed, anyone holding a
// project uuid could stream any client's finished video with no credential at
// all. These four branches are the whole fix.

const OWNER = '399ef884-0000-4000-8000-00000000000a';
const STRANGER = '7f1c2d3e-0000-4000-8000-00000000000b';

test('authorizeStreamAccess: no user id at all → 401 "userId required"', () => {
  for (const rawUid of [undefined, null, '', '   ']) {
    const d = authorizeStreamAccess({ rawUid, projectOwnerId: OWNER });
    assert.equal(d.kind, 'deny');
    if (d.kind !== 'deny') return;
    assert.equal(d.status, 401);
    assert.equal(d.body.error, 'userId required');
    assert.deepEqual(d.body, streamUserIdRequiredBody());
  }
});

test('authorizeStreamAccess: id supplied but not yet resolved → pass, NOT a 401', () => {
  // The route checks "did they tell us who they are?" before it resolves the id.
  // Treating "not resolved yet" as "resolved to nobody" made the owner's own
  // video answer 401 — this pins the distinction.
  const d = authorizeStreamAccess({ rawUid: OWNER });
  assert.equal(d.kind, 'pass');
});

test('authorizeStreamAccess: a supplied id that resolves to nobody → 401 "User not found"', () => {
  const d = authorizeStreamAccess({ rawUid: 'not-a-real-key', resolvedUserId: null, projectOwnerId: OWNER });
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.equal(d.status, 401);
  assert.equal(d.body.error, 'User not found');
});

test('authorizeStreamAccess: the owner asking for their own video → allow', () => {
  const d = authorizeStreamAccess({ rawUid: OWNER, resolvedUserId: OWNER, projectOwnerId: OWNER });
  assert.equal(d.kind, 'allow');
  if (d.kind === 'allow') assert.equal(d.userId, OWNER);
});

test('authorizeStreamAccess: a different user asking for it → 404, never 403', () => {
  const d = authorizeStreamAccess({ rawUid: STRANGER, resolvedUserId: STRANGER, projectOwnerId: OWNER });
  assert.equal(d.kind, 'deny');
  if (d.kind !== 'deny') return;
  assert.equal(d.status, 404);
  assert.notEqual(d.status, 403); // 403 would confirm the id is real
});

test('authorizeStreamAccess: wrong owner is BYTE-IDENTICAL to an unknown id (no existence leak)', () => {
  const wrongOwner = authorizeStreamAccess({ rawUid: STRANGER, resolvedUserId: STRANGER, projectOwnerId: OWNER });
  const unknownId = authorizeStreamAccess({ rawUid: STRANGER, resolvedUserId: STRANGER, projectOwnerId: null });
  const unknownViaLookup = resolveStreamTarget(null);
  assert.equal(wrongOwner.kind, 'deny');
  assert.equal(unknownId.kind, 'deny');
  if (wrongOwner.kind !== 'deny' || unknownId.kind !== 'deny') return;
  if (unknownViaLookup.kind === 'ok') return; // never the case for a missing row
  assert.deepEqual(wrongOwner.body, unknownId.body);
  assert.deepEqual(wrongOwner.body, streamNotFoundBody());
  assert.deepEqual(wrongOwner.body, unknownViaLookup.body);
  assert.equal(wrongOwner.status, unknownViaLookup.status);
});

test('authorizeStreamAccess: scoped query matched no row (unknown OR not-yours) → 404', () => {
  // The route filters on (id, userId); another user's project simply returns no
  // row, so both cases arrive here as projectOwnerId: null.
  const d = authorizeStreamAccess({ rawUid: OWNER, resolvedUserId: OWNER, projectOwnerId: null });
  assert.equal(d.kind, 'deny');
  if (d.kind === 'deny') assert.equal(d.status, 404);
});

test('authorizeStreamAccess: identity is compared exactly — case/whitespace cannot slip past', () => {
  const upper = authorizeStreamAccess({ rawUid: OWNER, resolvedUserId: OWNER, projectOwnerId: OWNER.toUpperCase() });
  assert.equal(upper.kind, 'deny');
  const padded = authorizeStreamAccess({ rawUid: `  ${OWNER}  `, resolvedUserId: OWNER, projectOwnerId: OWNER });
  assert.equal(padded.kind, 'allow');
});

test('authorizeStreamAccess: the three doors /download/:id accepts all reach the gate', () => {
  // ?userId= arrives as a string, a repeated query param as an array, x-user-id
  // as a header string. All three must be treated as "an id was supplied".
  const asQuery = authorizeStreamAccess({ rawUid: OWNER, resolvedUserId: OWNER, projectOwnerId: OWNER });
  const asArray = authorizeStreamAccess({ rawUid: [OWNER], resolvedUserId: OWNER, projectOwnerId: OWNER });
  const asHeader = authorizeStreamAccess({ rawUid: String(OWNER), resolvedUserId: OWNER, projectOwnerId: OWNER });
  assert.equal(asQuery.kind, 'allow');
  assert.equal(asArray.kind, 'allow');
  assert.equal(asHeader.kind, 'allow');
});
