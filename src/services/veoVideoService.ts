/**
 * Veo 3.1 LITE — production motion provider for Scene + Neural Twin (owner
 * decision Sep 18 2026: "we will be getting rid of Sora"). Ported from the
 * owner-directed TEST path (PR #87, verified LIVE Sep 15–17: 6 ops, 48 billed s
 * ≈ $2.40) into the production call sites. Sora contract code stays in the repo
 * (harmless) but is NO LONGER called from Scene/Twin.
 *
 * REST CONTRACT (verified against Google's own docs 2026-09-15, page updated
 * 2026-09-09 UTC — https://ai.google.dev/gemini-api/docs/veo):
 *   CREATE (text-to-video):
 *     POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
 *     Headers: x-goog-api-key: <key>, Content-Type: application/json
 *     Body:    { "instances": [ { "prompt": "..." } ], "parameters": { ... } }
 *     → long-running OPERATION: { "name": "operations/..." }
 *   POLL:
 *     GET https://generativelanguage.googleapis.com/v1beta/{operation.name}
 *     Headers: x-goog-api-key: <key>
 *     done=false while running; done=true + .response when finished.
 *   RESULT PATH (REST-documented, Vertex-style):
 *     .response.generateVideoResponse.generatedSamples[0].video.uri
 *     (SDK-style fallback parsed too: .response.generatedVideos[0].video)
 *   DOWNLOAD: the uri is fetched directly with the x-goog-api-key header;
 *     inline base64 (video.data / videoBytes) is also handled.
 *
 * CONTRACT DISCIPLINE (mirrors the ratified Sora contract, owner Sep 18):
 *   1. MODEL: veo-3.1-lite-generate-preview — the TRUE Lite code ($0.05/s).
 *      (veo-3.1-generate-preview is the STANDARD tier at $0.40/s — never used.)
 *   2. DURATION: enum 4|6|8s per call — NO 12s single call. Scene/Twin call
 *      sites use 6s per-window takes (12s total motion per 30s video = $0.60).
 *   3. NUMBER OF VIDEOS: MUST be omitted — sending numberOfVideos causes a
 *      zero-cost 400 (verified live). The API returns ONE sample by default.
 *   4. EXACTLY-ONCE: the operation name is persisted (caller metadata) BEFORE
 *      any polling; retries/restarts resume-poll the SAME operation — never
 *      re-submit a paid generation.
 *   5. POLL: 5s→10s backoff via setInterval (Railway-safe — no long setTimeout),
 *      sanity cap VEO_POLL_MAX_ATTEMPTS (120 ≈ 10–20 min, far above the
 *      documented 11s–6min latency), never abandons in_progress on elapsed
 *      time; only terminal error / 404 / 5 consecutive HTTP errors abort.
 *   6. FORMAT: aspectRatio "9:16", resolution "720p", personGeneration
 *      "allow_all" (text-to-video people) — all verified live.
 *
 * COST (Google published rates, paid tier, per second of video):
 *   veo-3.1-lite-generate-preview: $0.05/s (720p). A 30s Scene video uses 2×6s
 *   = 12s billed ≈ $0.60; a 30s Twin uses the same 12s ≈ $0.60.
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
export const VEO_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Google-documented Veo 3.1 Lite code ($0.05/s) — the ONLY model production calls. */
export const VEO_MODEL = 'veo-3.1-lite-generate-preview';
/** Provider tag for cost tracking (NEVER customer-visible). */
export const VEO_PROVIDER_TAG = 'veo-3.1-lite';
/** Production per-call duration (enum 4|6|8) — one 6s take per motion window.
 *  30s Scene/Twin = 2 windows × 6s = 12s billed ≈ $0.60. */
