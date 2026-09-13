import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { r2Storage } from './r2StorageService.js';

/** Official Sora 2 clip-length values (video-generation guide: sora-2 supports
 *  16- and 20-second generations; the prompting guide lists `seconds` as
 *  "4"|"8"|"12"|"16"|"20", default "4"). Container params (resolution/duration)
 *  are NOT steerable by prose like "make it longer" — length goes through this
 *  enum only. */
export type SoraSeconds = '4' | '8' | '12' | '16' | '20';

/** OWNER-RATIFIED HARD GATE (Sora 2 spec): our video pipeline only ever sends the
 *  two longest official enum values — "16" when a block needs ≤16s, else "20".
 *  4/8/12 are NEVER sent (the short tiers are off-limits for portrait video). */
export type SoraTakeSeconds = '16' | '20';

/** Official Sora 2 resolution (`size`). sora-2 supports "720x1280" (default,
 *  9:16 portrait) and "1280x720" (16:9). We set "720x1280" EXPLICITLY on EVERY
 *  create call (owner: explicit size always — deterministic 9:16 contract rather
 *  than relying on the API default), unless a caller explicitly overrides. */
export const SORA_SCENE_SIZE = '720x1280' as const;
/** Default take length when no block target (`needSeconds`) is supplied. A 20s
 *  single take remains the Scene motion default — renderClip/span slicing trims
 *  to the scene window, giving continuous single-take motion with no loop-padding.
 *  The 16|20 GATE (snapSora16or20) replaces the old "always 20" policy: a block
 *  that needs ≤16s now requests "16" (cheaper tier, still a single take). */
export const SORA_MOTION_SECONDS: SoraTakeSeconds = '20';

/** Extensions API (owner-ratified Sora 2 spec): an initial take can be extended
 *  with POST /v1/videos/{id}/extensions — up to SORA_MAX_EXTENSIONS calls, each
 *  adding SORA_EXTENSION_SECONDS, hard-capped at SORA_MAX_TOTAL_SECONDS total. */
export const SORA_MAX_EXTENSIONS = 6;
export const SORA_EXTENSION_SECONDS = 20;
export const SORA_MAX_TOTAL_SECONDS = 120;
/** Poll sanity cap (owner/lead 2026-09-13): ~120 polls = a 20–40min window at
 *  the 10s→20s backoff — purely defensive; in_progress is NEVER abandoned on
 *  elapsed time (only terminal failed / 404 / sustained HTTP errors abort). */
export const SORA_POLL_MAX_ATTEMPTS = 120;

/** OWNER-RATIFIED GATE: `seconds:'16'` when the block needs ≤16s, else `'20'`.
 *  NEVER 4/8/12 — the short enum tiers are hard-locked out of the pipeline. */
export function snapSora16or20(needSeconds: number): SoraTakeSeconds {
  const need = Number.isFinite(needSeconds) ? Math.max(1, Math.round(needSeconds)) : SORA_EXTENSION_SECONDS;
  return need <= 16 ? '16' : '20';
}

/** Clamp a block's total target seconds into the valid planning range
 *  (1..SORA_MAX_TOTAL_SECONDS). Drives the 16|20 gate + the extension loop. */
export function sanitizeNeedSeconds(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return SORA_MOTION_SECONDS === '20' ? 20 : 16;
  return Math.min(SORA_MAX_TOTAL_SECONDS, Math.max(1, Math.round(v)));
}
/** Duration-scaled Sora call budget (owner directive, live Sep 8): a Scene-Based /
 *  Customize video may spend at most 1 Sora call (20s single take) for ≤30s videos,
 *  2 calls for ~1 minute, 3 calls for 2–3 minutes — soraCallBudget(d) =
 *  clamp(ceil(d/30), 1, 3): 15s→1, 30s→1, 60s→2, 120s→3, 180s→3. Sora is ONLY
 *  used where GPT explicitly elects motion (it names which 20s blocks deserve it);
 *  everything else renders as gpt-image-2 stills animated with FFmpeg Ken Burns.
 *  At ~$0.40/call × max 3 calls × 3 Scene videos/wk this caps worst-case Sora spend
 *  at ~$15/month/client — inside the $50 subscription (cost-viability RESOLVED). */
