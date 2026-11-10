/**
 * Veo 3.1 LITE — production motion provider for Scene + Neural Twin (owner
 * decision Sep 18 2026: "we will be getting rid of Sora").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRANSPORT: VERTEX AI (service-account OAuth) — the ONLY door this file knows.
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous transport was the Gemini AI Studio key endpoint
 * (`generativelanguage.googleapis.com/v1beta`, header `x-goog-api-key`). Google
 * retired Veo 3.1 from that endpoint, so every motion call 404'd and a client's
 * video silently lost its motion. That path is DELETED from this file — there is
 * no API-key branch, no fallback base URL and no retry against it, because a
 * retired transport that is still reachable from code is a bug waiting to happen.
 * The same model is alive on Vertex AI and this file now calls it there:
 *
 *   AUTH (service account ONLY — an API key cannot call Vertex prediction):
 *     GOOGLE_VERTEX_SA_JSON holds a Google service-account JSON.
 *     RS256 JWT (header {alg:RS256,typ:JWT,kid}, claims {iss,scope,aud,iat,exp})
 *     → POST {token_uri} grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
 *     → { access_token, expires_in }. The token is CACHED and refreshed ~60s
 *     before expiry (minting on every call would add ~200ms per poll).
 *
 *   CREATE:
 *     POST {host}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:predictLongRunning
 *     Authorization: Bearer <token>
 *     Body: { instances: [{ prompt }], parameters: { sampleCount, durationSeconds,
 *             aspectRatio, resolution, generateAudio:false } }
 *     → long-running OPERATION: { name: "projects/…/models/…/operations/<uuid>" }
 *
 *   POLL — **THIS IS THE TRAP**:
 *     POST …/models/{model}:fetchPredictOperation   body { "operationName": "<name>" }
 *     A plain GET on the operation path (`/v1/{operation.name}`) returns Google's
 *     HTML 404 page. It is NOT a liveness check and is NEVER used here.
 *     Response when finished:
 *       { done: true, response: { "@type": "…GenerateVideoResponse",
 *                                 raiMediaFilteredCount: "0",
 *                                 videos: [{ bytesBase64Encoded, mimeType }] } }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE FAILURES, THREE DIFFERENT MESSAGES (owner requirement — never collapse)
 * ─────────────────────────────────────────────────────────────────────────────
 *   PERMISSION_DENIED / IAM_PERMISSION_DENIED on aiplatform.endpoints.predict
 *     = OUR credentials/role are wrong. It is NOT a retired model. The service
 *       account exists but lacks the Vertex AI role; role propagation can take
 *       minutes.
 *   API_KEY_SERVICE_BLOCKED
 *     = an API key was used against Vertex. Vertex prediction requires a service
 *       account, never an API key.
 *   NOT_FOUND / "model … is no longer available"
 *     = genuinely retired / not available to this project.
 * These map to three DISTINCT strings (VEO_ERRORS / classifyVeoHttpError) and a
 * motion failure never surfaces as a bare HTTP code.
 *
 * CONTRACT DISCIPLINE (mirrors the ratified Sora contract, owner Sep 18):
 *   1. MODEL: veo-3.1-lite-generate-001 — the TRUE Lite code ($0.03/s video-only
 *      at 720p on Vertex; the full Veo 3.1 is $0.20/s — never used).
 *   2. DURATION: enum 4|6|8s per call — NO 12s single call. Scene/Twin call
 *      sites use 6s per-window takes (12s total motion per 30s video ≈ $0.36).
 *   3. NUMBER OF VIDEOS: sampleCount 1 — never `numberOfVideos` (zero-cost 400).
 *   4. AUDIO: generateAudio:false — Veo audio is billed ($0.05/s vs $0.03/s) and
 *      the pipeline narrates separately via GPT Audio. Never pay twice.
 *   5. EXACTLY-ONCE: the operation name is persisted (caller metadata) BEFORE
 *      any polling; retries/restarts resume-poll the SAME operation — never
 *      re-submit a paid generation.
 *   6. POLL: 5s→10s backoff via setInterval (Railway-safe — no long setTimeout),
 *      sanity cap VEO_POLL_MAX_ATTEMPTS (120 ≈ 10–20 min, far above the
 *      documented 11s–6min latency), never abandons in_progress on elapsed
 *      time; only terminal error / 404 / 5 consecutive HTTP errors abort.
 *   7. FORMAT: aspectRatio "9:16", resolution "720p".
 *
 * COST (Vertex published rates, per second of video):
 *   veo-3.1-lite-generate-001 video-only: $0.03/s @720p, $0.05/s @1080p.
 *   A 30s Scene video uses 2×6s = 12s billed ≈ $0.36 (was $0.60 at $0.05/s).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// ─── Vertex transport constants ──────────────────────────────────────────────
/** Vertex AI regional host. The verified working region is us-central1. */
export const VEO_VERTEX_HOST = 'https://us-central1-aiplatform.googleapis.com';
export const VEO_VERTEX_LOCATION = 'us-central1';
export const VEO_VERTEX_API_VERSION = 'v1';
/** Env var holding the Google service-account JSON. NOTHING else is read. */
export const VEO_VERTEX_SA_ENV = 'GOOGLE_VERTEX_SA_JSON';
/** OAuth scope for Vertex prediction. */
export const VEO_VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Google-documented Veo 3.1 Lite model on Vertex — the ONLY model production calls. */
export const VEO_MODEL = 'veo-3.1-lite-generate-001';
/** Provider tag for cost tracking (NEVER customer-visible). */
export const VEO_PROVIDER_TAG = 'veo-3.1-lite';
/** Production per-call duration (enum 4|6|8) — one 6s take per motion window. */
export const VEO_CALL_SECONDS = 6;
/**
 * WHOLE-VIDEO MOTION (owner, Nov 2 — "lets make the whole 30 seconds motion with
 * Veo for scene based"). The 12s cap from PR #89 is GONE: every scene of a Scene
 * video now gets its own motion window, and the budget is the whole video.
 * 30s is the longest Scene video the planner ever produces, so 30s is the cap.
 */
