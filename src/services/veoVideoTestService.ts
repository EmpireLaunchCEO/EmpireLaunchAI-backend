/**
 * VEO 3.1 LITE TEST PATH (owner-directed test, Sep 15 2026) — STRICTLY A TEST.
 *
 * Evaluates Google Veo 3.1 (veo-3.1-generate-preview, per owner verbatim spec)
 * via the Gemini API as a potential Sora 2 replacement. This is a GATED test
 * path: it can only be reached with project mode 'veo-test' AND the env gate
 * ENABLE_VEO_TEST === 'true'. Production ('scene' | 'faceless' | twin modes),
 * Sora, extensions, quotas and the UI are completely untouched.
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
 *   DOWNLOAD: the uri is fetched directly (curl -L) with the x-goog-api-key
 *     header; inline base64 (video.data / videoBytes) is also handled.
 *
 * CONTRACT DISCIPLINE (mirrors the ratified Sora contract):
 *   1. EXACTLY-ONCE: the operation name is persisted (metadata.veoJobs[block] =
 *      { operation, status, createdAt }) BEFORE any polling; retries/restarts
 *      resume-poll the SAME operation — NEVER re-submit a paid generation.
 *   2. POLL: 5s→10s backoff via setInterval (Railway-safe — no long setTimeout),
 *      sanity cap VEO_POLL_MAX_ATTEMPTS (120 ≈ 10–20 min, far above the
 *      documented 11s–6min latency), never abandons in_progress on elapsed
 *      time; only terminal error / 404 / 5 consecutive HTTP errors abort.
 *   3. MODEL PARAMS (Lite supports): aspectRatio "9:16", resolution "720p",
 *      durationSeconds 8 (Lite max; enum "4"|"6"|"8"), numberOfVideos 1,
 *      personGeneration "allow_all" (text-to-video people).
 *
 * COST (Google published rates, paid tier, per second of video):
 *   veo-3.1-generate-preview (Standard — owner's verbatim code): $0.40/s
 *   veo-3.1-lite-generate-preview (Lite — DIFFERENT model code):    $0.05/s
 *   ⚠️ The task spec calls veo-3.1-generate-preview "Veo 3.1 Lite", but Google's
 *   pricing page lists Lite as a DISTINCT code (veo-3.1-lite-generate-preview).
 *   VEO_MODEL defaults to the owner's verbatim code; VEO_LITE_MODEL is the
 *   documented Lite alternative. Decision happens at the sign-off gate for the
 *   ONE live render (per paid-render policy). 6×8s billed = 48s → Standard
 *   ≈ $19.20, Lite ≈ $2.40 per 30s test video (trimming to 5s slots does NOT
 *   reduce cost — billing is per generated second).
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export const VEO_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Owner verbatim model code (task spec: "veo-3.1-generate-preview (Veo 3.1 Lite)"). */
export const VEO_MODEL = 'veo-3.1-generate-preview';
/** Google-documented Veo 3.1 Lite code (pricing page) — the TRUE Lite tier at $0.05/s. */
export const VEO_LITE_MODEL = 'veo-3.1-lite-generate-preview';
export const VEO_PROVIDER_TAG = 'veo-3.1-lite';
export const VEO_TEST_MODE = 'veo-test';
export const VEO_ENV_GATE = 'ENABLE_VEO_TEST';
export const VEO_DEFAULT_IDEA =
  'a realistic vertical social-media video of a confident young woman walking through a modern downtown city street at golden hour. She walks naturally toward the camera while the camera smoothly tracks backward. Realistic human movement, natural facial expression, realistic lighting, cinematic but authentic smartphone/social-media aesthetic. NO TEXT, no subtitles, no logos';
export const VEO_SCENE_SECONDS = 5;       // target timeline slot per scene (6 × 5s = 30s)
export const VEO_CALL_SECONDS = 8;        // Veo 3.1 Lite max generation per call
export const VEO_ASPECT_RATIO = '9:16';
export const VEO_RESOLUTION = '720p';
export const VEO_NUMBER_OF_VIDEOS = 1;
export const VEO_PERSON_GENERATION = 'allow_all';
export const VEO_POLL_MAX_ATTEMPTS = 120; // sanity cap (~10–20 min) — never abandons in_progress on elapsed time
export const VEO_POLL_BASE_DELAY_MS = 5_000;
export const VEO_POLL_MAX_DELAY_MS = 10_000;