export function soraCallBudget(duration: number): number {
  const d = Number.isFinite(duration) ? Math.max(1, Math.round(duration)) : 30;
  return Math.min(3, Math.max(1, Math.ceil(d / 30)));
}
export type SoraSize = typeof SORA_SCENE_SIZE | '1280x720';

/** NARROWED to the owner gate (2026-09-13): snap to the nearest of {16,20} — the
 *  short enum tiers 4/8/12 are structurally unreachable from every create body
 *  (owner spec; see resolveGateSeconds). */
export function snapSoraSeconds(target: number): SoraTakeSeconds {
  return snapSora16or20(target);
}
/** OWNER GATE RESOLVER: seconds ALWAYS resolves to '16'|'20'. Absent → '20'
 *  (a 20s max take — NEVER the API default '4', which would quietly bill a
 *  shorter length). A short tier passed explicitly THROWS (fail-fast: a caller
 *  bug must be loud, never a quiet 4s bill). */
export function resolveGateSeconds(v?: SoraSeconds | undefined): SoraTakeSeconds {
  if (v === undefined) return '20';
  if (v === '16' || v === '20') return v;
  throw new Error(`Sora gate: seconds "${v}" is a locked-out short tier — only 16|20 may reach the API (owner spec)`);
}

/** Build the POST body for /v1/videos. `seconds` is the ONLY length parameter the
 *  live Sora 2 API accepts (enum above); the legacy `duration` option is deliberately
 *  NEVER included — the live API rejects it as an unknown parameter (400).
 *  `size` is ALWAYS set explicitly (owner: explicit size always) — defaults to the
 *  deterministic 9:16 SORA_SCENE_SIZE so no call ever depends on the API default. */
export function buildSoraCreateBody(model: string, prompt: string, options: SoraGenerationOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt };
  // HARD GATE: never absent (API default is 4s), never a short tier — always 16|20.
  body.seconds = resolveGateSeconds(options.seconds);
  body.size = options.size ?? SORA_SCENE_SIZE;
  if (options.promptHint) body.prompt = `${prompt}\n\n${options.promptHint}`;
  return body;
}

/** Build the POST body for /v1/videos/{id}/extensions (owner-ratified Sora 2
 *  spec). Each extension call adds SORA_EXTENSION_SECONDS (20s) of CONTINUOUS
 *  take — we send ONLY the continuity prompt (the docs example payload); length
 *  is fixed at +20s per call by the endpoint, so no length/size params are sent
 *  (avoids inventing parameters the live API may reject). */
export function buildSoraExtensionBody(continuityHint?: string): Record<string, unknown> {
  const prompt = continuityHint && continuityHint.trim().length > 0
    ? `Seamlessly continue the video from its final frame — extend the same camera work, lighting, and subject without cuts. ${continuityHint.trim()}`
    : 'Seamlessly continue the video from its final frame — extend the same camera work, lighting, and subject without cuts.';
  return { prompt };
}

export interface SoraGenerationOptions {
  userId?: string;        // For R2 upload
  /** Official Sora 2 clip-length (`seconds`, enum "4"|"8"|"12"|"16"|"20", default
   *  "4"). generateVideo NEVER sends the short tiers — it resolves the owner gate
   *  `snapSora16or20(needSeconds)` FIRST and overrides whatever is passed here
   *  with "16" (block needs ≤16s) or "20" (else). Scene motion passes the span /
   *  scene target duration via `needSeconds`; this field exists for legacy callers
   *  and explicit override. */
  seconds?: SoraSeconds;
  /** Official Sora 2 resolution. sora-2 supports "720x1280" (default, 9:16 portrait)
   *  and "1280x720". EXPLICIT SIZE ALWAYS (owner): when omitted, generateVideo /
   *  buildSoraCreateBody set SORA_SCENE_SIZE ("720x1280") — no call ever relies on
   *  the API default. */
  size?: SoraSize;
  /** LEGACY NO-OP — the live API rejects `duration` (400 "unknown parameter:
   *  duration"). Kept so old call sites (videoQueueService etc.) still compile;
   *  NEVER sent to the API. Use `needSeconds` for length control instead. */
  duration?: number;
  /** Prose steer for CONTENT continuity only (e.g. "one continuous take, no cuts").
   *  Secondary to `seconds` — it cannot change clip length. */
  promptHint?: string;
  /** EXACTLY-ONCE CREATE (owner-ratified): when set, the create POST is SKIPPED
   *  entirely and this existing Sora video id is polled to its terminal state
   *  instead — a retry after a timeout/failure NEVER re-POSTs the same block.
   *  Callers persist the id via `onVideoCreated` (while polling) or the returned
   *  `result.videoId` (after) and hand it back on the next attempt. */
  existingVideoId?: string;
  /** Total target seconds for this block (owner gate + extensions drive): resolves
   *  the 16|20 `seconds` gate, and when >20 runs the extensions API (+20s per call,
   *  max 6, hard cap 120s total) for CONTINUOUS takes longer than one clip.
   *  Default: 20 (single take, no extensions). */
  needSeconds?: number;
  /** Fired synchronously the moment each create/extension response returns an id —
   *  BEFORE that clip is polled — so callers can durably persist the id (DB) and
   *  resume with `existingVideoId` after a restart/timeout (exactly-once). */
  onVideoCreated?: (videoId: string, meta: { stage: 'initial' | 'extension'; index: number }) => void;
}