export const VEO_MOTION_BUDGET_SECONDS = 30;
/**
 * SCENE-JOIN REWORK (owner, Nov 2 — "we can do 4 6 seconds calls and 1 8 second
 * call ... with the extra 2 seconds FFmpeg has that to work with"):
 *
 *   FIVE clips for a 30s Scene video: 4 × 6s + 1 × 8s = **32s**. The 2s over the
 *   video's own length is not waste — it is the material FFmpeg folds away when it
 *   cuts each join on its best-matching frame pair (and removes any black dip), so
 *   the delivered video still lands on its planned length.
 *
 * Cost: 32s × $0.03/s = **$0.96/video** (was $0.90 at 5 × 6s). Scene is capped at
 * 2 videos/week (8/month) ⇒ **≈$7.68/client/month worst case**, ~15% of the $50 price.
 */
export const VEO_MOTION_JOIN_SLACK_SECONDS = 2;
/** Hard ceiling on billed motion per video: the 30s budget plus the 2s join slack. */
export const VEO_MOTION_PLAN_CEILING_SECONDS = VEO_MOTION_BUDGET_SECONDS + VEO_MOTION_JOIN_SLACK_SECONDS;
/** The long clip the owner's plan buys for the FINAL scene (Veo's 8s tier). */
export const VEO_LONG_CLIP_SECONDS = 8;
/**
 * The legal per-call durations Veo 3.1 Lite accepts. Anything else is a 400.
 * A scene shorter than one 6s call is billed at the 4s tier (never padded up);
 * a scene longer than 7s is billed at 8s. See nearestLegalVeoSeconds().
 */
export const VEO_LEGAL_DURATIONS = [4, 6, 8] as const;
/** Max number of motion windows a single video can buy (30s / 6s). */
export const VEO_MAX_MOTION_WINDOWS = 5;
/** Vertex published price, veo-3.1-lite video-only @720p, per second. */
export const VEO_USD_PER_SECOND_720P = 0.03;
/** Billed dollars for N seconds of Lite motion at 720p (video-only). */
export function veoCostUsd(billedSeconds: number): number {
  const s = Number.isFinite(billedSeconds) && billedSeconds > 0 ? billedSeconds : 0;
  return Math.round(s * VEO_USD_PER_SECOND_720P * 10000) / 10000;
}
/**
 * Snap a scene's planned narration window onto Veo's 4|6|8 enum.
 *   < 6s  → 4  (the short tier — a short beat never buys 6s it cannot use)
 *   < 7s  → 6  (the standard tier)
 *   >= 7s → 8
 * Pure + deterministic. The returned value is what the CALL costs; the scene's
 * own planned length is untouched — the take is fitted to it downstream.
 */
export function nearestLegalVeoSeconds(sceneSeconds: number): number {
  const d = Number.isFinite(sceneSeconds) ? sceneSeconds : VEO_CALL_SECONDS;
  if (d < 6) return 4;
  if (d < 7) return 6;
  return 8;
}
/**
 * THE DURATION PLAN for Scene mode (owner, Nov 2): **4 × 6s + 1 × 8s = 32s** for a
 * five-scene 30s video, generalised so any scene count still works:
 *
 *   - every clip is 6s (Veo's standard tier) except
 *   - the LAST clip, which is 8s when the total still fits inside the 30s budget
 *     plus the 2s join slack (it always does for n ≤ 5) — that long clip is what
 *     gives the assembly material to fold into the joins.
 *   - a single-scene video buys one 6s clip: with no join there is nothing to fold,
 *     so the long tier would be pure waste.
 *
 * Pure + deterministic. Never exceeds VEO_MOTION_PLAN_CEILING_SECONDS (32s).
 */
export function planVeoClipDurations(sceneCount: number, targetSeconds?: number): number[] {
  // TARGET-SUM FORM (owner Nov 10): "16 seconds in two calls" is a SUM, not a
  // count — the scene-shaped plan below cannot express it (n=2 → [6, 8] = 14s).
  if (Number.isFinite(targetSeconds) && Number(targetSeconds) > 0) {
    const planned = planVeoTargetSumDurations(
      Number(targetSeconds),
      Math.max(1, Math.floor(Number(sceneCount) || 1)),
    );
    if (planned.length) return planned;
  }
  const n = Math.max(0, Math.min(Math.floor(Number(sceneCount) || 0), VEO_MAX_MOTION_WINDOWS));
  if (n === 0) return [];
  if (n === 1) return [VEO_CALL_SECONDS];
  const shortClips = n - 1;
  const total = shortClips * VEO_CALL_SECONDS + VEO_LONG_CLIP_SECONDS;
  const last = total <= VEO_MOTION_PLAN_CEILING_SECONDS ? VEO_LONG_CLIP_SECONDS : VEO_CALL_SECONDS;
  return [...Array(shortClips).fill(VEO_CALL_SECONDS), last];
}
/** Total billed seconds for a plan (cost + the 32s ceiling check). */
export function planVeoClipDurationsTotal(sceneCount: number): number {
  return planVeoClipDurations(sceneCount).reduce((a, b) => a + b, 0);
}
/**
 * FACELESS MOTION BUDGET (owner-approved cost model, rev 192 — Nov 10):
 * a 30-second Faceless video spends **16 seconds of Veo in TWO 8-second calls**
 * and the other 14 seconds on stills. Before this, only CAPS existed (a 30s
 * budget, a 5-window cap, and planVeoClipDurations(2) → [6, 8] = 14s), so there
 * was no way to express "16 seconds total, in two calls".
 */