export interface VeoTestScene {
  sceneNumber: number;
  duration: number;   // target slot seconds (5)
  prompt: string;
}
export interface VeoGenerateOptions {
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  durationSeconds?: number;
  numberOfVideos?: number;
  personGeneration?: string;
}
export interface VeoVideoPayload { uri?: string; data?: string; }
export interface VeoPollResult { done: boolean; error?: string; video?: VeoVideoPayload; }

/** Build the predictLongRunning POST body. `instances[0].prompt` is the only
 *  field the docs' own REST example sends; generation params (owner spec:
 *  aspectRatio/resolution/durationSeconds/numberOfVideos/personGeneration) are
 *  carried in the Vertex-style top-level `parameters` object when provided. */
export function buildVeoPredictBody(prompt: string, options: VeoGenerateOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { instances: [{ prompt }] };
  const parameters: Record<string, unknown> = {};
  if (options.aspectRatio) parameters.aspectRatio = options.aspectRatio;
  if (options.resolution) parameters.resolution = options.resolution;
  if (options.durationSeconds !== undefined) parameters.durationSeconds = options.durationSeconds;
  if (options.numberOfVideos !== undefined) parameters.numberOfVideos = options.numberOfVideos;
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

/** Deterministic 6-scene × 5s test plan derived from the verbatim test prompt —
 *  every scene stays faithful: SAME young woman, SAME modern downtown street,
 *  golden hour, realistic movement/lighting, NO TEXT/subtitles/logos. Each scene
 *  is ONE Veo call (~8s generated) sliced to its 5s slot during assembly. */
export function planVeoTestScenes(idea: string): VeoTestScene[] {
  const base = idea.trim().length > 0 ? idea.trim() : VEO_DEFAULT_IDEA;
  const style = 'Realistic human movement, natural facial expression, realistic lighting, cinematic but authentic smartphone/social-media aesthetic. NO TEXT, no subtitles, no logos.';
  const scenes: VeoTestScene[] = [
    { sceneNumber: 1, duration: VEO_SCENE_SECONDS, prompt: `Scene 1 of 6 — establishing wide shot: ${base} The same young woman is first seen mid-distance on the sidewalk, walking toward camera as the camera smoothly tracks backward. ${style}` },
    { sceneNumber: 2, duration: VEO_SCENE_SECONDS, prompt: `Scene 2 of 6 — medium shot: ${base} Now at medium distance, the same young woman keeps walking naturally toward the camera, camera smoothly tracking backward at the same pace. ${style}` },
    { sceneNumber: 3, duration: VEO_SCENE_SECONDS, prompt: `Scene 3 of 6 — closer three-quarter shot: ${base} The same young woman approaches closer, the modern downtown street softly blurred behind her at golden hour, camera smoothly tracking backward. ${style}` },
    { sceneNumber: 4, duration: VEO_SCENE_SECONDS, prompt: `Scene 4 of 6 — medium-wide tracking shot: ${base} The same young woman passes a modern street storefront (no logos, no text) while walking naturally toward camera, the camera smoothly tracking backward. ${style}` },
    { sceneNumber: 5, duration: VEO_SCENE_SECONDS, prompt: `Scene 5 of 6 — close-up: ${base} The same young woman's face in golden-hour light, natural confident expression as she walks, city street softly blurred behind, camera smoothly tracking backward. ${style}` },
    { sceneNumber: 6, duration: VEO_SCENE_SECONDS, prompt: `Scene 6 of 6 — final wide shot: ${base} The same young woman completes her walk toward camera, the camera smoothly tracking backward the entire time, golden hour glow, ending frame keeps her in view. ${style}` },
  ];
  return scenes;
}

export class VeoVideoTestService {
  /** Test seam: tests set this to 0 so polls are instant; prod keeps 5s→10s. */
  public pollDelayMs = VEO_POLL_BASE_DELAY_MS;

  /**
   * Generate ONE scene's video via Veo (text-to-video), exactly-once:
   *  - if existingOperationName is given → RESUME-poll that operation (never re-POST)
   *  - else POST predictLongRunning, then call onOperationCreated(operationName)
   *    IMMEDIATELY (before any polling) so a crash/restart can resume the SAME
   *    paid job.
   * Returns the local mp4 path + the persisted operation name (caller stores it).
   */
  async generateSceneVideo(opts: {
    prompt: string;
    apiKey: string;
    sceneKey: string; // e.g. "scene1" — used for the local filename
    existingOperationName?: string;
    onOperationCreated: (operationName: string) => void | Promise<void>;
    model?: string;
    aspectRatio?: string;
    resolution?: string;
    durationSeconds?: number;
    numberOfVideos?: number;
    personGeneration?: string;
  }): Promise<{ success: boolean; error?: string; videoPath?: string; operationName?: string; billedSeconds?: number }> {
    const model = opts.model ?? VEO_MODEL;
    let operationName: string | undefined = opts.existingOperationName;
    let billedSeconds = opts.durationSeconds ?? VEO_CALL_SECONDS;
    try {
      // STEP 1: CREATE (exactly-once — skipped entirely when resuming)
      if (!operationName) {
        const createUrl = buildVeoCreateUrl(model);
        const createBody = buildVeoPredictBody(opts.prompt, {
          aspectRatio: opts.aspectRatio ?? VEO_ASPECT_RATIO,
          resolution: opts.resolution ?? VEO_RESOLUTION,
          durationSeconds: billedSeconds,
          numberOfVideos: opts.numberOfVideos ?? VEO_NUMBER_OF_VIDEOS,
          personGeneration: opts.personGeneration ?? VEO_PERSON_GENERATION,
        });
        console.log(`[VeoVideoTestService] create POST ${model} scene=${opts.sceneKey}`);
        const res = await fetch(createUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
          body: JSON.stringify(createBody),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          console.error(`[VeoVideoTestService] create error (${res.status}): ${errBody.slice(0, 300)}`);
          return { success: false, error: `Veo create error ${res.status} — ${errBody.slice(0, 200)}` };
        }
        const createJson = await res.json();
        operationName = parseVeoOperationName(createJson);
        // DURABLE PERSISTENCE POINT — BEFORE polling: a restart/timeout resumes
        // this SAME operation, never a second paid submission.
        await opts.onOperationCreated(operationName);
        console.log(`[VEO-TEST] veo_operation_created scene=${opts.sceneKey} op=${operationName}`);
      } else {
        console.log(`[VEO-TEST] veo_operation_resumed scene=${opts.sceneKey} op=${operationName}`);
      }
      // STEP 2: POLL (resume-safe, 5s→10s setInterval backoff, sanity cap only)
      const poll = await this.pollOperation(operationName, opts.apiKey, opts.sceneKey);
      if (!poll.done && !poll.error) {
        // Sanity cap hit while still in_progress — job survives; caller must
        // resume the SAME operation later (exactly-once).
        return { success: false, error: `Veo poll sanity cap exceeded (still in_progress, resume-safe)`, operationName };
      }
      if (poll.error) return { success: false, error: poll.error, operationName };
      // STEP 3: DOWNLOAD (signed uri OR inline base64)
      const videoPath = await this.downloadVideo(poll.video!, opts.apiKey, opts.sceneKey);
      console.log(`[VEO-TEST] veo_scene_downloaded scene=${opts.sceneKey} path=${videoPath}`);
      return { success: true, videoPath, operationName, billedSeconds };
    } catch (error: any) {
      console.error(`[VeoVideoTestService] scene ${opts.sceneKey} failed: ${error.message}`);
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
          console.error(`[VEO-TEST] veo_poll_404 scene=${sceneKey} op=${operationName}`);
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
          console.error(`[VEO-TEST] veo_poll_terminal scene=${sceneKey} error=${result.error}`);
          return result;
        }
        if (result.done) {
          console.log(`[VEO-TEST] veo_poll_done scene=${sceneKey} polls=${attempt}`);
          return result;
        }
        if (attempt % 15 === 0) {
          console.log(`[VeoVideoTestService] Polling ${operationName}: attempt ${attempt}`);
        }
      } catch (err: any) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          return { done: false, error: `Veo poll: ${consecutiveErrors} consecutive network errors` };
        }
      }
    }
    console.error(`[VEO-TEST] veo_poll_cap scene=${sceneKey} attempts=${VEO_POLL_MAX_ATTEMPTS}`);
    return { done: false };
  }

  private async downloadVideo(payload: VeoVideoPayload, apiKey: string, sceneKey: string): Promise<string> {
    const dir = path.join(process.cwd(), 'temp', 'veo-test');
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

export const veoVideoTestService = new VeoVideoTestService();