export interface SoraGenerationResult {
  success: boolean;
  videoPath?: string;     // local path to downloaded video
  videoUrl?: string;      // public-facing URL
  error?: string;
  /** The Sora video id owned by this call (initial create or the LAST successful
   *  extension). Present on FAILURE too (poll failed/timed out) so callers can
   *  persist it and retry with `existingVideoId` — never re-POST. */
  videoId?: string;
}

export class SoraVideoService {
  private outputDir: string;
  /** Test seam: poll cadence between GET /v1/videos/{id} checks. 5s in prod
   *  (Railway-safe short interval), 0 in unit tests (fetch is mocked). */
  private pollDelayMs: number;

  constructor(pollDelayMs = 5000) {
    this.outputDir = path.join(process.cwd(), 'public', 'assets', 'cinema', 'sora');
    this.pollDelayMs = Math.max(0, pollDelayMs);
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Generate a video using OpenAI's Sora 2 model.
   * POST /v1/videos to create, GET /v1/videos/{id} to poll, downloads on completion.
   *
   * OWNER-RATIFIED Sora 2 SPEC (this method):
   *  (1) 16|20 GATE — the create `seconds` is NEVER a short tier: snapSora16or20()
   *      resolves `needSeconds` (≤16 → "16", else "20").
   *  (2) EXACTLY-ONCE CREATE — when `options.existingVideoId` is set, the create
   *      POST is SKIPPED and that id is polled to terminal (a retry after a
   *      timeout/failure NEVER re-POSTs the same block). `onVideoCreated` fires
   *      with each new id the moment the API returns it (durable persistence);
   *      the failure result also carries `videoId` so callers can persist late.
   *  (3) EXTENSIONS — when `needSeconds` > 20, POST /v1/videos/{id}/extensions
   *      (+SORA_EXTENSION_SECONDS per call, ≤ SORA_MAX_EXTENSIONS, hard cap
   *      SORA_MAX_TOTAL_SECONDS) for one CONTINUOUS take longer than a clip; the
   *      final content is downloaded from the last successful extension id.
   *  (4) EXPLICIT SIZE — `size:'720x1280'` is set on every create (buildSoraCreateBody
   *      defaults it); no call ever relies on the API default.
   */
  async generateVideo(
    prompt: string,
    options: SoraGenerationOptions = {},
  ): Promise<SoraGenerationResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { success: false, error: 'OPENAI_API_KEY not configured' };
    }

    const model = process.env.SORA_MODEL || 'sora-2';
    const taskId = uuidv4();
    // Owner gate: never 4/8/12 — the block target drives the 16|20 choice.
    const needSeconds = sanitizeNeedSeconds(options.needSeconds ?? Number(options.seconds ?? 20));
    const takeSeconds = snapSora16or20(needSeconds);
    let currentVideoId: string | undefined = options.existingVideoId;