export const VEO_CALL_SECONDS = 6;
/** Total paid Veo motion per Scene/Twin video — hard cap (2×6s → $0.60). */
export const VEO_MOTION_BUDGET_SECONDS = 12;
export const VEO_ASPECT_RATIO = '9:16';
export const VEO_RESOLUTION = '720p';
export const VEO_PERSON_GENERATION = 'allow_all';
export const VEO_POLL_MAX_ATTEMPTS = 120; // sanity cap (~10–20 min) — never abandons in_progress on elapsed time
export const VEO_POLL_BASE_DELAY_MS = 5_000;
export const VEO_POLL_MAX_DELAY_MS = 10_000;
export interface VeoGenerateOptions {
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  durationSeconds?: number;
  personGeneration?: string;
}
export interface VeoVideoPayload { uri?: string; data?: string; }
export interface VeoPollResult { done: boolean; error?: string; video?: VeoVideoPayload; }
export interface VeoSceneGenerateOptions {
  prompt: string;
  /** Ensure the caller's env resolution when not passed explicitly (tests pass a
   *  fake key; production resolves GOOGLE_API_KEY / GOOGLE_STUDIO_API_KEY). */
  apiKey?: string;
  /** e.g. "block0-scene3" — used for the local filename + persisted job key. */
  sceneKey: string;
  /** Resumed operation name when an earlier attempt already created one —
   *  exactly-once: NEVER a second paid submission. */
  existingOperationName?: string;
  /** Called with the operation name BEFORE any polling — caller MUST persist it. */
  onOperationCreated: (operationName: string) => void | Promise<void>;
  /** 4|6|8 per call. Defaults to VEO_CALL_SECONDS (6). */
  durationSeconds?: number;
}
/** Build the predictLongRunning POST body. `instances[0].prompt` is the only
 *  field the docs' own REST example sends; generation params (aspectRatio /
 *  resolution / durationSeconds / personGeneration) are carried in the
 *  Vertex-style top-level `parameters` object. numberOfVideos is NEVER sent
 *  (verified zero-cost 400 — the API defaults to one sample). */
export function buildVeoPredictBody(prompt: string, options: VeoGenerateOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { instances: [{ prompt }] };
  const parameters: Record<string, unknown> = {};
  if (options.aspectRatio) parameters.aspectRatio = options.aspectRatio;
  if (options.resolution) parameters.resolution = options.resolution;
  if (options.durationSeconds !== undefined) parameters.durationSeconds = options.durationSeconds;
  if (options.personGeneration) parameters.personGeneration = options.personGeneration;
  if (Object.keys(parameters).length > 0) body.parameters = parameters;
  return body;
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
  const data = video.data ?? video.videoBytes ?? video.inlineData?.data;
  if (typeof data === 'string' && data.length > 0) return { data };
  return undefined;
}
/** Parse a poll (GET operation) response into a structured result. Handles the
 *  REST-documented Vertex-style path (.response.generateVideoResponse
 *  .generatedSamples[].video) AND the SDK-style fallback
 *  (.response.generatedVideos[].video), plus inline base64 vs signed uri. */
