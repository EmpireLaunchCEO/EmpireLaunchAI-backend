/**
 * Finished-video streaming — the "owner can open the video in a browser" path
 * (GET /api/studio/video/:projectId/stream).
 *
 * WHY THIS EXISTS
 * ---------------
 * A finished render lives only in R2. The public site answers `/*.mp4` with
 * HTML, so a link handed to the owner opened a web page instead of her video.
 * This module is the piece that turns a project id into actual bytes with the
 * headers a browser needs to PLAY the file (inline, video/mp4, byte ranges).
 *
 * Everything in this file is PURE — no DB, no S3, no network — so the rules
 * below are unit-testable without a render or a paid call. The route
 * (studioRoutes.ts) does the I/O and defers every decision to these helpers.
 *
 * DESIGN RULES
 * ------------
 * 1. Serve bytes, not a link. A presigned redirect hands the browser a URL
 *    whose stored Content-Type we do not control (older uploads can be
 *    application/octet-stream) and whose expiry can bite mid-watch. Proxying
 *    through the backend lets us pin `video/mp4`, `inline`, and `Accept-Ranges`
 *    on every response — which is exactly what a browser checks before it
 *    offers a play button.
 * 2. A project with no finished file must say so in words (404 + JSON), never
 *    fall through to an HTML error page or a zero-byte 200.
 * 3. Ranges are mandatory: without `206 Partial Content` browsers cannot seek
 *    and some refuse to start playback at all.
 */

/** The subset of a `video_projects` row this module needs. */
export interface StreamProjectLike {
  id?: string | null;
  status?: string | null;
  finalVideoUrl?: string | null;
  metadata?: unknown;
}

export type StreamTarget =
  | { kind: 'ok'; r2Key: string }
  | { kind: 'no-video'; status: number; body: Record<string, unknown> }
  | { kind: 'not-found'; status: number; body: Record<string, unknown> };

/** Statuses that mean "the pipeline is still working on it". */
const IN_PROGRESS_STATUSES = new Set([
  'scripting',
  'queued',
  'pending',
  'generating',
  'assembling',
  'processing',
  'rendering',
]);

/** Metadata keys that can carry the finished file when finalVideoUrl is dead. */
const META_KEY_CANDIDATES = ['r2Key', 'finalVideoKey', 'videoR2Key', 'finalVideoUrl'] as const;

function asObject(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}

/**
 * Extract an R2 object key from a stored URL.
 *
 * Handles the three shapes this codebase actually stores:
 *   - presigned R2 URL      https://{acct}.r2.cloudflarestorage.com/{bucket}/{key}?X-Amz-...
 *   - custom public domain  ${R2_PUBLIC_URL}/{key}
 *   - bare key              brands/{brandId}/video-projects/{uuid}.mp4
 *
 * Returns null for local paths ("/assets/..."), which are NOT fetchable from a
 * deployed backend and must not be mistaken for a usable key.
 */
