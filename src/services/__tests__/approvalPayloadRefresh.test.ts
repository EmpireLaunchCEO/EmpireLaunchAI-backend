/**
 * Unit tests for re-signing expired R2 media URLs inside approval payloads
 * (GET /api/approval/pending → Operations Videos queue playback fix).
 * NO paid renders, NO Sora, NO DB — `r2Storage.getSignedUrl` is stubbed.
 * Key extraction is delegated to the already-tested `r2KeyFromUrl`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { refreshR2Url, refreshApprovalPayloadUrls, PAYLOAD_URL_FIELDS, mediaUrlsFromPayload } from '../approvalPayloadRefresh.js';
import { r2Storage } from '../r2StorageService.js';

const R2_URL = 'https://pub-abc123.r2.cloudflarestorage.com/empirelaunchai/brands/00000000-0000-0000-0000-000000000000/video-projects/abc123.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260801T000000Z&X-Amz-Expires=3600&X-Amz-Signature=deadbeef';
const FRESH_URL = 'https://pub-abc123.r2.cloudflarestorage.com/empirelaunchai/brands/00000000-0000-0000-0000-000000000000/video-projects/abc123.mp4?X-Amz-Date=20260903T235959Z&X-Amz-Expires=3600';

test('refreshR2Url: re-signs R2 URL to fresh signed URL', async () => {
  mock.method(r2Storage, 'getSignedUrl', async () => FRESH_URL);
  const out = await refreshR2Url(R2_URL);
  assert.equal(out, FRESH_URL);
});
test('refreshR2Url: non-R2 URL passes through unchanged', async () => {
  mock.method(r2Storage, 'getSignedUrl', async () => FRESH_URL);
  assert.equal(await refreshR2Url('https://example.com/video.mp4'), 'https://example.com/video.mp4');
});
test('refreshR2Url: falls back to stored URL when getSignedUrl returns null', async () => {
  mock.method(r2Storage, 'getSignedUrl', async () => null);
  assert.equal(await refreshR2Url(R2_URL), R2_URL);
});
test('refreshR2Url: falls back to stored URL when getSignedUrl throws', async () => {
  mock.method(r2Storage, 'getSignedUrl', async () => { throw new Error('boom'); });
  assert.equal(await refreshR2Url(R2_URL), R2_URL);
});

test('refreshApprovalPayloadUrls: re-signs all string URL fields', async () => {
  mock.method(r2Storage, 'getSignedUrl', async (key: string) => `https://fresh/${key}`);
  const input = {
    videoUrl: R2_URL,
    thumbnailUrl: R2_URL,
    audioUrl: R2_URL,
    imageUrl: R2_URL,
    sourceImages: [R2_URL, 'https://plain.example/x.png'],
    title: 'Untitled Project',
    status: 'completed',
  };
  const out = await refreshApprovalPayloadUrls(input);
  assert.ok(out.videoUrl.startsWith('https://fresh/'));
  assert.ok(out.thumbnailUrl.startsWith('https://fresh/'));
  assert.ok(out.audioUrl.startsWith('https://fresh/'));
  assert.ok(out.imageUrl.startsWith('https://fresh/'));
  assert.ok(out.sourceImages[0].startsWith('https://fresh/'));
  assert.equal(out.sourceImages[1], 'https://plain.example/x.png'); // non-R2 untouched
  assert.equal(out.title, 'Untitled Project');
  assert.equal(out.status, 'completed');
  // original payload object is not mutated
  assert.equal(input.videoUrl, R2_URL);
});
test('refreshApprovalPayloadUrls: non-object payload returned as-is', async () => {
  assert.equal(await refreshApprovalPayloadUrls(null), null);
  assert.equal(await refreshApprovalPayloadUrls(undefined), undefined);
  assert.equal(await refreshApprovalPayloadUrls('string'), 'string');
});
test('PAYLOAD_URL_FIELDS covers the media URL keys served to Operations', () => {
  assert.ok(PAYLOAD_URL_FIELDS.includes('videoUrl'));
  assert.ok(PAYLOAD_URL_FIELDS.includes('thumbnailUrl'));
  assert.ok(PAYLOAD_URL_FIELDS.includes('audioUrl'));
  assert.ok(PAYLOAD_URL_FIELDS.includes('imageUrl'));
});

test('mediaUrlsFromPayload: collects the 4 R2 media fields to clean up on delete', () => {
  const urls = mediaUrlsFromPayload({
    videoUrl: R2_URL,
    thumbnailUrl: R2_URL,
    audioUrl: R2_URL,
    imageUrl: R2_URL,
    title: 'Untitled Project',
    status: 'completed',
    previewUrl: 'https://example.com/preview.png', // NOT part of delete cleanup
  });
  assert.deepEqual(urls, [R2_URL, R2_URL, R2_URL, R2_URL]);
});
test('mediaUrlsFromPayload: ignores non-string / missing media fields and non-object payloads', () => {
  assert.deepEqual(mediaUrlsFromPayload({ videoUrl: 123, thumbnailUrl: null, title: 'x' }), []);
  assert.deepEqual(mediaUrlsFromPayload(null), []);
  assert.deepEqual(mediaUrlsFromPayload(undefined), []);
  assert.deepEqual(mediaUrlsFromPayload('nope'), []);
});