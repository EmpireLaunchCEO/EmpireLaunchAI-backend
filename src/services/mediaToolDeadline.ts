/**
 * MEDIA DEADLINES — ONE definition, every ffmpeg/ffprobe child in the render path.
 *
 * Audit 11 Nov, defect 5. Media children used to run unbounded: a wedged ffmpeg
 * hung the render request forever, and a wedged `execFileSync` probe froze the
 * whole event loop for every other user on the box. PR #161 put a deadline on
 * every call inside sceneVideoPipelineService; the same defect was still open in
 * videoExportVariants, sceneJoinService, assemblyOverlays and videoQueueService.
 *
 * The deadline lives here so all five files share ONE number and ONE failure
 * shape. Both are env-overridable so a fixture can prove the deadline in
 * milliseconds instead of waiting minutes.
 */
const DEFAULT_FFMPEG_TIMEOUT_MS = 180_000;
const DEFAULT_FFPROBE_TIMEOUT_MS = 30_000;

export function mediaToolTimeoutMs(tool: 'ffmpeg' | 'ffprobe'): number {
  const raw = Number(process.env[tool === 'ffprobe' ? 'FFPROBE_TIMEOUT_MS' : 'FFMPEG_TIMEOUT_MS']);
  const fallback = tool === 'ffprobe' ? DEFAULT_FFPROBE_TIMEOUT_MS : DEFAULT_FFMPEG_TIMEOUT_MS;
  return Number.isFinite(raw) && raw > 0 ? Math.max(50, Math.floor(raw)) : fallback;
}

/** Did this child die because WE killed it at its deadline? */
export function isMediaToolTimeout(err: any): boolean {
  if (!err) return false;
  return err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT' || String(err.code || '') === 'ETIMEDOUT';
}

/** The one shape a killed-at-deadline media call fails with. */
export function mediaToolTimeoutError(tool: 'ffmpeg' | 'ffprobe', label: string): Error {
  return new Error(
    `${tool} TIMED OUT after ${mediaToolTimeoutMs(tool)}ms and was killed (${label}) — ` +
    `the step failed with this reason instead of hanging the request`,
  );
}

/** execFile failure → one Error, preserving the long-standing "exited with
 *  code" wording for real failures and naming the deadline for timeouts. */
export function mediaToolFailure(tool: 'ffmpeg' | 'ffprobe', label: string, err: any, stderr: unknown): Error {
  if (isMediaToolTimeout(err)) return mediaToolTimeoutError(tool, label);
  return new Error(
    `${tool} exited with code ${err?.code ?? ''}: ` +
    String(stderr || err?.message || '').split('\n').filter(Boolean).slice(-3).join(' '),
  );
}
