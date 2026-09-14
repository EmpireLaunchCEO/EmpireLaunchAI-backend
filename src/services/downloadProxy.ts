/**
 * Pure helpers for GET /api/studio/download/:id — resolve which media row the
 * id points to and produce clear, human-readable failures instead of a bare
 * 404/502 JSON blob rendering in a new tab.
 *
 * A row can exist but have nothing to download (e.g. a scene project whose
 * render FAILED — final_video_url is NULL and metadata.r2Key is NULL). In that
 * case the download proxy must say WHY there is no file (409), not pretend the
 * id is unknown (bare 404). Unknown ids (no creation AND no project row) keep 404.
 *
 * The 409 is status-aware: an in-progress project (scripting/generating/
 * assembling) also has no finalVideoUrl yet, but telling the user to
 * "regenerate" there would be wrong — it says "check back soon" instead.
 *
 * Bare local paths are NOT downloadable media: legacy rows may hold values like
 * "/app/public/assets/cinema/...mp4" (a filesystem path from an old deploy, long
 * gone from the container). A truthy-looking local path used to classify as 'ok'
 * and then explode with `502 Could not parse R2 key` — a raw error page for the
 * user. Such rows are 'no-media' (409 friendly) UNLESS metadata.r2Key holds a
 * usable R2 object key rescue (the URL-clobber fix — legacy rows sometimes
 * combine a dead local path with a live R2 key; those still download).
 */

export interface DownloadCreationLike {
  fileUrl?: string | null;
  metadata?: unknown;
}

export interface DownloadProjectLike {
  finalVideoUrl?: string | null;
  metadata?: unknown;
  status?: string | null;
}

export type DownloadClassification =
  | { kind: 'ok'; mediaUrl: string; meta: any } // row found and it has downloadable media
  | { kind: 'not-found' } // no creation AND no project row → genuinely unknown id
  | { kind: 'no-media'; projectStatus?: string | null }; // row exists but nothing to download

const IN_PROGRESS_STATUSES = new Set(['scripting', 'generating', 'assembling']);

/** True when the value is a real remote URL the proxy can attempt (R2 signed/public or generic http). */
function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * metadata.r2Key rescue is only usable when it is a real R2 object key
 * (non-empty, NOT a bare local path starting with "/"). Bare-path "keys" are
 * the same dead-media class as bare-path URLs → they mean 'no-media'.
 */
function usableR2Key(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const k = (meta as Record<string, unknown>).r2Key;
  if (typeof k !== 'string') return null;
  const key = k.trim();
  if (key === '' || key.startsWith('/')) return null;
  return key;
}

/**
 * Decide what a download id resolves to. Pure — no DB, no I/O.
 * Mirrors the route's mediaUrl = creation.fileUrl || project.finalVideoUrl rule
 * and splits the "no media" case out of the 404 case.
 *
 * Media rules:
 * - http(s) URL (R2 signed `https://*.r2.cloudflarestorage.com/...`, R2 public,
 *   or a generic http URL) → 'ok' — a real remote reference the proxy can try.
 *   If extraction still fails the route answers 502 with a reason (not a bare 404).
 * - bare local path (starts with "/" or otherwise not http[s]) → 'no-media'
 *   (409 friendly) UNLESS metadata.r2Key carries a usable R2 key rescue.
 * - NULL/empty URL → 'no-media'.
 */
export function classifyDownload(
  creation?: DownloadCreationLike | null,
  project?: DownloadProjectLike | null,
): DownloadClassification {
  // Creation rows take priority, exactly like the route's mediaUrl rule
  // (creation.fileUrl || project.finalVideoUrl) — but a creation whose media is
  // a bare local path (no usable r2Key rescue) must NOT shadow a project row
  // that holds a real final video (the route only queries the project when the
  // creation has no fileUrl, so this ordering stays faithful to it).
  const creationUrl = creation?.fileUrl;
  if (creationUrl) {
    if (isHttpUrl(creationUrl)) return { kind: 'ok', mediaUrl: creationUrl, meta: creation.metadata };
    if (usableR2Key(creation.metadata)) return { kind: 'ok', mediaUrl: creationUrl, meta: creation.metadata };
  }
  const projectUrl = project?.finalVideoUrl;
  if (projectUrl) {
    if (isHttpUrl(projectUrl)) return { kind: 'ok', mediaUrl: projectUrl, meta: project.metadata };
    if (usableR2Key(project.metadata)) return { kind: 'ok', mediaUrl: projectUrl, meta: project.metadata };
  }
  if (creationUrl || projectUrl) {
    return { kind: 'no-media', projectStatus: project?.status ?? null };
  }
  if (creation || project) return { kind: 'no-media', projectStatus: project?.status ?? null };
  return { kind: 'not-found' };
}

export type DownloadFailureKind = 'no-media' | 'bad-key' | 'r2-missing';

/**
 * Human-readable failure responses for the download proxy. Every branch keeps
 * the technical `error` (frontend compat) and adds `id` + a one-line `reason`
 * the user can actually read, so a raw JSON error page never appears unexplained.
 */
export function downloadFailureBody(
  id: string,
  kind: DownloadFailureKind,
  opts?: { projectStatus?: string | null },
): { status: number; body: Record<string, unknown> } {
  switch (kind) {
    case 'no-media': {
      const status = opts?.projectStatus ?? null;
      if (status && IN_PROGRESS_STATUSES.has(status)) {
        return {
          status: 409,
          body: {
            error: "This video is still being created and isn't ready to download yet. Please check back soon.",
            processing: true,
            failed: false,
            id,
            status,
          },
        };
      }
      return {
        status: 409,
        body: {
          error: 'This video failed to render — there is no file to download. Please regenerate it.',
          failed: true,
          id,
          ...(status ? { status } : {}),
        },
      };
    }
    case 'bad-key':
      return {
        status: 502,
        body: { id, error: 'Could not parse R2 key from URL', reason: 'Media missing from storage' },
      };
    case 'r2-missing':
      return {
        status: 502,
        body: { id, error: 'R2 download failed', reason: 'Media missing from storage' },
      };
  }
}