export const VEO_FACELESS_MOTION_TARGET_SECONDS = 16;
export const VEO_FACELESS_MOTION_CALLS = 2;
/**
 * THE TARGET-SUM PLAN: legal Veo durations (4|6|8) summing to EXACTLY
 * `targetSeconds` in at most `maxCalls` calls.
 *
 * Deterministic: fewest calls first, then the longest tier first, so 16s in two
 * calls is exactly [8, 8] — never [6, 6, 4] and never the 14s [6, 8] the
 * scene-shaped planner produces. Returns [] when the target cannot be expressed
 * with the enum (the caller then falls back to a single legal clip).
 */
export function planVeoTargetSumDurations(targetSeconds: number, maxCalls: number = VEO_FACELESS_MOTION_CALLS): number[] {
  const target = Math.round(Number(targetSeconds));
  const cap = Math.max(1, Math.min(Math.floor(Number(maxCalls) || 1), VEO_MAX_MOTION_WINDOWS));
  if (!Number.isFinite(target) || target <= 0) return [];
  const legal = [...VEO_LEGAL_DURATIONS].sort((a, b) => b - a); // 8, 6, 4
  const walk = (remaining: number, callsLeft: number, acc: number[]): number[] | null => {
    if (remaining === 0) return acc;
    if (callsLeft === 0 || remaining < 0) return null;
    for (const d of legal) {
      if (d > remaining) continue;
      const out = walk(remaining - d, callsLeft - 1, [...acc, d]);
      if (out) return out;
    }
    return null;
  };
  for (let calls = 1; calls <= cap; calls++) {
    const plan = walk(target, calls, []);
    if (plan) return plan;
  }
  return [];
}
export const VEO_ASPECT_RATIO = '9:16';
export const VEO_RESOLUTION = '720p';
/** Kept for compatibility with the pre-Vertex contract. NOT sent on the Vertex
 *  transport: the verified Vertex request omits personGeneration (Vertex's own
 *  Veo text-to-video enum is allow_adult|dont_allow — 'allow_all' is not a safe
 *  value to send and an unverified parameter is a 400 on every motion call). */
export const VEO_PERSON_GENERATION = 'allow_all';
export const VEO_POLL_MAX_ATTEMPTS = 120; // sanity cap (~10–20 min) — never abandons in_progress on elapsed time
export const VEO_POLL_BASE_DELAY_MS = 5_000;
export const VEO_POLL_MAX_DELAY_MS = 10_000;
/** Refresh the cached OAuth token this many ms before it actually expires. */
export const VEO_TOKEN_REFRESH_MARGIN_MS = 60_000;

// ─── Three distinct failure messages (owner requirement) ─────────────────────
export const VEO_ERRORS = {
  /** Missing / unparseable GOOGLE_VERTEX_SA_JSON. No API-key fallback exists. */
  credentialsMissing:
    `${VEO_PROVIDER_TAG}: no Google service-account credential — ${VEO_VERTEX_SA_ENV} is missing, empty or unparseable. ` +
    `Vertex prediction requires a service account; there is no API-key fallback and no text-to-image fallback.`,
  /** 403 PERMISSION_DENIED / IAM_PERMISSION_DENIED — OUR role, not a dead model. */
  permissionDenied:
    `${VEO_PROVIDER_TAG}: our Google credentials were rejected (PERMISSION_DENIED on aiplatform.endpoints.predict) — ` +
    `the service account in ${VEO_VERTEX_SA_ENV} lacks the Vertex AI role (needs roles/aiplatform.user). ` +
    `This is OUR credential/role problem, NOT a retired model.`,
  /** API_KEY_SERVICE_BLOCKED — an API key was used against Vertex. */
  apiKeyBlocked:
    `${VEO_PROVIDER_TAG}: Vertex prediction requires a Google SERVICE ACCOUNT (API_KEY_SERVICE_BLOCKED) — ` +
    `an API key can never call this endpoint. No motion was generated.`,
  /**
   * IMAGE-TO-VIDEO REJECTED. Owner rule: the clip MUST begin from the frame we
   * designed (the scene's still, built from the client's brief and their uploaded
   * photo). If the provider refuses the input image we say so BY NAME on the scene
   * record — we never quietly downgrade to text-to-video, because a silent downgrade
   * is a video that ignores what the client asked for.
   */
  imageRejected:
    `${VEO_PROVIDER_TAG}: the input image was REJECTED — the clip could not be started from the scene's designed still. ` +
    `This is NOT a silent text-to-video fallback: the scene has no faithful motion rather than wrong motion.`,
  /**
   * LAST-FRAME REJECTED (owner, Nov 2 — scene-join rework). Clips 1..n-1 are told
   * to END on the NEXT scene's designed picture via Veo's `lastFrame` input, so the
   * two clips meet on the same image and FFmpeg can cut on the matching frame.
   * If the provider refuses that steering image we say so BY NAME: we never quietly
   * drop the target (a dropped target = a join that does not line up, silently).
   */
  lastFrameRejected:
    `${VEO_PROVIDER_TAG}: the LAST-FRAME image was REJECTED — this clip could not be steered to end on the next scene's designed still. ` +
    `The join target was NOT dropped and the call was NOT downgraded: the scene has no join-steered motion rather than an unaligned one.`,
} as const;
/** Loud, named failure for "the next scene's still (the join target) could not be read". */
export function veoLastFrameMissingMessage(sceneKey: string, reason: string): string {
  return (
    `${VEO_PROVIDER_TAG}: scene ${sceneKey} has NO readable join target — ${reason}. ` +
    `Clips 1..n-1 must end on the NEXT scene's designed still (Veo lastFrame); the target is never silently dropped and the call never falls back to text-to-video.`
  );
}
/** Loud, named failure for "we had a join target but the provider would not take it". */
export function veoLastFrameRejectedMessage(detail: string): string {
  return `${VEO_ERRORS.lastFrameRejected} (${String(detail || 'no detail').slice(0, 240)})`;
}
/** Loud, named failure for "we had a still but the provider would not take it". */
export function veoImageRejectedMessage(detail: string): string {
  return `${VEO_ERRORS.imageRejected} (${String(detail || 'no detail').slice(0, 240)})`;
}
/** Loud, named failure for "this scene should have had a still and did not". */
export function veoImageMissingMessage(sceneKey: string, reason: string): string {
  return (
    `${VEO_PROVIDER_TAG}: scene ${sceneKey} has NO designed still to animate — ${reason}. ` +
    `Image-to-video needs the scene's still as its first frame; there is no text-to-video fallback.`
  );
}
/** NOT_FOUND / retired-model message (model id interpolated so the log is actionable). */
export function veoModelUnavailableMessage(model: string = VEO_MODEL): string {
  return `${VEO_PROVIDER_TAG}: the model ${model} is unavailable (NOT_FOUND) — it has been retired or is not ` +
    `granted to this Google project. No motion was generated.`;
}