export function extractR2KeyFromUrl(storedUrl: string | null | undefined): string | null {
  if (typeof storedUrl !== 'string') return null;
  const raw = storedUrl.trim();
  if (raw === '') return null;

  // Bare key (no scheme, no leading slash).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (raw.startsWith('/')) return null; // local path — not in R2
    return raw;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const publicBase = process.env.R2_PUBLIC_URL;
  if (publicBase && raw.startsWith(publicBase)) {
    const key = url.pathname.replace(/^\//, '');
    return key || null;
  }

  // R2 S3 endpoint: pathname is /{bucket}/{key}
  if (url.hostname.includes('r2.cloudflarestorage.com')) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return parts.slice(1).join('/') || null;
  }

  // Any other http(s) host — only usable if the path looks like a bucket key.
  if (url.pathname.startsWith('/brands/')) return url.pathname.replace(/^\//, '');
  return null;
}

/**
 * The single 404 body for "no such video for YOU".
 *
 * Returned for an unknown id AND for a project that belongs to a different
 * user, deliberately identical: a distinct 403 would confirm that the id is
 * real, which is exactly the existence leak the ownership check exists to stop.
 */
export function streamNotFoundBody(): Record<string, unknown> {
  return {
    status: 'error',
    error: 'No video project with that id.',
    reason: 'That video id does not exist. Check the link.',
  };
}

/** The 401 body when the caller did not say who they are (mirrors /download/:id). */
export function streamUserIdRequiredBody(): Record<string, unknown> {
  return {
    status: 'error',
    error: 'userId required',
    reason: 'Pass your user id as ?userId=..., an x-user-id header, or a signed-in session.',
  };
}

/** The 401 body when the supplied id resolves to no known user (mirrors /download/:id). */
export function streamUserNotFoundBody(): Record<string, unknown> {
  return {
    status: 'error',
    error: 'User not found',
    reason: 'That user id does not resolve to an account.',
  };
}

export type StreamAccess =
  | { kind: 'allow'; userId: string }
  /** The caller supplied an id; nothing beyond that has been checked yet. */
  | { kind: 'pass' }
  | { kind: 'deny'; status: 401 | 404; body: Record<string, unknown> };

/**
 * OWNERSHIP GATE for GET /api/studio/video/:projectId/stream.
 *
 * A project id is NOT a credential. User privacy is a non-negotiable, so the
 * stream route is scoped to the owner exactly like GET /api/studio/download/:id
 * — the query filters on (id, userId) and this decision mirrors it:
 *
 *   no user id supplied        -> 401 'userId required'
 *   id does not resolve        -> 401 'User not found'
 *   no project for this owner  -> 404, the SAME body as an unknown id
 *   project belongs to another -> 404, identical (never confirms existence)
 *   project belongs to caller  -> allow
 *
 * `projectOwnerId` is null whenever the scoped query matched no row, so
 * "wrong owner" and "unknown id" are indistinguishable here by construction.
 * Keeping the rule pure lets all five branches be tested with no DB, and means
 * a future edit that drops the scope from the query still cannot open the door.
 *
 * The route calls this more than once per request, so the difference between
 * "not established yet" and "established as nothing" is explicit:
 *   resolvedUserId === undefined  -> caller id not resolved yet  (kind 'pass')
 *   resolvedUserId === null / ''  -> resolved to nobody          (401)
 *   projectOwnerId === undefined  -> project not looked up yet   (allow)
 *   projectOwnerId === null / ''  -> no row for this owner       (404)
 * Getting that wrong in the other direction is what produced a route that
 * answered 401 to the owner's own video; the tests pin all five branches.
 */
export function authorizeStreamAccess(input: {
  rawUid?: unknown;
  resolvedUserId?: string | null;
  projectOwnerId?: string | null;
}): StreamAccess {
  const raw = Array.isArray(input.rawUid)
    ? String(input.rawUid[0] ?? '').trim()
    : (typeof input.rawUid === 'string' ? input.rawUid.trim() : '');
  if (!raw) return { kind: 'deny', status: 401, body: streamUserIdRequiredBody() };

  if (input.resolvedUserId === undefined) return { kind: 'pass' };

  const resolved = typeof input.resolvedUserId === 'string' ? input.resolvedUserId.trim() : '';
  if (!resolved) return { kind: 'deny', status: 401, body: streamUserNotFoundBody() };

  if (input.projectOwnerId === undefined) return { kind: 'allow', userId: resolved };

  const owner = typeof input.projectOwnerId === 'string' ? input.projectOwnerId.trim() : '';
  if (!owner || owner !== resolved) {
    return { kind: 'deny', status: 404, body: streamNotFoundBody() };
  }

  return { kind: 'allow', userId: resolved };
}

/**
 * Decide what a project id resolves to for streaming.
 *
 * Order of preference for the file: `final_video_url`, then the metadata
 * fallbacks (`r2Key` / `finalVideoKey` / `finalVideoUrl`) — legacy rows hold a
 * dead local path in final_video_url while the real key survived in metadata.
 */
export function resolveStreamTarget(project: StreamProjectLike | null | undefined): StreamTarget {
  if (!project) {
    return { kind: 'not-found', status: 404, body: streamNotFoundBody() };
  }

  const meta = asObject(project.metadata);

  let r2Key = extractR2KeyFromUrl(project.finalVideoUrl);
  if (!r2Key) {
    for (const candidate of META_KEY_CANDIDATES) {
      const value = meta[candidate];
      if (typeof value !== 'string') continue;
      r2Key = extractR2KeyFromUrl(value);
      if (r2Key) break;
    }
  }
  if (r2Key) return { kind: 'ok', r2Key };

  const status = typeof project.status === 'string' ? project.status : null;
  const id = typeof project.id === 'string' ? project.id : undefined;

  if (status && IN_PROGRESS_STATUSES.has(status)) {
    return {
      kind: 'no-video',
      status: 404,
      body: {
        status: 'error',
        error: "This video is still being made — there's nothing to play yet.",
        reason: 'Render in progress',
        processing: true,
        failed: false,
        ...(id ? { id } : {}),
        projectStatus: status,
      },
    };
  }

  return {
    kind: 'no-video',
    status: 404,
    body: {
      status: 'error',
      error: 'This video did not finish rendering, so there is no file to play.',
      reason: 'No finished video for this project',
      processing: false,
      failed: true,
      ...(id ? { id } : {}),
      ...(status ? { projectStatus: status } : {}),
    },
  };
}

export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | 'none';

/**
 * Parse a single-range `Range` header against a known object size.
 *
 * Returns:
 *   { start, end }   → serve 206 with that inclusive byte window
 *   'unsatisfiable'  → serve 416 with `Content-Range: bytes * /size`
 *   'none'           → no/ignorable header → serve the whole file with 200
 *
 * Multi-range requests are deliberately reduced to their first range: every
 * browser player and ffmpeg send single ranges, and multipart/byteranges
 * responses buy nothing for a single video file.
 */
export function parseByteRange(header: string | null | undefined, size: number): ParsedRange {
  if (typeof header !== 'string') return 'none';
  const value = header.trim();
  if (value === '') return 'none';
  if (!/^bytes=/i.test(value)) return 'none';
  if (!Number.isFinite(size) || size <= 0) return 'unsatisfiable';

  const spec = value.slice('bytes='.length).split(',')[0]?.trim() ?? '';
  if (spec === '') return 'none';

  const dash = spec.indexOf('-');
  if (dash === -1) return 'none';

  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  // Suffix form: bytes=-N  → last N bytes.
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0) return 'none';
  if (start >= size) return 'unsatisfiable';

  if (rawEnd === '') return { start, end: size - 1 };

  const end = Number(rawEnd);
  if (!Number.isInteger(end) || end < start) return 'none';
  return { start, end: Math.min(end, size - 1) };
}

