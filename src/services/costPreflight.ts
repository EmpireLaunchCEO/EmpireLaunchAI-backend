/**
 * COST PRE-FLIGHT — nothing is bought until the video is provably producible.
 * (Owner, 23 Nov: "if no video gets produced or it fails up front ... it needs to
 * be stopped from ending up running Veo or gpt so there is no cost.")
 *
 * WHAT THIS IS
 * ------------
 * One free stage that runs BEFORE the planner's first paid call (GPT 5.2) and
 * therefore before any GPT Image, GPT Audio or Veo call. It decides, at $0, whether
 * this request could come out as a video at all. Any failure returns the reason,
 * the project is failed with that exact reason, and nothing was bought.
 *
 * WHY IT EXISTS
 * -------------
 * The planner runs before the fidelity gate, so a brief that could never be
 * rendered still cost a planner call before anything refused it. Everything here is
 * knowable without a plan, so none of it may wait for one.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE
 * ------------------------------------
 * Components placement. Deciding "every component the brief requires can actually
 * be placed" needs a PLAN, and a plan costs a call. The gate that decides it
 * (`resolveGateMissingComponents`) therefore still runs after the planner — but it
 * is no longer the FIRST thing that can refuse: everything cheap runs here first.
 *
 * EVERY CHECK IS FREE
 * -------------------
 *   duration / voice / tone  — the request itself
 *   quota                    — one read of the same constant enforcement reads
 *   ffmpeg + filters         — one local `ffmpeg -filters` (cached per process)
 *   render directory         — one mkdir + one write + one statfs
 *   uploaded photo           — one HEAD (a GET with a 1-byte range if HEAD is refused)
 *
 * No model, no media, no spend. The fixtures in `__tests__/costPreflight.test.ts`
 * drive it directly and count provider calls.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
// ONE SOURCE OF TRUTH for the voiceover choices: the same constants the voice
// resolver and the UI use, so a pre-flight can never disagree with what the
// renderer can actually speak or deliver.
import { GPT_AUDIO_VOICES, VOICE_GENDERS, VOICE_TONES } from './voiceOptions.js';

/** The code the route answers with, so the client sees the pre-flight reason. */
export const COST_PREFLIGHT_FAILED_CODE = 'COST_PREFLIGHT_FAILED';

/** The owner's three Faceless lengths (Nov 19: 10s → 4s, 15s → 6s, 30s → 16s of motion). */
export const FACELESS_LEGAL_LENGTHS = [10, 15, 30] as const;

/**
 * The voices and tones the renderer can actually honour: the UI's gender choices,
 * `'none'` (the pipeline's no-voiceover mode) and the verified gpt-audio voice ids
 * (a caller that names one is asking for a real voice, not a default). An
 * UNRECOGNISED value is refused rather than silently defaulted — "not stated →
 * ask, never a default" (owner rule).
 */
export const LEGAL_VOICES: readonly string[] = [...VOICE_GENDERS, 'none', ...GPT_AUDIO_VOICES];
export const LEGAL_TONES: readonly string[] = [...VOICE_TONES];

/**
 * Every filter the render path uses — FFmpeg's own assembly (xfade/zoompan/tpad/
 * overlay/…), the narration pass (amix/atempo/apad/atrim) and the blackdetect
 * invariant. A build without one of these produces a broken video AFTER the paid
 * calls, which is exactly the spend this stage exists to prevent.
 */
export const REQUIRED_FFMPEG_FILTERS = [
  'amix', 'apad', 'atempo', 'atrim', 'blackdetect', 'concat', 'drawbox', 'drawtext',
  'fade', 'format', 'fps', 'overlay', 'scale', 'setpts', 'tpad', 'xfade', 'zoompan',
] as const;

/** Room the render needs on disk (30s 1080x1920 + stills + narration, with headroom). */
export const MIN_FREE_RENDER_BYTES = 300 * 1024 * 1024;

export type CostPreflightCheck =
  | 'duration' | 'voice' | 'tone' | 'quota' | 'ffmpeg' | 'workdir' | 'photo';

