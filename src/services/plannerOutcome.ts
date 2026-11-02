/**
 * PLANNER OUTCOME — the anti-silent-fallback contract (owner Nov 2).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A production run (project 16622f81, 2026-11-02) shipped a video whose plan was
 * the deterministic template arc in `buildArcScenes`, not a model plan. The
 * narration was "Say hello to A 30-second product video for Ember & Oak,." — the
 * raw brief echoed back — and the candle, its scent, its jar and its 50-hour burn
 * never appeared. Nothing on the project said the planner had been bypassed, so a
 * confident-looking wrong video would have been delivered.
 *
 * The production logs of an earlier run (a02014a3, 2026-10-11 02:36) show the
 * mechanism exactly:
 *
 *   [AiRouter] Raw AI response: { "classification": "ai_assistant",
 *                                 "prompt": "Generate a single JSON scene script …" }
 *   [SCENE_PIPELINE] gpt52_replan_start … missing=[7 components]
 *   [SCENE_PIPELINE] gpt52_script_end … generated=false
 *
 * The planner shares one model call with the router, and the router's system
 * prompt ("Classify the user's request… output MUST be valid JSON") wins often
 * enough that the model answers with a ROUTER DECISION instead of the planner's
 * `{ scenes: [...] }`. `parseDecision` preserves only `script`, so a router-shaped
 * reply yields `script: undefined` — no exception, no parse warning, nothing in
 * the logs but `generated=false`. `parseScenes` then quietly builds the template
 * arc. Worse: the one-shot QC replan OVERWROTE a usable first plan with that
 * `undefined`, so a good plan could be destroyed by a failed second call.
 *
 * THE RULE (owner, standing): anything that cannot be honoured must be said out
 * loud. So a planning failure is now:
 *   1. recorded on the project (`metadata.planner`) in a form the app can act on,
 *   2. surfaced to the client in the app's own voice,
 *   3. a FAILED render with a clear reason — never a plausible-looking template.
 *
 * Everything here is pure and deterministic: no network, no DB, no model. The
 * fixtures in `__tests__/plannerBypassLoud.test.ts` drive it directly.
 */

/** Why the planner did not produce the plan the video is built from. */
export type PlannerBypassReason =
  /** The planning call threw (provider error, auth, timeout). */
  | 'planner-call-failed'
  /** The call answered, but not with a plan (e.g. a router decision, empty text). */
  | 'planner-returned-no-plan'
  /** A plan came back but covered fewer scenes than the video needs. */
  | 'planner-incomplete-plan';

/** Where the scene list actually came from. */
export type PlannerSource = 'planner' | 'supplied-script' | 'template';

export interface PlannerOutcome {
  /** Where the persisted scene list came from. */
  source: PlannerSource;
  /** True ONLY when a real plan covered every scene. */
  planned: boolean;
  /** Non-null exactly when the render must fail loudly. */
  reason: PlannerBypassReason | null;
  /** What came back instead (truncated, secret-free). */
  detail: string;
  /** How many planning calls were made (first door + optional second door). */
  attempts: number;
  /** Scenes the plan actually provided. */
  plannerScenes: number;
  /** Scenes filled from the deterministic template (should be 0 in a real plan). */
  templateScenes: number;
  /** A QC replan returned nothing, so the usable first plan was kept. */
  replanDiscarded: boolean;
  at: string;
}

export interface PlanningFailure {
  code: 'PLANNING_FAILED';
  /** Client-facing copy, in the app's own voice. Shown to the client. */
  message: string;
  /** Engineer-facing one-liner recorded next to it. */
  detail: string;
  outcome: PlannerOutcome;
}

/** Code the route/UI can branch on. */
export const PLANNING_FAILED_CODE = 'PLANNING_FAILED' as const;

/** Thrown by createProject when planning failed, AFTER the failed row is written. */
export class PlanningFailedError extends Error {
  readonly code = PLANNING_FAILED_CODE;
  readonly projectId: string;
  readonly clientMessage: string;
  readonly outcome: PlannerOutcome;

  constructor(projectId: string, failure: PlanningFailure) {
    super(failure.message);
    this.name = 'PlanningFailedError';
    this.projectId = projectId;
    this.clientMessage = failure.message;
    this.outcome = failure.outcome;
  }
}

const MAX_DETAIL = 240;