/** The image-to-video input image (Google `VideoGenerationModelInstance.Image`).
 *  Documented shape: `{ mimeType, bytesBase64Encoded | gcsUri }`, mimeType one of
 *  image/jpeg | image/png. Verified live 2026-11-02 (see veoLiteProduction.test.ts). */
export interface VeoInputImage { bytesBase64Encoded: string; mimeType: string; }
export interface VeoGenerateOptions {
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  durationSeconds?: number;
  personGeneration?: string;
  /** Samples per call. Always 1 — the API returns one video. */
  sampleCount?: number;
  /** Vertex bills audio separately ($0.05/s vs $0.03/s). Production: false. */
  generateAudio?: boolean;
  /** IMAGE-TO-VIDEO: the scene's designed still becomes the clip's FIRST FRAME. */
  image?: VeoInputImage;
  /**
   * JOIN STEERING (owner, Nov 2 — scene-join rework): the NEXT scene's designed
   * still, sent as Veo's `lastFrame` so the clip is told to END on that picture.
   * Documented on `VideoGenerationModelInstance` alongside `image`, same Image
   * shape ({mimeType, bytesBase64Encoded | gcsUri}). It STEERS but does not land
   * (measured: 21.91 dB against the target vs a true match of ~45 dB), which is
   * exactly why the assembly still cuts on the best-matching frame pair.
   */
  lastFrame?: VeoInputImage;
}
export interface VeoVideoPayload { uri?: string; data?: string; }
export interface VeoPollResult { done: boolean; error?: string; video?: VeoVideoPayload; }
export interface VeoSceneGenerateOptions {
  prompt: string;
  /** e.g. "block0-scene3" — used for the local filename + persisted job key. */
  sceneKey: string;
  /** Resumed operation name when an earlier attempt already created one —
   *  exactly-once: NEVER a second paid submission. */
  existingOperationName?: string;
  /** Called with the operation name BEFORE any polling — caller MUST persist it. */
  onOperationCreated: (operationName: string) => void | Promise<void>;
  /** 4|6|8 per call. Defaults to VEO_CALL_SECONDS (6). */
  durationSeconds?: number;
  /**
   * IMAGE-TO-VIDEO. Local path to the scene's designed still (the frame the
   * pipeline generated from the client's brief + their uploaded photo). When
   * present the clip STARTS from that exact frame. When absent, the call is
   * text-to-video — callers that own a still MUST pass it.
   */
  imagePath?: string;
  /**
   * JOIN STEERING (owner, Nov 2): local path to the NEXT scene's designed still.
   * Clips 1..n-1 pass it so the clip is asked to END on that picture; the LAST
   * clip passes nothing. A path that exists in the plan but cannot be read is a
   * LOUD failure — the target is never silently dropped.
   */
  lastFramePath?: string;
}

// ─── Service-account credential ──────────────────────────────────────────────
export interface VertexServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri: string;
  project_id: string;
}
/** Thrown for credential problems — distinct from a transport/HTTP failure. */
export class VeoCredentialError extends Error {
  constructor(message: string) { super(message); this.name = 'VeoCredentialError'; }
}
/**
 * Parse GOOGLE_VERTEX_SA_JSON into a usable credential. Fails LOUDLY and
 * immediately — never falls back to an API key, never falls back to text-to-image.
 */
