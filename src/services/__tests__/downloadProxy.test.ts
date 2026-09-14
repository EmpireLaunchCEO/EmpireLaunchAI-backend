/**
 * Unit tests for the download-proxy resolve/guard logic (GET /api/studio/download/:id).
 * NO paid renders, NO DB, NO network — everything is pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDownload, downloadFailureBody, DownloadCreationLike, DownloadProjectLike } from '../downloadProxy.js';

const creationWithFile: DownloadCreationLike = { fileUrl: 'https://r2.example.com/brands/u/video.mp4', metadata: { r2Key: 'k1' } };
const creationNoFile: DownloadCreationLike = { fileUrl: null, metadata: { note: 'failed render' } };
const projectWithVideo: DownloadProjectLike = { finalVideoUrl: 'https://r2.example.com/brands/u/final.mp4', metadata: {} };
// The owner's exact stuck case: Scene project f3773f0a — status FAILED, final_video_url NULL.
const projectFailedNoVideo: DownloadProjectLike = { finalVideoUrl: null, metadata: { r2Key: null } };
const projectFailedStatus: DownloadProjectLike = { finalVideoUrl: null, metadata: {}, status: 'failed' };
const projectGenerating: DownloadProjectLike = { finalVideoUrl: null, metadata: {}, status: 'generating' };

test('classifyDownload: ok when creation has a fileUrl', () => {
  const d = classifyDownload(creationWithFile, null);
  assert.equal(d.kind, 'ok');
  if (d.kind === 'ok') {
    assert.equal(d.mediaUrl, creationWithFile.fileUrl);
    assert.deepEqual(d.meta, { r2Key: 'k1' });
  }
});

test('classifyDownload: ok when project has a finalVideoUrl', () => {
  const d = classifyDownload(null, projectWithVideo);
  assert.equal(d.kind, 'ok');
  if (d.kind === 'ok') assert.equal(d.mediaUrl, projectWithVideo.finalVideoUrl);
});

test('classifyDownload: no-media when creation exists without a file', () => {
  assert.equal(classifyDownload(creationNoFile, null).kind, 'no-media');
});

test('classifyDownload: no-media for a FAILED project with no final video (owner stuck case)', () => {
  assert.equal(classifyDownload(null, projectFailedNoVideo).kind, 'no-media');
});

test('classifyDownload: not-found only when no creation AND no project row', () => {
  assert.equal(classifyDownload(null, null).kind, 'not-found');
  assert.equal(classifyDownload(undefined, undefined).kind, 'not-found');
});

test('downloadFailureBody: no-media → 409 with clear message + failed flag + id', () => {
  const { status, body } = downloadFailureBody('f3773f0a-0000-0000-0000-000000000000', 'no-media');
  assert.equal(status, 409);
  assert.equal(body.error, 'This video failed to render — there is no file to download. Please regenerate it.');
  assert.equal(body.failed, true);
  assert.equal(body.id, 'f3773f0a-0000-0000-0000-000000000000');
});

test('downloadFailureBody: no-media with project status failed → failed:true + status echoed', () => {
  const { status, body } = downloadFailureBody('abc', 'no-media', { projectStatus: 'failed' });
  assert.equal(status, 409);
  assert.equal(body.failed, true);
  assert.equal(body.status, 'failed');
  assert.equal(body.error, 'This video failed to render — there is no file to download. Please regenerate it.');
});

test('downloadFailureBody: no-media with in-progress project status → processing:true, NOT failed', () => {
  for (const s of ['scripting', 'generating', 'assembling']) {
    const { status, body } = downloadFailureBody('abc', 'no-media', { projectStatus: s });
    assert.equal(status, 409);
    assert.equal(body.processing, true);
    assert.equal(body.failed, false);
    assert.equal(body.status, s);
    assert.equal(body.error, "This video is still being created and isn't ready to download yet. Please check back soon.");
  }
});

test('classifyDownload: no-media carries projectStatus (failed owner case)', () => {
  const d = classifyDownload(null, projectFailedNoVideo);
  assert.equal(d.kind, 'no-media');
  if (d.kind === 'no-media') assert.equal(d.projectStatus, null); // row has no status field
});

test('classifyDownload: no-media carries projectStatus (failed / generating)', () => {
  const failed = classifyDownload(null, projectFailedStatus);
  assert.equal(failed.kind, 'no-media');
  if (failed.kind === 'no-media') assert.equal(failed.projectStatus, 'failed');

  const generating = classifyDownload(null, projectGenerating);
  assert.equal(generating.kind, 'no-media');
  if (generating.kind === 'no-media') assert.equal(generating.projectStatus, 'generating');
});

// ─── Non-R2 local-path URLs (owner's "r2 fetch failed" bug) ────────────────
const creationLocalPath: DownloadCreationLike = {
  fileUrl: '/app/public/assets/cinema/sora/sora_1d41038b-95d2-425d-9edf-200172e94c6a.mp4',
  metadata: { r2Key: null },
};
const projectLocalPath: DownloadProjectLike = {
  finalVideoUrl: '/app/public/assets/cinema/sora/sora_x.mp4',
  metadata: { r2Key: null },
  status: 'failed',
};
const creationLocalPathWithKeyRescue: DownloadCreationLike = {
  fileUrl: '/app/public/assets/cinema/sora/sora_y.mp4',
  metadata: { r2Key: 'brands/u/video.mp4' },
};
const creationLocalPathWithBareKey: DownloadCreationLike = {
  fileUrl: '/app/public/assets/cinema/sora/sora_z.mp4',
  metadata: { r2Key: '/app/public/assets/cinema/sora/sora_z.mp4' },
};
const creationR2Signed: DownloadCreationLike = {
  fileUrl: 'https://2ac5a2e3cb490826386d96fe89d58ab4.r2.cloudflarestorage.com/empirelaunchai/brands/u/video.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&X-Amz-Expires=3600',
};
const creationGenericHttp: DownloadCreationLike = { fileUrl: 'https://cdn.example.com/video.mp4' };

test('classifyDownload: creation with NO fileUrl falls back to project.finalVideoUrl (route ordering preserved)', () => {
  const d = classifyDownload({ fileUrl: null, metadata: {} }, projectWithVideo);
  assert.equal(d.kind, 'ok');
  if (d.kind === 'ok') assert.equal(d.mediaUrl, projectWithVideo.finalVideoUrl);
});

test('classifyDownload: bare LOCAL-PATH fileUrl (no r2Key rescue) → no-media (owner stuck case)', () => {
  const d = classifyDownload(creationLocalPath, null);
  assert.equal(d.kind, 'no-media');
  // And the friendly 409 body the route will send:
  const { status, body } = downloadFailureBody('2c94144a-eac0-4b12-866e-c9ad3e82bf7c', 'no-media');
  assert.equal(status, 409);
  assert.equal(body.error, 'This video failed to render — there is no file to download. Please regenerate it.');
  assert.equal(body.failed, true);
});

test('classifyDownload: bare LOCAL-PATH finalVideoUrl on failed project → no-media + status', () => {
  const d = classifyDownload(null, projectLocalPath);
  assert.equal(d.kind, 'no-media');
  if (d.kind === 'no-media') assert.equal(d.projectStatus, 'failed');
});

test('classifyDownload: local-path fileUrl + usable metadata.r2Key rescue → ok (URL-clobber rescue preserved)', () => {
  const d = classifyDownload(creationLocalPathWithKeyRescue, null);
  assert.equal(d.kind, 'ok');
  if (d.kind === 'ok') {
    assert.equal(d.mediaUrl, creationLocalPathWithKeyRescue.fileUrl);
    // route falls back to meta.r2Key when extractR2Key(bare path) → null
    assert.equal((d.meta as any).r2Key, 'brands/u/video.mp4');
  }
});

test('classifyDownload: local-path fileUrl + BARE-path metadata.r2Key → no-media (dead key is dead media)', () => {
  assert.equal(classifyDownload(creationLocalPathWithBareKey, null).kind, 'no-media');
});

test('classifyDownload: genuine R2 signed URL → ok', () => {
  const d = classifyDownload(creationR2Signed, null);
  assert.equal(d.kind, 'ok');
  if (d.kind === 'ok') assert.equal(d.mediaUrl, creationR2Signed.fileUrl);
});

test('classifyDownload: generic http URL → ok (real remote reference; extraction-scope note: proxy can only fetch R2-hosted keys, so a non-R2 host answers 502 with reason downstream, never a bare 404/409)', () => {
  const d = classifyDownload(creationGenericHttp, null);
  assert.equal(d.kind, 'ok');
  if (d.kind === 'ok') assert.equal(d.mediaUrl, creationGenericHttp.fileUrl);
});

test('downloadFailureBody: bad-key → 502 with id + human reason', () => {
  const { status, body } = downloadFailureBody('abc', 'bad-key');
  assert.equal(status, 502);
  assert.equal(body.id, 'abc');
  assert.equal(body.reason, 'Media missing from storage');
  assert.equal(body.error, 'Could not parse R2 key from URL');
});

test('downloadFailureBody: r2-missing → 502 with id + human reason', () => {
  const { status, body } = downloadFailureBody('abc', 'r2-missing');
  assert.equal(status, 502);
  assert.equal(body.id, 'abc');
  assert.equal(body.reason, 'Media missing from storage');
  assert.equal(body.error, 'R2 download failed');
});