/** Content-Disposition that makes the browser PLAY the file instead of saving it. */
export function inlineDisposition(id: string): string {
  const short = String(id).slice(0, 8) || 'video';
  return `inline; filename="empirelaunch-${short}.mp4"`;
}

/**
 * Build the complete header set for a stream response.
 *
 * `video/mp4` is pinned rather than echoed from the stored object because older
 * uploads carry application/octet-stream, and a browser that sees that refuses
 * to play the file it was handed.
 */
export function buildStreamHeaders(opts: {
  id: string;
  size: number;
  rangeHeader?: string | null;
}): { status: number; headers: Record<string, string> } {
  const { id, size, rangeHeader } = opts;
  const base: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Content-Disposition': inlineDisposition(id),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  };

  const range = parseByteRange(rangeHeader, size);
  if (range === 'none') {
    return { status: 200, headers: { ...base, 'Content-Length': String(size) } };
  }
  if (range === 'unsatisfiable') {
    return {
      status: 416,
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${size}`,
        'Content-Length': '0',
      },
    };
  }
  return {
    status: 206,
    headers: {
      ...base,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(range.end - range.start + 1),
    },
  };
}

/** `bytes={start}-{end}` for the S3 GetObject Range parameter, or undefined. */
export function s3RangeHeader(range: ParsedRange): string | undefined {
  if (range === 'none' || range === 'unsatisfiable') return undefined;
  return `bytes=${range.start}-${range.end}`;
}