export function parseVertexServiceAccount(raw: string | undefined | null): VertexServiceAccount {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new VeoCredentialError(`${VEO_ERRORS.credentialsMissing} (env var unset or empty)`);
  }
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (err: any) {
    throw new VeoCredentialError(`${VEO_ERRORS.credentialsMissing} (invalid JSON: ${err?.message || 'parse error'})`);
  }
  const client_email = typeof json?.client_email === 'string' ? json.client_email.trim() : '';
  // Env vars often carry the PEM with literal "\n" escapes — normalize both forms.
  const private_key = typeof json?.private_key === 'string' ? json.private_key.replace(/\\n/g, '\n').trim() : '';
  const project_id = typeof json?.project_id === 'string' ? json.project_id.trim() : '';
  if (!client_email || !private_key || !project_id) {
    const missing = [!client_email && 'client_email', !private_key && 'private_key', !project_id && 'project_id'].filter(Boolean).join(', ');
    throw new VeoCredentialError(`${VEO_ERRORS.credentialsMissing} (service-account JSON is missing ${missing})`);
  }
  return {
    client_email,
    private_key,
    private_key_id: typeof json?.private_key_id === 'string' ? json.private_key_id : undefined,
    token_uri: typeof json?.token_uri === 'string' && json.token_uri ? json.token_uri : 'https://oauth2.googleapis.com/token',
    project_id,
  };
}
/** RS256 service-account JWT (the assertion half of the OAuth jwt-bearer grant). */
export function buildVertexJwt(
  sa: VertexServiceAccount,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  lifetimeSeconds = 3600,
): string {
  const header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' };
  if (sa.private_key_id) header.kid = sa.private_key_id;
  const claims = {
    iss: sa.client_email,
    scope: VEO_VERTEX_SCOPE,
    aud: sa.token_uri,
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key, 'base64url');
  return `${signingInput}.${signature}`;
}
interface VertexTokenCacheEntry { accessToken: string; expiresAtMs: number; credentialKey: string; }
/**
 * Mints + CACHES a Vertex OAuth access token. One mint per credential per hour,
 * not one per poll. `now` is injectable so expiry/refresh is testable without
 * sleeping and without touching the network.
 */
export class VertexTokenProvider {
  private cache?: VertexTokenCacheEntry;
  private inflight?: { key: string; promise: Promise<string> };
  /** Injectable clock (tests advance it to prove refresh-before-expiry). */
  public now: () => number = () => Date.now();
  public refreshMarginMs = VEO_TOKEN_REFRESH_MARGIN_MS;
  reset(): void { this.cache = undefined; this.inflight = undefined; }
  private credentialKey(sa: VertexServiceAccount): string {
    return `${sa.client_email}|${sa.private_key_id || ''}|${sa.token_uri}|${sa.project_id}`;
  }
  async getAccessToken(sa: VertexServiceAccount): Promise<string> {
    const key = this.credentialKey(sa);
    const nowMs = this.now();
    if (this.cache && this.cache.credentialKey === key && this.cache.expiresAtMs - this.refreshMarginMs > nowMs) {
      return this.cache.accessToken;
    }
    if (this.inflight && this.inflight.key === key) return this.inflight.promise;
    const promise = this.mintToken(sa, key).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined;
    });
    this.inflight = { key, promise };
    return promise;
  }
  private async mintToken(sa: VertexServiceAccount, key: string): Promise<string> {
    const nowMs = this.now();
    const assertion = buildVertexJwt(sa, Math.floor(nowMs / 1000));
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString();
    let res: Response;
    try {
      res = await fetch(sa.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      throw new VeoCredentialError(
        `${VEO_PROVIDER_TAG}: could not reach Google's token endpoint (${sa.token_uri}) — ${err?.message || 'network error'}`,
      );
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // A rejected assertion = OUR credentials (bad/rotated key, clock skew, wrong client).
      throw new VeoCredentialError(
        `${VEO_PROVIDER_TAG}: Google rejected our service-account assertion (HTTP ${res.status} from ${sa.token_uri}) — ` +
        `the credential in ${VEO_VERTEX_SA_ENV} is invalid, revoked or clock-skewed. ${text.slice(0, 200)}`.trim(),
      );
    }
    let json: any;
    try { json = JSON.parse(text); } catch { json = null; }
    const accessToken = typeof json?.access_token === 'string' ? json.access_token : '';
    if (!accessToken) {
      throw new VeoCredentialError(
        `${VEO_PROVIDER_TAG}: Google's token endpoint returned no access_token — ${text.slice(0, 200)}`.trim(),
      );
    }
    const expiresIn = Number(json?.expires_in);
    const ttlMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    this.cache = { accessToken, expiresAtMs: this.now() + ttlMs, credentialKey: key };
    console.log(`[Veo] veo_token_minted sa=${sa.client_email} ttl=${Math.round(ttlMs / 1000)}s`);
    return accessToken;
  }
}
export const vertexTokenProvider = new VertexTokenProvider();

// ─── HTTP error classification (three distinct messages) ─────────────────────
export type VeoErrorContext = 'create' | 'poll' | 'download';
/**
 * Map an upstream failure to ONE of the three distinct messages (or a
 * context-rich generic one). Never returns a bare HTTP code.
 */
export function classifyVeoHttpError(
  status: number,
  bodyText: string,
  context: VeoErrorContext,
  model: string = VEO_MODEL,
): string {
  const body = String(bodyText || '');
  // 1. An API key was used against Vertex — the only fix is a service account.
  if (/API_KEY_SERVICE_BLOCKED/i.test(body)) return VEO_ERRORS.apiKeyBlocked;
  // 2. Genuinely retired / unavailable model.
  if (/no longer available|has been retired|shut down|Publisher Model .* was not found|NOT_FOUND/i.test(body)) {
    return veoModelUnavailableMessage(model);
  }
  // 3. OUR credentials/role — NOT a retired model.
  if (/PERMISSION_DENIED|IAM_PERMISSION_DENIED|permission .* denied/i.test(body) || status === 403) {
    return `${VEO_ERRORS.permissionDenied} [HTTP ${status} on ${context}]`;
  }
  if (status === 404) {
    if (context === 'poll') {
      return `${VEO_PROVIDER_TAG}: operation not found (HTTP 404) on fetchPredictOperation — the long-running operation no longer exists on Vertex, so there is nothing to resume.`;
    }
    if (context === 'create') return `${veoModelUnavailableMessage(model)} [HTTP 404 on create]`;
  }
  return `${VEO_PROVIDER_TAG}: ${context} failed (HTTP ${status}) — ${body.slice(0, 240) || 'no response body'}`;
}