function truncate(value: unknown, max = MAX_DETAIL): string {
  const t = String(value ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** A scene candidate is usable when it carries something to say or to show. */
function isUsableScene(scene: unknown): boolean {
  if (!scene || typeof scene !== 'object') return false;
  const s = scene as Record<string, unknown>;
  const narration = String(s.narration ?? '').trim();
  const visual = String(s.visualPrompt ?? s.visual_prompt ?? '').trim();
  return narration.length > 0 || visual.length > 0;
}

/**
 * How many usable scenes a payload carries. Mirrors `parseScenes`' own shape
 * tolerance: a bare array, or `{ scenes: [...] }`.
 */
export function usableSceneCount(payload: unknown): number {
  if (!payload) return 0;
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.scenes)
      ? (payload as any).scenes
      : [];
  return arr.filter(isUsableScene).length;
}

/**
 * Pull the plan payload out of a router decision — the SAME two places the
 * pipeline reads (`decision.script`, `decision.parameters.script`) — and return
 * it ONLY when it actually contains scenes. `null` means "no plan came back",
 * which is the condition that used to be silent.
 */
export function planPayloadFromDecision(decision: unknown): any | null {
  if (!decision || typeof decision !== 'object') return null;
  const d = decision as Record<string, any>;
  const candidates = [d.script, d.parameters?.script, d.plan, d.parameters?.plan, d];
  for (const candidate of candidates) {
    if (usableSceneCount(candidate) > 0) return candidate;
  }
  return null;
}

/**
 * Describe what came back instead of a plan, for the project row and the logs.
 * Names the real shape (router decision vs empty vs prose) — the owner's rule:
 * a failure message that names the real problem is worth more than any retrying.
 */
export function describeNonPlanResponse(decision: unknown): string {
  if (decision === null || decision === undefined) return 'no response from the planning call';
  if (typeof decision !== 'object') return `non-object response: ${truncate(decision, 120)}`;
  const d = decision as Record<string, any>;
  const classification = d.classification ? String(d.classification) : '';
  const response = d.response ? truncate(d.response, 160) : '';
  const prompt = d.prompt ? truncate(d.prompt, 160) : '';
  if (classification) {
    return truncate(
      `router decision, not a plan (classification=${classification}` +
      `${prompt ? `, prompt="${prompt}"` : ''}${response ? `, response="${response}"` : ''})`,
    );
  }
  const keys = Object.keys(d);
  if (keys.length === 0) return 'empty object from the planning call';
  return truncate(`response without a scenes array (keys: ${keys.slice(0, 8).join(', ')})`);
}

/**
 * The SECOND DOOR. The same model can answer the router's classifier schema
 * instead of the planner's scene schema; restating the contract explicitly and
 * naming the wrong shape is the cheapest way to recover without spending on
 * media. Decision-only call — no image, no narration, no motion.
 */
export function plannerRetryInstruction(sceneCount: number): string {
  return `\n\nYOUR PREVIOUS REPLY WAS NOT A PLAN. It was a routing/classification object ` +
    `(fields like "classification" / "prompt" / "response"). That is not what this call needs. ` +
    `Ignore any classification instructions above. Return ONLY the plan JSON: an object with a ` +
    `top-level "scenes" array of exactly ${sceneCount} objects, each ` +
    `{ sceneNumber, duration, visualPrompt, narration }. No "classification", no "prompt", no ` +
    `"response", no markdown fences, no commentary — the JSON object and nothing else.`;
}

/**
 * THE TWO DOORS. Runs the planning call, and — only when the reply carries no
 * plan — asks once more with the contract restated (`plannerRetryInstruction`).
 * The `call` argument IS the model boundary: production passes
 * `aiRouter.route(...)`, fixtures pass a stub. Everything else here is the real
 * path the pipeline takes, so a fixture proves the pipeline's behaviour rather
 * than a paraphrase of it.
 *
 * Errors from `call` are NOT swallowed: the caller records them as
 * 'planner-call-failed'. Returns `payload: null` when neither door produced a
 * plan, which the pipeline must treat as a failed render.
 */
export async function runPlanningAttempts<T = unknown>(input: {
  sceneCount: number;
  call: (attempt: number, instruction: string) => Promise<T>;
  trace?: (message: string) => void;
}): Promise<{ payload: any | null; attempts: number; detail: string }> {
  let attempts = 0;

  attempts += 1;
  const first = await input.call(attempts, '');
  const firstPayload = planPayloadFromDecision(first);
  if (firstPayload) return { payload: firstPayload, attempts, detail: '' };
  const firstDetail = describeNonPlanResponse(first);
  input.trace?.(`gpt52_no_plan attempt=1 got=${firstDetail}`);

  attempts += 1;
  const retry = await input.call(attempts, plannerRetryInstruction(input.sceneCount));
  const retryPayload = planPayloadFromDecision(retry);
  if (retryPayload) {
    input.trace?.(`gpt52_second_door plan=ok scenes=${usableSceneCount(retryPayload)}`);
    return { payload: retryPayload, attempts, detail: '' };
  }
  const retryDetail = describeNonPlanResponse(retry);
  input.trace?.(`gpt52_second_door plan=missing got=${retryDetail}`);
  return { payload: null, attempts, detail: retryDetail || firstDetail };
}

/** The outcome when the caller supplied the script itself (owner-dictated path). */
export function suppliedScriptPlannerOutcome(at: string = new Date().toISOString()): PlannerOutcome {
  return {
    source: 'supplied-script',
    planned: false,
    reason: null,
    detail: 'script supplied by the caller — no planning call made',
    attempts: 0,
    plannerScenes: 0,
    templateScenes: 0,
    replanDiscarded: false,
    at,
  };
}

/** Classify what the planning block actually achieved. */
export function classifyPlannerOutcome(input: {
  payload: unknown;
  attempts: number;
  detail?: string;
  sceneCount: number;
  replanDiscarded?: boolean;
  at?: string;
}): PlannerOutcome {
  const at = input.at ?? new Date().toISOString();
  const usable = usableSceneCount(input.payload);
  if (usable > 0) {
    return {
      source: 'planner',
      planned: usable >= input.sceneCount,
      reason: null,
      detail: truncate(input.detail || 'plan received'),
      attempts: input.attempts,
      plannerScenes: Math.min(usable, input.sceneCount),
      templateScenes: Math.max(0, input.sceneCount - usable),
      replanDiscarded: input.replanDiscarded === true,
      at,
    };
  }
  const detail = truncate(input.detail || 'no plan returned');
  const callFailed = /planner call failed/i.test(detail);
  return {
    source: 'template',
    planned: false,
    reason: callFailed ? 'planner-call-failed' : 'planner-returned-no-plan',
    detail,
    attempts: input.attempts,
    plannerScenes: 0,
    templateScenes: input.sceneCount,
    replanDiscarded: input.replanDiscarded === true,
    at,
  };
}

/**
 * Record how many scenes came from the plan versus the template. `parseScenes`
 * pads a short plan with the deterministic arc, so a 3-of-5 plan silently ships
 * two invented scenes — that is a bypass for those scenes and must be named.
 */
export function applyTemplateFill(
  outcome: PlannerOutcome,
  plannerScenes: number,
  sceneCount: number,
): PlannerOutcome {
  const fromPlanner = Math.max(0, Math.min(plannerScenes, sceneCount));
  const templateScenes = Math.max(0, sceneCount - fromPlanner);
  const next: PlannerOutcome = { ...outcome, plannerScenes: fromPlanner, templateScenes };
  if (next.source === 'planner') {
    if (templateScenes > 0) {
      next.planned = false;
      next.reason = 'planner-incomplete-plan';
      next.detail = truncate(
        `plan covered ${fromPlanner} of ${sceneCount} scenes — ${templateScenes} would have been invented from the template`,
      );
    } else {
      next.planned = true;
      next.reason = null;
    }
  }
  return next;
}

/**
 * The client-facing sentence. Plain language, the app's own voice, no internal
 * vocabulary ("planner", "model", "fallback", "template") and no false comfort.
 */
export function plannerFailureNotice(outcome: PlannerOutcome): PlanningFailure {
  const why = outcome.reason === 'planner-call-failed'
    ? 'The step that writes your shot list could not be reached.'
    : outcome.reason === 'planner-incomplete-plan'
      ? `The shot list came back short — it covered ${outcome.plannerScenes} of ${outcome.plannerScenes + outcome.templateScenes} scenes, so the rest would have been invented instead of written for you.`
      : "The step that writes your shot list answered, but it did not come back with a shot list we could use.";
  const message =
    `We didn't make this video. ${why} ` +
    `Rather than send you something generic that ignores your brief, we stopped before rendering anything — ` +
    `no scenes were generated and no motion was purchased. Your brief is saved exactly as you wrote it. ` +
    `Press generate again in a moment; if it happens twice, reply in chat and we'll pick it up from there.`;
  return {
    code: PLANNING_FAILED_CODE,
    message,
    detail: `${outcome.reason}: ${outcome.detail}`,
    outcome,
  };
}
