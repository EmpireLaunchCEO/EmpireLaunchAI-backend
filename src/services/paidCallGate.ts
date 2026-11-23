/**
 * PAID-CALL GATE — after the first paid failure, nothing more is bought.
 * (Owner, 23 Nov: "if no video gets produced or it fails up front ... it needs to
 * be stopped from ending up running Veo or gpt so there is no cost. I don't need
 * videos being half produced and then failing still using Veo cost.")
 *
 * WHY A GATE AND NOT A CHECK IN ONE PLACE
 * ---------------------------------------
 * A video is bought piece by piece — the planner call, one gpt-image still per
 * still scene, one gpt-audio clip per spoken scene, and up to two Veo windows.
 * Today those calls are fired from four different places, and the scene loop runs
 * with bounded PARALLELISM (SCENE_CONCURRENCY), so a failure in scene 2 no longer
 * stops scene 3 from being bought. Without one shared choke point, "stop spending
 * after the first failure" cannot be guaranteed — it depends on which scene
 * happened to fail first and how many were already in flight.
 *
 * So: EVERY paid call goes through `paidCall()`. When a failure that will sink the
 * project is recorded with `notePaidFailure()`, every later `paidCall()` for that
 * project throws BEFORE its provider function is invoked — the count of provider
 * calls after the failure is exactly zero, which is what the fixtures assert.
 *
 * WHAT IS **NOT** RECORDED
 * ------------------------
 * Only a failure that ABANDONS the render is recorded. Faceless deliberately
 * fails SOFT on a lost Veo window (owner, Nov 10): the video still finishes with
 * that window's designed still, and the reason is stated on the scene and the
 * project. Recording it here would stop the still and the narration of the scenes
 * that were never attempted, i.e. it would turn fail-soft into the "no half-made
 * video" rule — which is item 3 of the cost brief and is NOT in force yet.
 *
 * The registry is per project and in-process: it is cleared at the start of every
 * render run (`clearPaidFailure` in createProject/processProject), so a client's
 * retry or a single-scene regeneration is a NEW run, not a continuation of the
 * failed one.
 */

/**
 * Which paid provider call was attempted — or `'scene'` when a scene's render
 * failed at a step the scene itself owns (the scene row names the real error).
 * Named so the trace says exactly what was NOT bought.
 */
export type PaidCallKind = 'planner' | 'image' | 'audio' | 'veo' | 'scene';

export interface PaidFailure {
  kind: PaidCallKind;
  reason: string;
}

/** Test-only counters: how many paid calls were ATTEMPTED, per kind. */
const attempts: Record<PaidCallKind, number> = { planner: 0, image: 0, audio: 0, veo: 0, scene: 0 };

/** projectId → the first failure that abandoned that project's render. */
const firstFailure = new Map<string, PaidFailure>();

/** The reason a paid call was refused: the FIRST paid failure of this run. */
export class PaidCallBlockedError extends Error {
  code = 'PAID_CALL_BLOCKED';
  clientMessage: string;
  constructor(
    readonly projectId: string,
    readonly kind: PaidCallKind,
    readonly reason: string,
  ) {
    super(`No further paid call for this video — ${kind} was not called because an earlier step already failed: ${reason}`);
    this.name = 'PaidCallBlockedError';
    // The client's words: what stopped, that nothing else was bought, and that
    // their quota is intact. Never a bare provider error.
    this.clientMessage = `This video stopped because an earlier step failed (${reason}). Nothing further was generated and nothing was charged to your weekly quota.`;
  }
}

/** A new render run for this project starts with a clean ledger. */
export function clearPaidFailure(projectId: string): void {
  if (projectId) firstFailure.delete(projectId);
}

/**
 * Record the paid failure that abandons this project's render. The FIRST one wins:
 * later failures are consequences of the same run and must not overwrite the real
 * reason the client is told.
 */
export function notePaidFailure(projectId: string, kind: PaidCallKind, reason: string): void {
  if (!projectId || firstFailure.has(projectId)) return;
  firstFailure.set(projectId, { kind, reason: String(reason || `${kind} call failed`) });
}

/** The recorded failure, or null while the project may still spend. */
export function paidFailureFor(projectId: string): PaidFailure | null {
  return firstFailure.get(projectId) ?? null;
}

export function paidCallAllowed(projectId: string): boolean {
  return !firstFailure.has(projectId);
}

/** Throws (without invoking any provider) when this project must not spend again. */
export function assertPaidCallAllowed(projectId: string, kind: PaidCallKind): void {
  const failure = firstFailure.get(projectId);
  if (failure) throw new PaidCallBlockedError(projectId, kind, failure.reason);
}

/**
 * THE choke point. Refuses before the provider is touched; otherwise runs it.
 * Deliberately does NOT record a failure on its own: only the caller knows
 * whether the failure abandons the render (see the fail-soft note above).
 */
export async function paidCall<T>(
  ctx: { projectId: string; kind: PaidCallKind },
  fn: () => Promise<T>,
): Promise<T> {
  // Counted on ENTRY, refused or not: the fixtures read this to prove that a
  // refused request never even reached a provider.
  attempts[ctx.kind] = (attempts[ctx.kind] || 0) + 1;
  assertPaidCallAllowed(ctx.projectId, ctx.kind);
  return fn();
}

/** Test-only: how many paid calls were ATTEMPTED, per kind (refused ones included). */
export function __paidCallAttempts(): Record<PaidCallKind, number> {
  return { ...attempts };
}

/** Test-only: zero the attempt counters. */
export function __resetPaidCallAttempts(): void {
  for (const kind of Object.keys(attempts) as PaidCallKind[]) attempts[kind] = 0;
}

/** Test-only: drop every recorded failure. */
export function __resetPaidFailures(): void {
  firstFailure.clear();
}