export interface CostPreflightResult {
  ok: boolean;
  /** Which check refused. Present exactly when ok === false. */
  check?: CostPreflightCheck;
  /** The reason, in the words the client is shown. Present exactly when ok === false. */
  reason?: string;
}

export interface UrlProbeResult { ok: boolean; status?: number; detail?: string }

/** Injectable so a fixture can force one check without touching a real machine. */
export interface CostPreflightDeps {
  probeUrl?: (url: string) => Promise<UrlProbeResult>;
  probeFfmpeg?: () => { ok: boolean; missing: string[]; detail?: string };
  probeWorkDir?: (projectId: string) => { ok: boolean; detail?: string };
}

export interface CostPreflightInput {
  projectId: string;
  mode: 'faceless' | 'scene';
  /** The length the CLIENT asked for, before any clamp. */
  durationTarget?: number;
  voice?: string;
  tone?: string;
  /** The client's uploaded photo URL(s), as stored. */
  sourceImages?: string[];
  /** Reads the SAME counter enforcement reads. One read, never a write. */
  quotaRemaining: () => Promise<number | 'unlimited'>;
  deps?: CostPreflightDeps;
}

// ── ffmpeg probe (cached: one process, many videos) ─────────────────────────
let ffmpegProbeCache: { ok: boolean; missing: string[]; detail?: string } | null = null;

function probeFfmpegOnce(): { ok: boolean; missing: string[]; detail?: string } {
  if (ffmpegProbeCache) return ffmpegProbeCache;
  const run = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 15_000 });
  if (run.error || run.status !== 0) {
    ffmpegProbeCache = {
      ok: false,
      missing: [...REQUIRED_FFMPEG_FILTERS],
      detail: run.error?.message || `ffmpeg exited with code ${run.status}`,
    };
    return ffmpegProbeCache;
  }
  const present = new Set<string>();
  for (const line of String(run.stdout || '').split('\n')) {
    // Filter lines are "<flags> <name> <in->out> <description>"; the name is token 1.
    const name = line.trim().split(/\s+/)[1];
    if (name) present.add(name);
  }
  const missing = REQUIRED_FFMPEG_FILTERS.filter((f) => !present.has(f));
  ffmpegProbeCache = { ok: missing.length === 0, missing };
  return ffmpegProbeCache;
}

/** Test-only: forget the cached probe. */
export function __resetCostPreflightCaches(): void {
  ffmpegProbeCache = null;
}