export function parseVeoOperation(pollJson: any): VeoPollResult {
  if (!pollJson) return { done: false };
  if (pollJson.done !== true) return { done: false };
  if (pollJson.error) {
    return { done: true, error: `Veo operation failed: ${JSON.stringify(pollJson.error).slice(0, 300)}` };
  }
  const resp = pollJson.response || {};
  // REST-documented path (Vertex-style generateVideoResponse / generatedSamples)
  const gvr = resp.generateVideoResponse;
  const samples: any[] | undefined = gvr?.generatedSamples;
  // SDK-style fallback
  const alt: any[] | undefined = resp.generatedVideos;
  const arr = Array.isArray(samples) && samples.length > 0 ? samples
    : (Array.isArray(alt) && alt.length > 0 ? alt : undefined);
  // Safety filter terminal states — never charge-for-nothing ambiguity
  if (gvr?.raiMediaFiltered === true || resp.raiMediaFiltered === true) {
    return { done: true, error: 'Veo: media filtered by safety (raiMediaFiltered)' };
  }
  const first = arr?.[0];
  const payload = extractVeoVideoPayload(first?.video);
  if (!payload) {
    return { done: true, error: `Veo done but no video payload: ${JSON.stringify(resp).slice(0, 300)}` };
  }
  return { done: true, video: payload };
}
export function buildVeoCreateUrl(model: string): string {
  return `${VEO_API_BASE}/models/${model}:predictLongRunning`;
}
export function buildVeoPollUrl(operationName: string): string {
  return `${VEO_API_BASE}/${operationName}`;
}
export class VeoVideoService {
  /** Test seam: tests set this to 0 so polls are instant; prod keeps 5s→10s. */
  public pollDelayMs = VEO_POLL_BASE_DELAY_MS;
  /**
   * Generate ONE Veo scene take with EXACTLY-ONCE semantics:
   *   1. If opts.existingOperationName is present → skip the paid CREATE and
   *      resume-poll that operation (crash/retry resume).
   *   2. Else POST predictLongRunning → onOperationCreated(name) BEFORE polling.
   *   3. Poll (5s→10s backoff) until done / terminal error.
   *   4. Download the video (signed https uri OR inline base64) to a local file.
   */
  async generateSceneVideo(opts: VeoSceneGenerateOptions): Promise<{ success: boolean; error?: string; videoPath?: string; operationName?: string; billedSeconds?: number }> {
    const apiKey = opts.apiKey || process.env.GOOGLE_API_KEY || process.env.GOOGLE_STUDIO_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'Veo API key not configured' };
    }
    const model = VEO_MODEL;
    const billedSeconds = opts.durationSeconds ?? VEO_CALL_SECONDS;
    let operationName: string | undefined;
    try {
      if (opts.existingOperationName) {
        operationName = opts.existingOperationName;
      } else {
        const body = buildVeoPredictBody(opts.prompt, {
          aspectRatio: VEO_ASPECT_RATIO,
          resolution: VEO_RESOLUTION,
          durationSeconds: billedSeconds,
          personGeneration: VEO_PERSON_GENERATION,
        });
        console.log(`[Veo] create POST model=${model} scene=${opts.sceneKey} dur=${billedSeconds}s`);
        const createRes = await fetch(buildVeoCreateUrl(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (createRes.status === 400) {
          const text = await createRes.text().catch(() => '');
          return { success: false, error: `Veo create HTTP 400: ${text.slice(0, 240)}` };
        }
        if (!createRes.ok) {
          return { success: false, error: `Veo create HTTP ${createRes.status}` };
        }
        const createJson = await createRes.json().catch(() => null);
        operationName = parseVeoOperationName(createJson);
        // EXACTLY-ONCE: persist the operation name BEFORE the first poll so a
        // crash mid-poll resumes THIS SAME operation, never a second paid POST.
        await opts.onOperationCreated(operationName);
        console.log(`[Veo] veo_operation_created scene=${opts.sceneKey} op=${operationName}`);
      }
      // STEP 2: POLL (resume-safe, 5s→10s setInterval backoff, sanity cap only)
      const poll = await this.pollOperation(operationName, apiKey, opts.sceneKey);
      if (!poll.done && !poll.error) {
        // Sanity cap hit while still in_progress — job survives; caller must
        // resume the SAME operation later (exactly-once).
        return { success: false, error: `Veo poll sanity cap exceeded (still in_progress, resume-safe)`, operationName };
      }
      if (poll.error) return { success: false, error: poll.error, operationName };
      // STEP 3: DOWNLOAD (signed uri OR inline base64)
      const videoPath = await this.downloadVideo(poll.video!, apiKey, opts.sceneKey);
      console.log(`[Veo] veo_scene_downloaded scene=${opts.sceneKey} path=${videoPath}`);
      return { success: true, videoPath, operationName, billedSeconds };
    } catch (error: any) {
      console.error(`[VeoVideoService] scene ${opts.sceneKey} failed: ${error.message}`);
      return { success: false, error: error.message, operationName };
    }
  }
  private async pollOperation(operationName: string, apiKey: string, sceneKey: string): Promise<VeoPollResult> {
    let attempt = 0;
    let consecutiveErrors = 0;
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
        const res = await fetch(buildVeoPollUrl(operationName), {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 404) {
          console.error(`[Veo] veo_poll_404 scene=${sceneKey} op=${operationName}`);
          return { done: false, error: 'Veo operation not found (404)' };
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
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          return { done: false, error: `Veo poll: ${consecutiveErrors} consecutive network errors` };
        }
      }
    }
    console.error(`[Veo] veo_poll_cap scene=${sceneKey} attempts=${VEO_POLL_MAX_ATTEMPTS}`);
    return { done: false };
  }
  private async downloadVideo(payload: VeoVideoPayload, apiKey: string, sceneKey: string): Promise<string> {
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
    const res = await fetch(uri, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Veo video download HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(outPath, buffer);
    return outPath;
  }
}
export const veoVideoService = new VeoVideoService();