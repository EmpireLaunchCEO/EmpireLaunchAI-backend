/**
 * ONE RETRY, THEN ONE SPECIFIC QUESTION (owner, 23 Nov).
 *
 * Owner's words:
 *   "id rather everything be fixed before I try to make a video again."
 *   "if it failed due to needing a change ... shouldn't the AI be smart enough to
 *    know what it needs so the video doesn't fail?"
 *   "if the preflight check didn't clear, then the AI should go back in the video chat
 *    and state what the issue with the video is ... and ask the client how it wants it
 *    to be fixed"
 *
 * WHAT THIS IS
 * ------------
 * The ONE ladder every repairable failure walks, built once so it is never built
 * twice:
 *
 *   1. ATTEMPT  — try the thing (a probe, a repair pass).
 *   2. RETRY    — if it did not clear, spend EXACTLY ONE free retry (a re-signed link,
 *                 a text-only repair call), never a loop.
 *   3. ASK      — if it still did not clear, produce EXACTLY ONE question for the
 *                 client, with the real options, for the video's chat.
 *
 * WHY IT IS ITS OWN MODULE
 * ------------------------
 * The spend ladder (free deterministic patches first, at most ONE retry) is a product
 * rule, not a detail of any one check. `costPreflight.ts` (the photo re-sign) and the
 * component repair ladder in `sceneVideoPipelineService.ts` both call this, so the
 * retry count and the "one question" shape can only ever be defined in one place.
 *
 * PURE: no I/O, no providers, no database. The caller passes the steps.
 */

export interface RetryThenAskInput<T> {
  /** The first try. */
  attempt: () => Promise<T>;
  /** Did this try clear the failure? */
  succeeded: (value: T) => boolean;
  /**
   * The ONE free retry. Receives the first result. A caller that has nothing to retry
   * with simply returns its input — the ladder still counts one retry, so a fixture can
   * assert the count and no caller can accidentally loop.
   */
  retry: (first: T) => Promise<T>;
  /** Build the ONE question for the client from the last result. Called only on failure.
   *  Omitted ⇒ the ladder reports "no question" and the caller builds its own copy. */
  ask?: (last: T) => TQuestion;
  /** Optional: told which step just failed, for the trace line. */
  onRetry?: (first: T) => void;
}

/** The one question a refusal asks, in the shape the chat stores and the UI shows. */
export interface TQuestion {
  /** The issue, in plain words, pointing at the thing it is about. */
  issue: string;
  /** One specific question with real options — EMPTY when no answer from the client can help. */
  question: string;
  /** The real options the client can pick from (empty when there is no question). */
  options: string[];
  /** false ⇒ the client cannot resolve it (our machine, our credential, a provider outage). */
  resolvable: boolean;
}

export interface RetryThenAskResult<T> {
  ok: boolean;
  /** The last result, whether or not it cleared. */
  value: T;
  /** 1 = the first try cleared, 2 = the retry cleared. Never more than 2. */
  attempts: number;
  /** Present EXACTLY when ok === false: the one question to ask the client. */
  ask: TQuestion | null;
}

/**
 * Run the ladder: attempt → one retry → one question. Never a loop, never a third try.
 * A step that THROWS is treated as "did not clear", so a network error cannot skip the
 * retry or swallow the question.
 */
export async function retryThenAsk<T>(input: RetryThenAskInput<T>): Promise<RetryThenAskResult<T>> {
  const first = await input.attempt();
  if (input.succeeded(first)) return { ok: true, value: first, attempts: 1, ask: null };
  input.onRetry?.(first);
  let second: T;
  try {
    second = await input.retry(first);
  } catch {
    // A retry that could not even run leaves the FIRST result as the reason: the
    // question must still be asked about what actually failed.
    second = first;
  }
  if (input.succeeded(second)) return { ok: true, value: second, attempts: 2, ask: null };
  const ask = input.ask
    ? input.ask(second)
    : { issue: '', question: '', options: [], resolvable: false };
  return { ok: false, value: second, attempts: 2, ask };
}
