/**
 * BUILD IDENTITY — which commit is actually serving, answered at runtime.
 *
 * Until now there was no way to tell whether the live Railway service was
 * running the newest merged commit: `/health` returned a hard-coded version
 * string, `/debug-build` returned the same one, and the GitHub deployment
 * record on backend commits is a Vercel job for a different service. Railway
 * injects `RAILWAY_GIT_COMMIT_SHA` into every deploy, so reading that env var
 * at REQUEST time — never cached at import, never baked in at build time — is
 * the only honest answer available from inside the process.
 *
 * Two rules, both from the plan's own lessons:
 *   1. Never crash and never 404. A missing or blank env var is `"unknown"`,
 *      not an error — a version probe that fails is worse than no probe.
 *   2. Nothing here may throw, so `/health` (which now carries the same commit
 *      field) cannot be taken down by it.
 */

/** Railway injects this into every deploy; it is the commit that was built. */
export const COMMIT_SHA_ENV_VAR = 'RAILWAY_GIT_COMMIT_SHA';

/** What we report when the variable is absent, blank or unreadable. */
export const UNKNOWN_COMMIT = 'unknown';

export interface VersionInfo {
  /** The commit Railway built and is running, or `"unknown"`. */
  commit: string;
  /** ISO timestamp of when this process started. */
  startedAt: string;
  /** Whole seconds since this process started. */
  uptimeSeconds: number;
}

/**
 * The instant this process started, derived from `process.uptime()` so it
 * reflects the process and not merely the moment this module was imported.
 */
function processStartedAtIso(): string {
  try {
    const uptime = process.uptime();
    const ms = Number.isFinite(uptime) && uptime >= 0 ? Date.now() - uptime * 1000 : Date.now();
    return new Date(ms).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

const PROCESS_STARTED_AT = processStartedAtIso();

/**
 * The running commit sha from the environment, trimmed, or `"unknown"`.
 * `env` is injectable so the behaviour is testable without touching the real
 * process environment.
 */
export function resolveCommitSha(
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    const raw = env?.[COMMIT_SHA_ENV_VAR];
    if (typeof raw !== 'string') return UNKNOWN_COMMIT;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : UNKNOWN_COMMIT;
  } catch {
    return UNKNOWN_COMMIT;
  }
}

/** The body served by `GET /version`, and the `commit` field added to `/health`. */
export function getVersionInfo(
  env: Record<string, string | undefined> = process.env,
): VersionInfo {
  let uptimeSeconds = 0;
  try {
    const uptime = process.uptime();
    uptimeSeconds = Number.isFinite(uptime) && uptime >= 0 ? Math.round(uptime) : 0;
  } catch {
    uptimeSeconds = 0;
  }

  return {
    commit: resolveCommitSha(env),
    startedAt: PROCESS_STARTED_AT,
    uptimeSeconds,
  };
}