// ─── Request/response helpers ────────────────────────────────────────────────
/** Build the predictLongRunning POST body. `instances[0].prompt` is the text
 *  content; `instances[0].image` (image-to-video) is the scene's designed still,
 *  which becomes the clip's FIRST FRAME. Generation params ride in Vertex's
 *  top-level `parameters`. `numberOfVideos` is NEVER sent (verified zero-cost 400). */
export function buildVeoPredictBody(prompt: string, options: VeoGenerateOptions = {}): Record<string, unknown> {
  const instance: Record<string, unknown> = { prompt };
  if (options.image && options.image.bytesBase64Encoded) {
    // Google `VideoGenerationModelInstance.Image`: mimeType + bytesBase64Encoded.
    instance.image = {
      bytesBase64Encoded: options.image.bytesBase64Encoded,
      mimeType: options.image.mimeType,
    };
  }
  // JOIN STEERING: `lastFrame` is the documented sibling of `image` on the same
  // instance — the picture the clip is asked to END on. Same Image shape.
  if (options.lastFrame && options.lastFrame.bytesBase64Encoded) {
    instance.lastFrame = {
      bytesBase64Encoded: options.lastFrame.bytesBase64Encoded,
      mimeType: options.lastFrame.mimeType,
    };
  }
  const body: Record<string, unknown> = { instances: [instance] };
  const parameters: Record<string, unknown> = {};
  if (options.sampleCount !== undefined) parameters.sampleCount = options.sampleCount;
  if (options.aspectRatio) parameters.aspectRatio = options.aspectRatio;
  if (options.resolution) parameters.resolution = options.resolution;
  if (options.durationSeconds !== undefined) parameters.durationSeconds = options.durationSeconds;
  if (options.personGeneration) parameters.personGeneration = options.personGeneration;
  if (options.generateAudio !== undefined) parameters.generateAudio = options.generateAudio;
  if (Object.keys(parameters).length > 0) body.parameters = parameters;
  return body;
}
/** MIME type for a still on disk. Veo accepts image/jpeg and image/png only. */
export function veoImageMimeType(filePath: string): string {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/png';
}
/** Read a still from disk into the documented image-to-video input shape.
 *  Throws (loud) when the file is missing or empty — a caller that owns a still
 *  must never silently fall back to text-to-video. */
export function loadVeoInputImage(filePath: string): VeoInputImage {
  const buf = fs.readFileSync(filePath);
  if (!buf.length) throw new Error(`input image is empty: ${filePath}`);
  return { bytesBase64Encoded: buf.toString('base64'), mimeType: veoImageMimeType(filePath) };
}
/** The create response is a long-running operation — the name MUST be present. */
export function parseVeoOperationName(createJson: any): string {
  const name = createJson?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Veo create response missing operation name: ${JSON.stringify(createJson).slice(0, 240)}`);
  }
  return name;
}
export function extractVeoVideoPayload(video: any): VeoVideoPayload | undefined {
  if (!video) return undefined;
  if (typeof video.uri === 'string' && video.uri.length > 0) return { uri: video.uri };
  const data = video.data ?? video.videoBytes ?? video.bytesBase64Encoded ?? video.inlineData?.data;
  if (typeof data === 'string' && data.length > 0) return { data };
  return undefined;
}
/** Parse a fetchPredictOperation response into a structured result.
 *  Vertex (the documented path): .response.videos[].bytesBase64Encoded.
 *  Tolerated legacy shapes: .response.generateVideoResponse.generatedSamples[]
 *  .video and .response.generatedVideos[].video. */
export function parseVeoOperation(pollJson: any): VeoPollResult {
  if (!pollJson) return { done: false };
  if (pollJson.done !== true) return { done: false };
  if (pollJson.error) {
    const err = pollJson.error;
    // An operation that failed for auth/retired reasons still gets its own message.
    const status = Number(err?.code);
    const message = String(err?.message ?? '');
    if (/PERMISSION_DENIED|IAM_PERMISSION_DENIED/i.test(message) || status === 7 || status === 403) {
      return { done: true, error: VEO_ERRORS.permissionDenied };
    }
    if (/no longer available|NOT_FOUND/i.test(message) || status === 5 || status === 404) {
      return { done: true, error: veoModelUnavailableMessage() };
    }
    return { done: true, error: `Veo operation failed: ${JSON.stringify(err).slice(0, 300)}` };
  }
  const resp = pollJson.response || {};
  // Vertex documented path — the video object IS the array element.
  const vertexVideos: any[] | undefined = Array.isArray(resp.videos) ? resp.videos : undefined;
  const gvr = resp.generateVideoResponse;
  const samples: any[] | undefined = gvr?.generatedSamples;
  const alt: any[] | undefined = resp.generatedVideos;
  const arr = vertexVideos && vertexVideos.length > 0 ? vertexVideos
    : (Array.isArray(samples) && samples.length > 0 ? samples
      : (Array.isArray(alt) && alt.length > 0 ? alt : undefined));
  // Safety filter terminal states — never charge-for-nothing ambiguity.
  const filteredCount = Number(resp.raiMediaFilteredCount);
  if (gvr?.raiMediaFiltered === true || resp.raiMediaFiltered === true || (Number.isFinite(filteredCount) && filteredCount > 0)) {
    return { done: true, error: 'Veo: media filtered by safety (raiMediaFiltered)' };
  }
  const first = arr?.[0];
  // Vertex elements carry the bytes directly; the legacy shapes nest them in .video.
  const payload = extractVeoVideoPayload(first?.video ?? first);
  if (!payload) {
    return { done: true, error: `Veo done but no video payload: ${JSON.stringify(resp).slice(0, 300)}` };
  }
  return { done: true, video: payload };
}
export function buildVeoCreateUrl(
  projectId: string,
  model: string = VEO_MODEL,
  location: string = VEO_VERTEX_LOCATION,
): string {
  return `${VEO_VERTEX_HOST}/${VEO_VERTEX_API_VERSION}/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;
}
/** fetchPredictOperation — the ONLY poll door. A plain GET on the operation path
 *  returns Google's HTML 404 page and is never used as a liveness check. */