// ── render directory probe ──────────────────────────────────────────────────
function probeWorkDirOnce(projectId: string): { ok: boolean; detail?: string } {
  const dir = path.join(process.cwd(), 'temp', 'scene-projects', projectId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.preflight-write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err: any) {
    return { ok: false, detail: `the render directory ${dir} is not writable (${err?.message || err})` };
  }
  try {
    const stat = fs.statfsSync(dir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (Number.isFinite(freeBytes) && freeBytes < MIN_FREE_RENDER_BYTES) {
      return {
        ok: false,
        detail: `only ${Math.floor(freeBytes / (1024 * 1024))} MB free in the render directory, the render needs ${Math.floor(MIN_FREE_RENDER_BYTES / (1024 * 1024))} MB`,
      };
    }
  } catch {
    // statfs is best-effort: the writability probe above already proved the write.
  }
  return { ok: true };
}

// ── uploaded photo probe ────────────────────────────────────────────────────
async function probeUrlOnce(url: string): Promise<UrlProbeResult> {
  const attempt = async (method: 'HEAD' | 'GET'): Promise<Response> =>
    fetch(url, {
      method,
      // A presigned R2 link may refuse HEAD; a 1-byte range answers the same question
      // ("does this URL resolve to the object") without downloading the image.
      headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  try {
    let res = await attempt('HEAD');
    if (!res.ok && (res.status === 403 || res.status === 405 || res.status === 501)) {
      res = await attempt('GET');
    }
    if (res.ok || res.status === 206) return { ok: true, status: res.status };
    return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, detail: err?.message || String(err) };
  }
}

/**
 * Run every free check, in order of cost (the request itself, then one DB read,
 * then the local machine, then the network). The FIRST failure is returned: it is
 * the reason the client is shown, and nothing is bought.
 */
export async function runCostPreflight(input: CostPreflightInput): Promise<CostPreflightResult> {
  const fail = (check: CostPreflightCheck, reason: string): CostPreflightResult => ({ ok: false, check, reason });

  // 1. DURATION — the owner's three lengths, checked BEFORE any clamp hides them.
  const raw = input.durationTarget;
  if (input.mode === 'faceless') {
    const legal = (FACELESS_LEGAL_LENGTHS as readonly number[]).includes(Number(raw));
    if (!legal) {
      return fail(
        'duration',
        `${raw === undefined || raw === null ? 'No length' : `${raw} seconds`} is not a length this video can be made in — a Faceless video is ${FACELESS_LEGAL_LENGTHS.join(', ')} seconds.`,
      );
    }
  } else if (!Number.isFinite(Number(raw)) || Number(raw) < 1) {
    return fail('duration', `${raw === undefined || raw === null ? 'No length' : `${raw} seconds`} is not a length this video can be made in.`);
  }

  // 2. VOICE — must be one the voice model can speak in (absent ⇒ the pipeline default).
  if (input.voice !== undefined && input.voice !== null && String(input.voice).trim() !== '') {
    if (!(LEGAL_VOICES as readonly string[]).includes(String(input.voice))) {
      return fail('voice', `"${input.voice}" is not a voice we can speak in — the choices are ${LEGAL_VOICES.join(', ')}.`);
    }
  }

  // 3. TONE — must be one the delivery model can read in (absent ⇒ auto).
  if (input.tone !== undefined && input.tone !== null && String(input.tone).trim() !== '') {
    if (!(LEGAL_TONES as readonly string[]).includes(String(input.tone))) {
      return fail('tone', `"${input.tone}" is not a tone we can deliver — the choices are ${LEGAL_TONES.join(', ')}.`);
    }
  }

  // 4. QUOTA — the same counter enforcement reads, read only.
  try {
    const remaining = await input.quotaRemaining();
    if (remaining !== 'unlimited' && Number(remaining) <= 0) {
      return fail('quota', 'No videos are left on this plan this week — this video was not started and nothing was generated.');
    }
  } catch {
    // A quota lookup that cannot answer must not refuse a video that is otherwise
    // producible; the route enforces the limit before the render starts.
  }

  // 5. FFMPEG — the binary and every filter the render uses.
  const ffmpeg = input.deps?.probeFfmpeg ? input.deps.probeFfmpeg() : probeFfmpegOnce();
  if (!ffmpeg.ok) {
    return fail(
      'ffmpeg',
      ffmpeg.missing.length && ffmpeg.missing.length < REQUIRED_FFMPEG_FILTERS.length
        ? `ffmpeg on this machine is missing the filters the render needs: ${ffmpeg.missing.join(', ')}.`
        : `ffmpeg on this machine cannot assemble a video${ffmpeg.detail ? ` (${ffmpeg.detail})` : ''}.`,
    );
  }

  // 6. RENDER DIRECTORY — writable, with room for the render.
  const workDir = input.deps?.probeWorkDir ? input.deps.probeWorkDir(input.projectId) : probeWorkDirOnce(input.projectId);
  if (!workDir.ok) {
    return fail('workdir', `The video could not be rendered on this machine: ${workDir.detail || 'the render directory is not usable'}.`);
  }

  // 7. THE UPLOADED PHOTO — a dead link would have been silently dropped.
  const probeUrl = input.deps?.probeUrl ?? probeUrlOnce;
  const photos = (input.sourceImages ?? []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 3);
  for (const url of photos) {
    const res = await probeUrl(url);
    if (!res.ok) {
      return fail(
        'photo',
        `The photo you uploaded does not resolve${res.status ? ` (HTTP ${res.status})` : res.detail ? ` (${res.detail})` : ''} — the video would have been made without it, so it was not started.`,
      );
    }
  }

  return { ok: true };
}