    try {
      // Step 1: Create video generation — SKIPPED entirely on exactly-once resume.
      // Length is controlled ONLY via the official `seconds` enum; promptHint is a
      // secondary content-continuity steer (cannot change clip length); `duration`
      // is legacy NO-OP and never sent. FFmpeg trims/slices below as needed.
      if (currentVideoId) {
        console.log(`[PIPELINE] sora_resume id=${currentVideoId} — exactly-once resume: NO re-POST (need=${needSeconds}s gate=${takeSeconds}s)`);
      } else {
        console.log(`[PIPELINE] sora_create_start model=${model} prompt_length=${prompt.length} need=${needSeconds}s gate=${takeSeconds}s`);
        const createBody = buildSoraCreateBody(model, prompt, { ...options, seconds: takeSeconds, size: options.size ?? SORA_SCENE_SIZE });
        console.log(`[PIPELINE] sora_create_body model=${model} seconds=${createBody.seconds} size=${createBody.size} prompt_length=${String(createBody.prompt).length}`);
        const createResponse = await fetch('https://api.openai.com/v1/videos', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(createBody),
          signal: AbortSignal.timeout(60000),
        });

        if (!createResponse.ok) {
          const errBody = await createResponse.text().catch(() => '');
          console.error(`[SoraVideoService] Create error (${createResponse.status}):`, errBody);
          return { success: false, error: `Sora API error: ${createResponse.status} — ${errBody.slice(0, 200)}` };
        }

        const createData = await createResponse.json();
        console.log(`[SoraVideoService] Sora create RESPONSE: status=${createResponse.status}, id=${createData?.id}, status=${createData?.status}`);
        currentVideoId = createData?.id;
        if (!currentVideoId) {
          return { success: false, error: 'No video ID in Sora create response' };
        }
        console.log(`[PIPELINE] sora_created id=${currentVideoId} status=${createData.status}`);
        // Durable persistence point: caller stores this id NOW (before polling) so a
        // restart/timeout can resume exactly-once instead of re-POSTing.
        options.onVideoCreated?.(currentVideoId, { stage: 'initial', index: 0 });
      }

      // Step 2: Poll the initial take to its terminal state.
      if (!(await this.pollVideo(currentVideoId, apiKey))) {
        return { success: false, error: 'Sora generation failed or timed out', videoId: currentVideoId };
      }
      console.log(`[PIPELINE] sora_initial_ready id=${currentVideoId} gate=${takeSeconds}s`);