export function buildVeoPollUrl(
  projectId: string,
  model: string = VEO_MODEL,
  location: string = VEO_VERTEX_LOCATION,
): string {
  return `${VEO_VERTEX_HOST}/${VEO_VERTEX_API_VERSION}/projects/${projectId}/locations/${location}/publishers/google/models/${model}:fetchPredictOperation`;
}

export class VeoVideoService {
  /** Test seam: tests set this to 0 so polls are instant; prod keeps 5s→10s. */
  public pollDelayMs = VEO_POLL_BASE_DELAY_MS;
  /** Token cache shared by every scene — one mint per credential per hour. */
  public tokens: VertexTokenProvider = vertexTokenProvider;
  /**
   * Generate ONE Veo scene take with EXACTLY-ONCE semantics:
   *   1. Resolve the service-account credential (fail loud, no fallbacks).
   *   2. If opts.existingOperationName is present → skip the paid CREATE and
   *      resume-poll that operation (crash/retry resume).
   *   3. Else POST predictLongRunning → onOperationCreated(name) BEFORE polling.
   *   4. Poll (5s→10s backoff) until done / terminal error.
   *   5. Save the video (inline base64 — the Vertex path — or a signed https uri).
   */
  async generateSceneVideo(opts: VeoSceneGenerateOptions): Promise<{ success: boolean; error?: string; videoPath?: string; operationName?: string; billedSeconds?: number; estimatedUsd?: number; usedImage?: boolean; usedLastFrame?: boolean }> {
    const model = VEO_MODEL;
    const billedSeconds = opts.durationSeconds ?? VEO_CALL_SECONDS;
    let operationName: string | undefined = opts.existingOperationName;
    let sa: VertexServiceAccount;
    try {
      sa = parseVertexServiceAccount(process.env[VEO_VERTEX_SA_ENV]);
    } catch (error: any) {
      console.error(`[Veo] veo_credentials_missing scene=${opts.sceneKey} error=${error.message}`);
      return { success: false, error: error.message, operationName };
    }
    // IMAGE-TO-VIDEO: the scene's designed still becomes the clip's FIRST FRAME.
    // Loaded BEFORE the create so a missing/unreadable still fails loud and free
    // (no paid call, no silent text-to-video downgrade).
    let inputImage: VeoInputImage | undefined;
    if (opts.imagePath) {
      try {
        inputImage = loadVeoInputImage(opts.imagePath);
      } catch (error: any) {
        const msg = veoImageMissingMessage(opts.sceneKey, `could not read the still at ${opts.imagePath}: ${error?.message || 'unknown error'}`);
        console.error(`[Veo] veo_input_image_unreadable scene=${opts.sceneKey} path=${opts.imagePath} error=${error?.message}`);
        return { success: false, error: msg, operationName };
      }
    }
    // JOIN STEERING: the next scene's designed still (the picture this clip must
    // END on). Loaded BEFORE the create for the same reason as the still: a bad
    // target fails loud and free, and is NEVER silently dropped.
    let lastFrameImage: VeoInputImage | undefined;
    if (opts.lastFramePath) {
      try {
        lastFrameImage = loadVeoInputImage(opts.lastFramePath);
      } catch (error: any) {
        const msg = veoLastFrameMissingMessage(opts.sceneKey, `could not read the join target at ${opts.lastFramePath}: ${error?.message || 'unknown error'}`);
        console.error(`[Veo] veo_last_frame_unreadable scene=${opts.sceneKey} path=${opts.lastFramePath} error=${error?.message}`);
        return { success: false, error: msg, operationName };
      }
    }
    try {
      if (!operationName) {
        const body = buildVeoPredictBody(opts.prompt, {
          sampleCount: 1,
          aspectRatio: VEO_ASPECT_RATIO,
          resolution: VEO_RESOLUTION,
          durationSeconds: billedSeconds,
          generateAudio: false, // billed separately on Vertex; the pipeline narrates itself
          ...(inputImage ? { image: inputImage } : {}),
          ...(lastFrameImage ? { lastFrame: lastFrameImage } : {}),
        });
        const createUrl = buildVeoCreateUrl(sa.project_id, model);
        console.log(`[Veo] veo_create_post model=${model} project=${sa.project_id} scene=${opts.sceneKey} dur=${billedSeconds}s image=${inputImage ? 'yes' : 'no'} lastFrame=${lastFrameImage ? 'yes' : 'no'}`);
        const token = await this.tokens.getAccessToken(sa);
        const createRes = await fetch(createUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (!createRes.ok) {
          const text = await createRes.text().catch(() => '');
          // An image-bearing call rejected for image reasons gets its OWN message —
          // never a generic HTTP code, and never a quiet retry as text-to-video.
          // A lastFrame-bearing call gets its OWN message too: the join target was
          // not dropped, it was refused.
          const mapped = lastFrameImage && /image|mime|jpeg|png|base64|last.?frame/i.test(text)
            ? veoLastFrameRejectedMessage(`HTTP ${createRes.status}: ${text}`)
            : inputImage && /image|mime|jpeg|png|base64/i.test(text)
              ? veoImageRejectedMessage(`HTTP ${createRes.status}: ${text}`)
              : classifyVeoHttpError(createRes.status, text, 'create', model);
          console.error(`[Veo] veo_create_failed scene=${opts.sceneKey} status=${createRes.status} image=${inputImage ? 'yes' : 'no'} lastFrame=${lastFrameImage ? 'yes' : 'no'} error=${mapped}`);
          return { success: false, error: mapped, operationName };
        }
        const createJson = await createRes.json().catch(() => null);
        operationName = parseVeoOperationName(createJson);
        // EXACTLY-ONCE: persist the operation name BEFORE the first poll so a
        // crash mid-poll resumes THIS SAME operation, never a second paid POST.
        await opts.onOperationCreated(operationName);
        console.log(`[Veo] veo_operation_created scene=${opts.sceneKey} op=${operationName}`);
      } else {
        console.log(`[Veo] veo_operation_resume scene=${opts.sceneKey} op=${operationName}`);
      }
      // STEP 2: POLL (resume-safe, 5s→10s setInterval backoff, sanity cap only)
      const poll = await this.pollOperation(operationName, sa, opts.sceneKey);
      if (!poll.done && !poll.error) {
        // Sanity cap hit while still in_progress — job survives; caller must
        // resume the SAME operation later (exactly-once).
        return { success: false, error: `Veo poll sanity cap exceeded (still in_progress, resume-safe)`, operationName };
      }
      if (poll.error) return { success: false, error: poll.error, operationName };
      // STEP 3: SAVE (inline base64 from Vertex, or a signed https uri)
      const videoPath = await this.saveVideo(poll.video!, sa, opts.sceneKey);
      console.log(`[Veo] veo_scene_downloaded scene=${opts.sceneKey} path=${videoPath} billed=${billedSeconds}s usd=${veoCostUsd(billedSeconds)} lastFrame=${lastFrameImage ? 'yes' : 'no'}`);
      return { success: true, videoPath, operationName, billedSeconds, estimatedUsd: veoCostUsd(billedSeconds), usedImage: Boolean(inputImage), usedLastFrame: Boolean(lastFrameImage) };
    } catch (error: any) {
      console.error(`[VeoVideoService] scene ${opts.sceneKey} failed: ${error.message}`);
      return { success: false, error: error.message, operationName };
    }
  }
  private async pollOperation(operationName: string, sa: VertexServiceAccount, sceneKey: string): Promise<VeoPollResult> {
    let attempt = 0;
    let consecutiveErrors = 0;
    const pollUrl = buildVeoPollUrl(sa.project_id);
    while (attempt < VEO_POLL_MAX_ATTEMPTS) {
      attempt++;
      // Railway-safe sleep: setInterval self-clearing, NEVER a long setTimeout.
      // 5s for the first ~minute, then 10s; 0 in tests (pollDelayMs = 0).
      const waitMs = this.pollDelayMs > 0 ? (attempt > 6 ? VEO_POLL_MAX_DELAY_MS : VEO_POLL_BASE_DELAY_MS) : 0;
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => { clearInterval(interval); resolve(); }, waitMs);
        });
      }
      try {
        // Token is cached by the provider; this is a no-op after the first mint.
        const token = await this.tokens.getAccessToken(sa);
        const res = await fetch(pollUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ operationName }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 404) {
          console.error(`[Veo] veo_poll_404 scene=${sceneKey} op=${operationName}`);
          const text = await res.text().catch(() => '');
          return { done: false, error: classifyVeoHttpError(404, text, 'poll') };
        }
        if (res.status === 403 || res.status === 401) {
          const text = await res.text().catch(() => '');
          return { done: false, error: classifyVeoHttpError(res.status, text, 'poll') };
        }
        if (!res.ok) {
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            return { done: false, error: `Veo poll: ${consecutiveErrors} consecutive HTTP errors (${res.status})` };
          }
          continue;
        }
        consecutiveErrors = 0;
        const json = await res.json().catch(() => null);
        const result = parseVeoOperation(json);
        if (result.error) {
          console.error(`[Veo] veo_poll_terminal scene=${sceneKey} error=${result.error}`);
          return result;
        }
        if (result.done) {
          console.log(`[Veo] veo_poll_done scene=${sceneKey} polls=${attempt}`);
          return result;
        }
        if (attempt % 15 === 0) {
          console.log(`[VeoVideoService] Polling ${operationName}: attempt ${attempt}`);
        }
      } catch (err: any) {
        if (err instanceof VeoCredentialError) return { done: false, error: err.message };
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          return { done: false, error: `Veo poll: ${consecutiveErrors} consecutive network errors` };
        }
      }
    }
    console.error(`[Veo] veo_poll_cap scene=${sceneKey} attempts=${VEO_POLL_MAX_ATTEMPTS}`);
    return { done: false };
  }
  /** Persist the generated clip. Vertex returns inline base64 (no download at
   *  all); a signed https uri is fetched with the Bearer token. */
  private async saveVideo(payload: VeoVideoPayload, sa: VertexServiceAccount, sceneKey: string): Promise<string> {
    const dir = path.join(process.cwd(), 'temp', 'veo');
    await fs.promises.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, `${sceneKey}_${uuidv4().slice(0, 8)}.mp4`);
    if (payload.data) {
      await fs.promises.writeFile(outPath, Buffer.from(payload.data, 'base64'));
      return outPath;
    }
    const uri = payload.uri!;
    if (uri.startsWith('gs://')) {
      throw new Error('Veo returned a raw gs:// URI (signed https URL or inline base64 expected)');
    }
    const token = await this.tokens.getAccessToken(sa);
    const res = await fetch(uri, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(classifyVeoHttpError(res.status, text, 'download'));
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(outPath, buffer);
    return outPath;
  }
}
export const veoVideoService = new VeoVideoService();
