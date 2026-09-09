/**
 * Pure helpers for GET /api/studio/download/:id — resolve which media row the
 * id points to and produce clear, human-readable failures instead of a bare
 * 404/502 JSON blob rendering in a new tab.
 *
 * A row can exist but have nothing to download (e.g. a scene project whose
 * render FAILED — final_video_url is NULL and metadata.r2Key is NULL). In that
 * case the download proxy must say WHY there is no file (409), not pretend the
 * id is unknown (bare 404). Unknown ids (no creation AND no project row) keep 404.
 */

export interface DownloadCreationLike {
  fileUrl?: string | null;
  metadata?: unknown;
}

export interface DownloadProjectLike {
  finalVideoUrl?: string | null;
  metadata?: unknown;
}

export type DownloadClassification =
  | { kind: 'ok'; mediaUrl: string; meta: any } // row found and it has downloadable media
  | { kind: 'not-found' } // no creation AND no project row → genuinely unknown id
  | { kind: 'no-media' }; // row exists but nothing to download (failed render / no file yet)

/**
 * Decide what a download id resolves to. Pure — no DB, no I/O.
 * Mirrors the route's mediaUrl = creation.fileUrl || project.finalVideoUrl rule
 * and splits the "no media" case out of the 404 case.
 */
export function classifyDownload(
  creation?: DownloadCreationLike | null,
  project?: DownloadProjectLike | null,
): DownloadClassification {
  if (creation?.fileUrl) return { kind: 'ok', mediaUrl: creation.fileUrl, meta: creation.metadata };
  if (project?.finalVideoUrl) return { kind: 'ok', mediaUrl: project.finalVideoUrl, meta: project.metadata };
  if (creation || project) return { kind: 'no-media' };
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
): { status: number; body: Record<string, unknown> } {
  switch (kind) {
    case 'no-media':
      return {
        status: 409,
        body: {
          error: 'This video failed to render — there is no file to download. Please regenerate it.',
          failed: true,
          id,
        },
      };
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