      // Step 3: EXTENSIONS — continuity beyond one take (owner spec: initial + up
      // to 6×20s, hard max 120s). Each call extends by SORA_EXTENSION_SECONDS and
      // produces a new video resource; the LAST id owns the full extended content.
      let producedSeconds = Number(takeSeconds);
      let extensionIndex = 0;
      while (
        producedSeconds < needSeconds &&
        extensionIndex < SORA_MAX_EXTENSIONS &&
        producedSeconds + SORA_EXTENSION_SECONDS <= SORA_MAX_TOTAL_SECONDS
      ) {
        const extUrl = `https://api.openai.com/v1/videos/${currentVideoId}/extensions`;
        console.log(`[PIPELINE] sora_extension_start id=${currentVideoId} ext=${extensionIndex + 1} produced=${producedSeconds}s need=${needSeconds}s`);
        const extResponse = await fetch(extUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(buildSoraExtensionBody(options.promptHint)),
          signal: AbortSignal.timeout(60000),
        });
        if (!extResponse.ok) {
          const errBody = await extResponse.text().catch(() => '');
          console.error(`[SoraVideoService] Extension error (${extResponse.status}):`, errBody);
          return { success: false, error: `Sora extension error: ${extResponse.status} — ${errBody.slice(0, 200)}`, videoId: currentVideoId };
        }
        const extData = await extResponse.json();
        const extId: string = extData?.id || currentVideoId!;
        options.onVideoCreated?.(extId, { stage: 'extension', index: extensionIndex + 1 });
        if (!(await this.pollVideo(extId, apiKey))) {
          return { success: false, error: `Sora extension ${extensionIndex + 1} failed or timed out`, videoId: extId };
        }
        currentVideoId = extId;
        producedSeconds += SORA_EXTENSION_SECONDS;
        extensionIndex++;
        console.log(`[PIPELINE] sora_extended id=${currentVideoId} total=${producedSeconds}s ext=${extensionIndex}/${SORA_MAX_EXTENSIONS}`);
      }

      // Step 4: Download the FINAL (possibly extended) video from /v1/videos/{id}/content
      const downloadUrl = `https://api.openai.com/v1/videos/${currentVideoId}/content`;
      const localPath = await this.downloadVideo(downloadUrl, taskId, apiKey);
      const publicUrl = await this.maybeUploadToR2(localPath, options.userId);

      console.log(`[PIPELINE] sora_downloaded path=${localPath} url=${publicUrl} id=${currentVideoId} total=${producedSeconds}s`);
      return {
        success: true,
        videoPath: localPath,
        videoUrl: publicUrl,
        videoId: currentVideoId,
      };
    } catch (error: any) {
      console.error('[SoraVideoService] Generation failed:', error.message);
      return { success: false, error: error.message, videoId: currentVideoId };
    }
  }

  /** Upload video to R2 if configured, return public URL */
  private async maybeUploadToR2(localPath: string, userId?: string): Promise<string> {
    if (userId && r2Storage.isAvailable) {
      const result = await r2Storage.uploadLocalFile(localPath, userId, 'cinema/sora', 'video/mp4');
      if (result.url !== localPath) return result.url;
    }
    return `/assets/cinema/sora/${path.basename(localPath)}`;
  }

  /**
   * Poll GET /v1/videos/{id} until status is "completed" or "failed".
   * No artificial attempt cap — relies on 5-min failsafe in studioRoutes.ts.
   * Returns true on completion, false on failure.
   */
  private async pollVideo(
    videoId: string,
    apiKey: string,
  ): Promise<boolean> {
    // OWNER/LEAD 2026-09-13: sanity cap only — NEVER abandon an in_progress
    // job on elapsed time (Sora legitimately takes 6–10+ min; the old 5-min
    // cap abandoned paid jobs). Only terminal 'failed', 404, or sustained
    // HTTP errors abort the poll; a timeout returns false so the caller's
    // retry RESUMES the SAME id via existingVideoId (exactly-once, zero re-POSTs).
    const MAX_ATTEMPTS = SORA_POLL_MAX_ATTEMPTS;
    let attempt = 0;
    let consecutiveErrors = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      // ~10s interval, backing off to ~20s after the first minute (0ms in tests).
      const waitMs = this.pollDelayMs > 0 ? (attempt > 6 ? 20_000 : Math.max(10_000, this.pollDelayMs)) : 0;
      if (waitMs > 0) await new Promise<void>((resolve) => {
        const interval = setInterval(() => { clearInterval(interval); resolve(); }, waitMs);
      });
      console.log(`[PIPELINE] sora_poll_wait_complete video=${videoId} attempt=${attempt}`);

      try {
        const response = await fetch(
          `https://api.openai.com/v1/videos/${videoId}`,
          {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(30000),
          },
        );

        // 404 = video doesn't exist — never coming back
        if (response.status === 404) {
          console.error(`[SoraVideoService] Video ${videoId} not found (404), aborting poll`);
          return false;
        }

        if (!response.ok) {
          consecutiveErrors++;
          // After 5 consecutive HTTP errors, give up
          if (consecutiveErrors >= 5) {
            console.error(`[SoraVideoService] Video ${videoId} — ${consecutiveErrors} consecutive HTTP errors, aborting`);
            return false;
          }
          continue;
        }

        consecutiveErrors = 0; // reset on success
        const data = await response.json();
        const status = data?.status;

        if (status === 'completed') {
          console.log(`[PIPELINE] sora_completed id=${videoId} polls=${attempt}`);
          return true;
        }
        if (status === 'failed') {
          console.error(`[PIPELINE] sora_failed id=${videoId} polls=${attempt}`);
          return false;
        }
        // Log every 15 polls to reduce noise
        if (attempt % 15 === 0) {
          console.log(`[SoraVideoService] Polling ${videoId}: attempt ${attempt}, status=${status}, progress=${data?.progress ?? '?'}%`);
        }
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          console.error(`[SoraVideoService] Video ${videoId} — ${consecutiveErrors} consecutive network errors, aborting`);
          return false;
        }
      }
    }

    console.error(`[SoraVideoService] Video ${videoId} exceeded max attempts (${MAX_ATTEMPTS}), aborting`);
    return false;
  }

  private async downloadVideo(url: string, taskId: string, apiKey: string): Promise<string> {
    const ext = '.mp4';
    const filename = `sora_${taskId}${ext}`;
    const outputPath = path.join(this.outputDir, filename);

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    return outputPath;
  }
}

export const soraVideoService = new SoraVideoService();
