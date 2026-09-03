import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import { eq, asc, and, inArray, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { soraVideoService, snapSoraSeconds, SORA_SCENE_SIZE } from './soraVideoService.js';
import { renderingEngine } from './renderingEngine.js';
import { aiRouter } from './aiRouter.js';
import { r2Storage } from './r2StorageService.js';
import { generateVideoExportVariants, VIDEO_EXPORT_VARIANTS } from './videoExportVariants.js';
import { resolveVoice } from './voiceOptions.js';
export interface SceneScript { sceneNumber: number; duration: number; visualType: 'motion'|'still'; narration: string; visualPrompt: string; }
export interface VideoProjectInput { userId: string; title: string; idea: string; platforms?: string[]; style?: string; durationTarget?: number; script?: any; voice?: 'female' | 'male'; tone?: 'enthusiastic' | 'calm' | 'serious' | 'warm' | 'auto'; mood?: string; sourceImages?: string[]; mode?: 'scene' | 'faceless'; }
/** Sora 2 intermittently reports status:failed ~55-90s into generation. Scene motion
 *  scenes retry up to 2 extra attempts with short backoff (mirrors the single-shot
 *  Customize Video worker in videoQueueService.ts). Worst case: 3 × ~90s + 25s backoff
 *  ≈ 5 min, inside the 7-min per-scene deadline. */
const SCENE_SORA_MAX_ATTEMPTS = 3; // initial + 2 automatic retries
const SCENE_SORA_RETRY_BACKOFF_MS = [0, 10_000, 15_000]; // backoff before attempts 1/2/3
function trace(message: string) { process.stderr.write(`[SCENE_PIPELINE] ${message}\n`); }
/** Railway-safe deadline: ticks every 5s (no long setTimeout) and rejects after ms. */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const started = Date.now();
    let done = false;
    const timer = setInterval(() => {
      if (done) { clearInterval(timer); return; }
      if (Date.now() - started >= ms) {
        done = true;
        clearInterval(timer);
        reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
      }
    }, 5000);
    promise.then(
      (v) => { if (!done) { done = true; clearInterval(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearInterval(timer); reject(e); } },
    );
  });
}
function inputHasAudio(input: string): boolean {
  try {
    return execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', input,
    ], { maxBuffer: 1024 * 1024 }).toString().trim().length > 0;
  } catch {
    return false;
  }
}
function probeDuration(input: string): number {
  try {
    return Number(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', input,
    ], { maxBuffer: 1024 * 1024 }).toString().trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Deterministic post-render smoothness QC (cheap ffprobe, NO AI / NO paid renders).
 * Runs on the FINAL assembled MP4 and returns a report of assertions:
 *   - r_frame_rate == 30/1 (the output contract; any other cadence = micro-judder risk)
 *   - nb_frames ≈ duration*30 (frame count matches the 30fps timeline)
 *   - scene-detect hard-cut flag (select='gt(scene,0.4)' — a transition ABOVE the
 *     threshold means a jarring hard cut survived; xfade dissolves are ~0.05-0.1)
 *   - freezedetect / blackdetect / silencedetect (frozen frame, black frame, silent gap)
 *   - exactly ONE audio stream (the voiceover; source/talent audio must be gone —
 *     the audio-bleed contract)
 * The caller logs the report and can attach it to the draft payload so the GPT-5.2
 * exception-handler router (decision-only, no pixel/audio edits) can SELECT a fix.
 */
export function runRenderQC(media: string): Record<string, any> {
  const report: Record<string, any> = { ok: true, flags: [] as string[] };
  try {
    const fmt = execFileSync('ffprobe', [
      '-v','error','-select_streams','v:0','-show_entries',
      'stream=r_frame_rate,nb_frames,codec_name,width,height',
      '-of','json', media,
    ], { maxBuffer: 4 * 1024 * 1024 }).toString();
    const v = JSON.parse(fmt).streams?.[0] || {};
    report.video = { codec: v.codec_name, width: v.width, height: v.height, r_frame_rate: v.r_frame_rate, nb_frames: v.nb_frames };
    // r_frame_rate == 30/1 assert
    const [num, den] = String(v.r_frame_rate || '0/1').split('/').map(Number);
    const fps = num && den ? num / den : 0;
    report.fps = Math.round(fps * 100) / 100;
    if (Math.abs(fps - 30) > 0.51) { report.ok = false; report.flags.push('fps_not_30'); }
    // nb_frames ≈ duration*30 assert
    const dur = probeDuration(media);
    report.duration = Math.round(dur * 100) / 100;
    const frames = Number(v.nb_frames) || 0;
    if (frames > 0 && dur > 0 && Math.abs(frames - dur * 30) > Math.max(4, dur * 30 * 0.03)) { report.ok = false; report.flags.push('frame_count_mismatch'); }
    // exactly ONE audio stream
    const aList = execFileSync('ffprobe', [
      '-v','error','-select_streams','a','-show_entries','stream=codec_type','-of','csv=p=0', media,
    ], { maxBuffer: 1024 * 1024 }).toString().trim().split('\n').filter(Boolean);
    report.audioStreams = aList.length;
    if (aList.length !== 1) { report.ok = false; report.flags.push(aList.length === 0 ? 'no_audio' : 'multi_audio_streams'); }
    // scene-detect hard cuts (frame-scene metric: xfade dissolves ~0.0x-0.1; >0.4 = hard cut)
    try {
      const scene = execFileSync('ffmpeg', [
        '-i', media, '-vf', "select='gt(scene,0.4)'", '-f', 'null', '-',
      ], { maxBuffer: 1024 * 1024 }).toString();
      // ffmpeg writes "Parsed_select" once per selected frame to stderr; count them.
      const hardCuts = (scene.match(/Parsed_select/g) || []).length;
      report.hardCuts = hardCuts;
      if (hardCuts > 1) { report.ok = false; report.flags.push('hard_cut_detected'); }
    } catch { report.hardCuts = -1; }
    // silencedetect (audio gap > 1s) — cheap
    try {
      const sil = execFileSync('ffmpeg', [
        '-i', media, '-af', 'silencedetect=noise=-35dB:d=1', '-f', 'null', '-',
      ], { maxBuffer: 2 * 1024 * 1024 }).toString();
      report.silenceCount = (sil.match(/silence_(start|end)/g) || []).length;
      if ((report.silenceCount || 0) > 0) { report.ok = false; report.flags.push('silence_detected'); }
    } catch { report.silenceCount = -1; }
    // freezedetect (frozen frame > 2s)
    try {
      const fz = execFileSync('ffmpeg', [
        '-i', media, '-vf', 'freezedetect=n=-60dB:d=2', '-f', 'null', '-',
      ], { maxBuffer: 2 * 1024 * 1024 }).toString();
      report.freezeCount = (fz.match(/freeze_(start|end)/g) || []).length;
      if ((report.freezeCount || 0) > 0) { report.ok = false; report.flags.push('freeze_detected'); }
    } catch { report.freezeCount = -1; }
    // blackdetect (all-black frames > 0.5s)
    try {
      const blk = execFileSync('ffmpeg', [
        '-i', media, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-f', 'null', '-',
      ], { maxBuffer: 2 * 1024 * 1024 }).toString();
      report.blackCount = (blk.match(/black_(start|end)/g) || []).length;
      if ((report.blackCount || 0) > 0) { report.ok = false; report.flags.push('black_frame_detected'); }
    } catch { report.blackCount = -1; }
  } catch (e: any) {
    report.ok = false;
    report.flags.push('qc_error');
    report.error = e?.message;
  }
  return report;
}

export function renderClip(input: string, output: string, duration: number, audio?: string, opts?: { kenburns?: boolean }): Promise<void> {
  return new Promise((resolve,reject)=>{
    // Explicit arg order is load-bearing: for a still image we need `-loop 1` IMMEDIATELY before `-i image.png`.
    // fluent-ffmpeg's .loop() misplaces `-loop 1` when a 2nd input (narration .wav) is added -> "Option loop not found".
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(input);
    // Ken Burns applies ONLY to Faceless stills (gpt-image-2 + FFmpeg zoompan). Scene-Based
    // and Neural Twin stay untouched. When enabled we feed the image ONCE (no `-loop 1`)
    // and let zoompan synthesize the target number of frames for gentle pan/zoom motion.
    const kenburns = Boolean(opts?.kenburns) && isImage;
    // AUDIO BLEED FIX (owner finding): the source clip's embedded audio (on-screen
    // talent / dialogue from Sora or the scene source) must NEVER survive into the
    // final mix. The old branch preserved [0:a:0] at volume 1.0 and mixed it under
    // the GPT-Audio narration — exactly the reported "second voice starts when the
    // person in the video talks". Default per owner: source audio REMOVED. We map
    // ONLY the narration track (1:a:0). inputHasAudio() stays for the probe only.
    const srcDur = !isImage ? probeDuration(input) : 0;
    // LOOP-PAD POLICY (choppiness fix): unconditional -stream_loop -1 hard-splices at
    // every loop point (visible judder) and also loops embedded audio. New policy:
    //   - source >= 60% of target -> -stream_loop 1 (one splice, then hold) — still
    //     fills the target with at most ONE loop transition.
    //   - source < 60% of target (very short) -> tpad=stop_mode=clone FREEZE-LAST-FRAME
    //     pad + 250ms fade in/out — no loop splice at all, clean hold on the final frame.
    const padByLoop = srcDur >= 0.6 * duration;
    const inputs: string[] = [];
    if (isImage) {
      if (kenburns) {
        // Faceless: single still input; zoompan below generates `d` frames per second
        // to produce smooth Ken Burns motion for the whole scene duration.
        inputs.push('-i',input);
      } else {
        // Still image: `-loop 1` feeds frames indefinitely so `-t duration` yields a
        // clip of exactly the target length (static hold — Scene-Based stills).
        inputs.push('-loop','1','-i',input);
      }
    } else if (padByLoop) {
      // Sora clip long enough: loop ONCE (2x coverage), then -t caps at target.
      inputs.push('-stream_loop','1','-i',input);
    } else {
      // Sora clip too short for a clean loop: no -stream_loop. Feed once; tpad
      // clones the LAST frame to fill the gap (clean freeze, no splice judder).
      inputs.push('-i',input);
    }
    if (audio) inputs.push('-i',audio);
    inputs.push('-map','0:v:0');
    if (audio) {
      // Voiceover is the ONLY audio track. NEVER map 0:a (source/talent audio) —
      // owner finding: the second voice is the source clip's embedded track.
      inputs.push('-map','1:a:0');
    }
    // FPS NORMALIZATION (choppiness): Sora clips arrive at their native cadence
    // (commonly 24/25fps). The output contract is 30fps. The old code only set
    // -r 30 at encode time, which dupes/drops frames through xfade — micro-judder.
    // Normalize EVERY segment to 30fps BEFORE encode: fps=30:round=0 (no dupe on
    // the boundary) + setpts=PTS-STARTPTS (reset timestamps so xfade offsets and
    // tpad math are all in the same 30fps timeline).
    const fpsNorm = 'fps=30:round=0,setpts=PTS-STARTPTS';
    // Ken Burns smoothness: zoompan's integer zoom steps stutter at slow rates.
    // minterpolate=fps=30:mi_mode=mci motion-interpolates between the zoompan
    // frames for smooth, fluid pan/zoom.
    const kenburnsVf = kenburns
      ? `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,zoompan=z='min(zoom+0.0015,1.15)':d=${Math.max(1, Math.round(duration * 30))}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,minterpolate=fps=30:mi_mode=mci`
      // Contain/refit — NEVER crop — every segment (still AND Sora motion) to the
      // 1080x1920 / 9:16 output contract BEFORE fps normalization, so concatClips'
      // xfade math sees identical cadence AND dimensions.
      : `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2`;
    // tpad clone-fill for the very-short-source case: freeze last frame + 250ms
    // fades (clean, no loop splice). Applied AFTER fps normalization (same cadence).
    const padFill = (!isImage && !padByLoop && srcDur > 0)
      ? `,tpad=stop_mode=clone:stop_duration=${Math.max(0, duration - srcDur)},fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, duration - 0.25)}:d=0.25`
      : '';
    inputs.push('-vf', kenburnsVf + ',' + fpsNorm + padFill);
    inputs.push('-t',String(duration));
    inputs.push('-c:v','libx264','-pix_fmt','yuv420p');
    if (audio) inputs.push('-c:a','aac');
    inputs.push('-y',output);
    execFile('ffmpeg',inputs,{maxBuffer:32*1024*1024},(err,_stdout,stderr)=>{
      if(err) reject(new Error('ffmpeg exited with code '+(err.code??'')+': '+String(stderr||err.message).split('\n').filter(Boolean).slice(-3).join(' ')));
      else resolve();
    });
  });
}
export function concatClips(inputs: string[], output: string): Promise<void> { return new Promise((resolve,reject)=>{
  // Smooth dissolve transitions (xfade) instead of hard cuts. All clips are
  // rendered to the same 1080x1920 / 30fps / yuv420p in renderClip, so they can
  // be crossfaded directly. Each xfade overlaps by TRANSITION_MS.
  const DURATION_MS = process.env.SCENE_TRANSITION_MS ? Number(process.env.SCENE_TRANSITION_MS) : 500;
  const TR_MS = Math.min(DURATION_MS, 1000);
  if (inputs.length === 1) {
    const cmd = ffmpeg().input(inputs[0]);
    cmd.outputOptions(['-c:v','libx264','-pix_fmt','yuv420p','-r','30']);
    // single-input re-encode carries all streams (incl. audio) through by default
    return void cmd.save(output).on('end',()=>resolve()).on('error',reject);
  }
  const probe = (f: string): { seconds: number; hasAudio: boolean } => {
    try {
      const dur = execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',f],{maxBuffer:1024*1024}).toString().trim();
      const seconds = Number.isFinite(parseFloat(dur)) ? parseFloat(dur) : 3;
      let hasAudio = false;
      try {
        const a = execFileSync('ffprobe',['-v','error','-select_streams','a','-show_entries','stream=codec_type','-of','csv=p=0',f],{maxBuffer:1024*1024}).toString().trim();
        hasAudio = a.length > 0;
      } catch { hasAudio = false; }
      return { seconds, hasAudio };
    } catch { return { seconds: 3, hasAudio: false }; }
  };
  try {
    // First pass: probe each clip's duration + whether it has an audio track so
    // xfade offsets are exact and audio can be crossfaded and mapped into the final.
    const probes = inputs.map(probe);
    const seconds = probes.map(p => p.seconds);
    const tr = TR_MS/1000;
    const filter = [];
    let offsetAcc = 0;
    // xfade chain (VIDEO). IMPORTANT: the FIRST input is stream 0:v (never renamed),
    // so the first transition is [0:v][1:v]xfade[v1]; each following reuses the
    // previous output: [v1][2:v]xfade[v2], ...
    offsetAcc = Math.max(0, seconds[0] - tr);
    filter.push(`[0:v][1:v]xfade=transition=fade:duration=${tr}:offset=${offsetAcc.toFixed(3)}[v1]`);
    for (let i=2;i<inputs.length;i++){
      offsetAcc = Math.max(0, offsetAcc + seconds[i-1] - tr);
      filter.push(`[v${i-1}][${i}:v]xfade=transition=fade:duration=${tr}:offset=${offsetAcc.toFixed(3)}[v${i}]`);
    }
    // ── AUDIO: carry each clip's narration through with acrossfade between
    //    consecutive audio-bearing clips (same overlap tr as the video xfade), then
    //    map it into the output. This was the missing piece — the old assembler ran
    //    xfade on video only and mapped ONLY [vN], silently dropping every clip's
    //    audio track (the gpt-audio narration), producing a silent final MP4.
    const anyAudio = probes.some(p => p.hasAudio);
    const audioFilter: string[] = [];
    let audioMap: string | null = null;
    if (anyAudio) {
      let aIdx = 0;
      let audioLast: string | null = null;
      for (let i = 0; i < inputs.length; i++) {
        if (!probes[i].hasAudio) continue;
        const tag = `[${i}:a]`;
        if (audioLast === null) { audioLast = tag; }
        else {
          audioFilter.push(`${audioLast}${tag}acrossfade=d=${tr}[amix${aIdx}]`);
          audioLast = `[amix${aIdx}]`;
          aIdx++;
        }
      }
      if (audioLast) {
        // filter-output labels stay bracketed for -map ([amixN]); a lone input
        // stream (only one clip has audio) must map bare (e.g. 0:a).
        audioMap = aIdx > 0 ? audioLast : audioLast.replace(/^\[|\]$/g, '');
      }
    }
    return void (async()=>{
      const fc = filter.concat(audioFilter).join(';');
      const args:string[] = [];
      inputs.forEach(i=>{ args.push('-i',i); });
      args.push('-filter_complex', fc, '-map','[v'+(inputs.length-1)+']');
      if (audioMap) { args.push('-map', audioMap, '-c:a','aac','-b:a','128k'); }
      args.push('-c:v','libx264','-pix_fmt','yuv420p','-r','30','-y',output);
      execFile('ffmpeg',args,{maxBuffer:32*1024*1024},(err,_stdout,stderr)=>{
        if(err) reject(new Error('ffmpeg xfade exited with code '+(err.code??'')+': '+String(stderr||err.message).split('\n').filter(Boolean).slice(-4).join(' ')));
        else resolve();
      });
    })();
  } catch(e:any){
    reject(new Error('xfade concat failed: '+e.message));
  }
}); }
/** Max Scene-Based video duration (3 minutes). Durations above this are rejected at the route. */
export const MAX_SCENE_DURATION = 180;
/** Target ~1 scene per 6s of video so every scene stays a short, renderable single Sora shot. */
const SECONDS_PER_SCENE = 6;
const MIN_SCENES = 3;
const MAX_SCENES = 60;
/** Bounded parallelism for scene generation — a 3-min (15–30 scene) video must NOT fire
 *  that many concurrent Sora/gpt-audio calls (rate limits, cost spike, memory). */
const SCENE_CONCURRENCY = 3;
/** Per-scene provider deadline (unchanged from prior behaviour). */
const SCENE_DEADLINE_MS = 7 * 60 * 1000;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Scale the number of scenes with the duration target: ~1 scene per 6s, 3..60 scenes. */
function targetSceneCount(durationTarget: number): number {
  return clamp(Math.round(durationTarget / SECONDS_PER_SCENE), MIN_SCENES, MAX_SCENES);
}

/**
 * Build a coherent N-scene story arc (hook → development → payoff/CTA) around ONE
 * continuous subject (`idea`), each scene ~durationTarget/N seconds. Used both as the
 * fallback when GPT returns no script and as the per-scene pad when it under-delivers.
 * Durations are distributed so the exact sum equals durationTarget.
 */
function compactCreativeSubject(idea: string, maxChars = 160): string {
  const firstSentence = String(idea || '').split(/(?<=[.!?])\s+/)[0]?.trim() || String(idea || '').trim();
  if (firstSentence.length <= maxChars) return firstSentence;
  return `${firstSentence.slice(0, maxChars - 1).trimEnd()}…`;
}

function buildArcScenes(idea: string, count: number, durationTarget: number): SceneScript[] {
  const subject = compactCreativeSubject(idea);
  const base = Math.floor(durationTarget / count);
  const rem = durationTarget - base * count;
  return Array.from({ length: count }, (_, i) => {
    const f = count <= 1 ? 0.5 : i / (count - 1); // 0..1 story progress
    // Distinct beats so every scene ADVANCES the narrative instead of repeating a
    // handful of near-identical variants (quality bug from the old 3-group arc).
    let narration: string;
    let visualPrompt: string;
    if (f < 0.25) {
      narration = `Opening — introducing ${subject}.`;
      visualPrompt = `Cinematic establishing shot: hook intro of ${subject}, the subject shown clearly for the first time`;
    } else if (f < 0.5) {
      narration = `Getting started: the essentials of ${subject} come into focus.`;
      visualPrompt = `Cinematic medium shot: setting up the fundamentals of ${subject}, subject continues from the opening, early stage`;
    } else if (f < 0.75) {
      narration = `Now it comes together — the transformation and key benefit of ${subject} in action.`;
      visualPrompt = `Cinematic wide shot: ${subject} delivering its key benefit, the transformation in progress, same continuous subject`;
    } else if (f < 1) {
      narration = `The payoff: look at the result ${subject} delivers.`;
      visualPrompt = `Cinematic close-up: the payoff result of ${subject}, same continuous subject, breakthrough moment`;
    } else {
      narration = `Call to action: ready to take the next step with ${subject}?`;
      visualPrompt = `Cinematic closing shot: ${subject} final call-to-action, same continuous subject, confident ending`;
    }
    return {
      sceneNumber: i + 1,
      duration: base + (i < rem ? 1 : 0),
      // Arc scenes are the NO-PLAN fallback — default to 'still' (gpt-image-2 +
      // Ken Burns, ~free) so a malformed/missing Hybrid director plan degrades to
      // ZERO Sora calls instead of N. Motion (the ONE important block) only comes
      // from the hybrid plan path or an explicit GPT visualType in parseScenes.
      visualType: 'still' as const,
      narration,
      visualPrompt,
    };
  });
}

/**
 * Map `fn` over `items` with at most `limit` promises in-flight at once. Preserves
 * input order in the result. Prevents 30–60 concurrent provider calls on long videos.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
}

function parseScenes(raw: any, idea: string, durationTarget = 30): SceneScript[] {
  const count = targetSceneCount(durationTarget);
  const candidates = Array.isArray(raw) ? raw : (Array.isArray(raw?.scenes) ? raw.scenes : []);
  const arc = buildArcScenes(idea, count, durationTarget);
  const base = Math.floor(durationTarget / count);
  const rem = durationTarget - base * count;
  if (candidates.length) {
    // Evenly distribute durationTarget across exactly `count` short scenes so every
    // clip is ~5-6s and renderable (a single Sora shot cannot produce ~100s). Use
    // GPT's visual/narration per scene when available; pad to `count` with the arc
    // if GPT under-delivers. IMPORTANT: do NOT clamp the candidate index to the last
    // element — clamping made every beyond-range slot a CLONE of the final scene
    // (typically the CTA), which is why longer videos repeated the same visuals.
    // Instead, read the candidate at `i` (undefined past the end) and fall back to
    // the corresponding progressive arc beat so every scene stays distinct.
    //
    // FALLBACK COST GUARD (D): this fallback runs when the hybrid director plan is
    // malformed/missing. It must NOT default every scene to motion — that fired ONE
    // Sora call per scene (5 calls ≈ $2+, owner's cost risk). Honor an EXPLICIT
    // GPT visualType, but cap motion scenes to AT MOST ONE (the most important
    // block); every other scene becomes a 'still' (gpt-image-2 + Ken Burns, ~free).
    // So a malformed plan degrades to ≤1 Sora call, never N.
    const wantMotion = candidates
      .map((c: any) => c?.visualType || c?.type || c?.sceneType)
      .map((t: any) => String(t || '').toLowerCase());
    let motionUsed = false;
    return Array.from({ length: count }, (_, i) => {
      const s = candidates[i];
      const a = arc[i];
      const askedMotion = wantMotion[i] === 'motion' || wantMotion[i] === 'sora';
      const keepMotion = askedMotion && !motionUsed;
      if (keepMotion) motionUsed = true;
      return {
        sceneNumber: i + 1,
        duration: base + (i < rem ? 1 : 0),
        visualType: keepMotion ? 'motion' : 'still',
        narration: sceneCopyOrFallback(s?.narration, a.narration, a.duration, true),
        visualPrompt: sceneCopyOrFallback(s?.visualPrompt || s?.visual_prompt, a.visualPrompt, a.duration, false),
      };
    });
  }
  return arc;
}
/**
 * Parse the GPT 5.2 DIRECTOR output into the executable scene list.
 *
 * - FACELESS: legacy scene-script shape (scenes[] of {sceneNumber,duration,visualType,
 *   narration,visualPrompt}) → parseScenes() → stills forced downstream.
 * - SCENE (hybrid, owner-locked): the director emits a FULL-VIDEO PLAN with
 *   `soraContent` (the ONE ~20s important block) + `scenes[]` where EXACTLY ONE scene
 *   is type "sora" (carries the important motion) and the rest are "gpt-image" stills
 *   that FFmpeg animates with Ken Burns (mirroring Faceless). We read the scene list
 *   with per-scene type→visualType mapping, and attach the ONE soraContent prompt to
 *   the sora scene's visualPrompt so processScene knows it's the consolidated call.
 *
 * If the planner returns the legacy shape (or nothing), we fall back to parseScenes()
 * so Scene still renders (motion scenes stay Sora per scene — degraded but functional).
 */
function parseScenePlan(raw: any, idea: string, durationTarget: number, mode: 'faceless' | 'scene'): SceneScript[] {
  if (mode === 'faceless') return parseScenes(raw, idea, durationTarget);
  const scenesRaw = Array.isArray(raw) ? raw : (Array.isArray(raw?.scenes) ? raw.scenes : []);
  // Hybrid shape requires a soraContent block AND at least one scene typed "sora".
  const soraContent = raw?.soraContent;
  const hasSoraTyped = scenesRaw.some((s: any) => String(s?.type || s?.sceneType || '').toLowerCase() === 'sora');
  if (soraContent && scenesRaw.length >= 2 && hasSoraTyped) {
    const soraPrompt = String(soraContent.prompt || '');
    const soraDuration = Number.isFinite(Number(soraContent.duration)) ? Math.max(1, Math.round(Number(soraContent.duration))) : 0;
    const totalPlan = scenesRaw.reduce((a: number, s: any) => a + (Number.isFinite(Number(s?.duration)) ? Number(s.duration) : 0), 0);
    const scale = totalPlan > 0 ? durationTarget / totalPlan : 1;
    const base = Math.floor(durationTarget / Math.max(1, scenesRaw.length));
    const rem = durationTarget - base * scenesRaw.length;
    const scenes: SceneScript[] = scenesRaw.map((s: any, i: number): SceneScript => {
      const isSora = String(s?.type || s?.sceneType || '').toLowerCase() === 'sora';
      const dur = Math.round((Number.isFinite(Number(s?.duration)) ? Number(s.duration) : 0) * scale);
      return {
        sceneNumber: i + 1,
        duration: dur > 0 ? dur : base + (i < rem ? 1 : 0),
        visualType: isSora ? 'motion' : 'still',
        narration: s?.narration || '',
        visualPrompt: isSora && soraPrompt ? `${s.visualPrompt || ''} — ${soraPrompt}`.trim() : (s?.visualPrompt || s?.visual_prompt || ''),
      };
    });
    // Normalize the sum to exactly durationTarget (rounding drift).
    const drift = durationTarget - scenes.reduce((a, s) => a + s.duration, 0);
    if (scenes.length) scenes[scenes.length - 1].duration = Math.max(1, scenes[scenes.length - 1].duration + drift);
    return scenes;
  }
  return parseScenes(raw, idea, durationTarget);
}
/** True if a URL looks like a short video file (used to splice an uploaded clip as b-roll/opening). */
function isVideoUrl(url: string): boolean {
  const clean = (url.split('?')[0] || '').toLowerCase();
  return /\.(mp4|mov|webm|m4v|mkv|avi)$/.test(clean);
}
/** Enrich a per-scene visual prompt so the user's uploaded image becomes the continuous subject. */
function withSourceSubject(prompt: string, sourceImage?: string): string {
  if (!sourceImage) return prompt;
  return `${prompt} — Use the user's uploaded reference image as the hero and continuous subject: ${sourceImage}. Keep this exact subject visible and consistent across every scene; do NOT swap it for a different subject.`;
}
/** Enrich the scene-script GPT prompt so the planner keeps the uploaded image as the subject. */
function sourceScriptHint(sourceImage?: string): string {
  if (!sourceImage) return '';
  return ` The user uploaded a reference image as the one continuous subject: ${sourceImage}. Scene 1 (the hook) MUST lead with, and clearly establish, this exact image/subject. Every later scene keeps the SAME subject (the uploaded image's subject) so the video feels coherent — never replace it with a different one.`;
}

/**
 * The consultant can hand the scene endpoint a transcript instead of a clean
 * creative brief. Keep the actual idea while removing known UI/consultant
 * framing so fallback scenes never narrate internal planning dialogue.
 */
function normalizeVideoIdea(rawIdea: string): string {
  let idea = String(rawIdea || '').replace(/\s+/g, ' ').trim();
  const ideaMarker = /here(?:\u2019|')s\s+my\s+video\s+idea\s*:/i;
  const markerMatch = idea.match(ideaMarker);
  if (markerMatch?.index !== undefined) idea = idea.slice(markerMatch.index + markerMatch[0].length).trim();

  const endMarkers = [
    /\bone\s+quick\s+detail\s+so\s+i\s+can\s+tailor\b/i,
    /\bwhat(?:\u2019|')s\s+the\s+platform\s+name\s+you\s+want\s+shown\b/i,
    /\bwhat\s+color\s+palette\s+should\b/i,
    /\bgreat,\s*tap\s+the\s+wand\s+to\s+generate!?/i,
  ];
  for (const marker of endMarkers) {
    const match = idea.match(marker);
    if (match?.index !== undefined) idea = idea.slice(0, match.index).trim();
  }

  // Remove a consultant hand-off left at the end of the extracted brief.
  idea = idea.replace(/\s+locked\s+in[.!]?\s*$/i, '').trim();
  return idea || String(rawIdea || '').trim().slice(0, 1000);
}

const CONSULTANT_META_PATTERN = /let(?:\u2019|')s\s+design\s+your\s+video|what\s+visuals\s+are\s+you\s+imagining|i(?:\u2019|')ll\s+refine\s+the\s+script|one\s+quick\s+detail|default\s+suggestion|tap\s+the\s+wand\s+to\s+generate|what(?:\u2019|')s\s+the\s+platform\s+name|what\s+color\s+palette\s+should/i;

function sceneCopyOrFallback(value: unknown, fallback: string, duration: number, narration: boolean): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || CONSULTANT_META_PATTERN.test(text)) return fallback;
  // A six-second scene can only carry a short complete line. Returning the
  // arc fallback is safer than sending long text to TTS, which gets cut off by
  // the scene's fixed duration and sounds like a clipped sentence.
  const maxWords = narration ? Math.max(14, Math.round(duration * 2.75)) : 90;
  if (text.split(/\s+/).length > maxWords) return fallback;
  return text;
}

export class SceneVideoPipelineService {
  async createProject(input: VideoProjectInput): Promise<string> {
    trace(`project_create_start user=${input.userId}`);
    const projectId = uuidv4();
    // The consultant UI may send its transcript as `idea`; isolate the actual
    // creative brief before it reaches the planner or fallback arc.
    const cleanIdea = normalizeVideoIdea(input.idea);
    // Clamp to the 3-min cap (defense in depth — the route also rejects > MAX).
    const rawDuration = input.durationTarget && Number.isFinite(input.durationTarget) ? input.durationTarget : 30;
    const duration = clamp(Math.round(rawDuration), 1, MAX_SCENE_DURATION);
    let generatedScript = input.script;
    if (!generatedScript) {
      trace(`gpt52_script_start project=${projectId}`);
      try {
        const toneHint = input.tone && input.tone !== 'auto' ? ` Use a ${input.tone} narration tone.` : '';
        const moodHint = input.mood ? ` Overall mood: ${input.mood} — apply it to the visual tone AND the narration of every scene.` : '';
        // Scale the number of scenes with the duration: ~1 short scene per 6s so every
        // scene stays a renderable single shot (a lone Sora clip cannot produce ~100s).
        const sceneCount = targetSceneCount(duration);
        const perScene = Math.max(1, Math.round(duration / sceneCount));
        const srcHint = sourceScriptHint(input.sourceImages?.[0]);
        const maxNarrationWords = Math.max(14, Math.round(perScene * 2.75));
        // Hybrid Scene director (owner-locked): GPT 5.2 plans the WHOLE video up front —
        // which ~20s of content is the SINGLE most-important block (the ONE Sora call),
        // and the full scene list/order/timings. Everything else renders as gpt-image-2
        // stills animated with slow FFmpeg Ken Burns (mirroring Faceless). Sora is called
        // ONCE per ~20s of important content, NOT fragmented into many 5-6s clips.
        const importantBlock = Math.min(20, duration);
        const hybridDirective = ` The final video is a HYBRID: ONE single Sora call carries ${importantBlock}s of the MOST-important content (the hero moment / key benefit / payoff you would spend motion on) — a continuous single take, no cuts. ALL other scenes are "gpt-image" stills (animated with slow Ken Burns pan/zoom). Return a JSON object with EXACTLY: a "soraContent" object { duration: ${importantBlock}, prompt: ONE consolidated detailed prompt for that important ${importantBlock}s }, and a "scenes" array of exactly ${sceneCount} objects each { sceneNumber, duration (sum exactly ${duration}), type: "sora" | "gpt-image" (EXACTLY ONE type "sora"), visualPrompt, narration (one complete natural sentence ≤ ${maxNarrationWords} words) }. Do NOT narrate consultant dialogue, planning notes, questions, UI instructions, or chat history. High quality, coherent single subject, distinct visuals per scene, story arc: hook → important sora beat → payoff/CTA.

FEW-SHOT EXAMPLE (shape to return EXACTLY — do not copy the topic, only the structure): for a 3-scene video this is the required JSON:
{"soraContent": {"duration": 20, "prompt": "One continuous ~20s cinematic take of the hero moment showing the product's key benefit in action, no cuts, fluid motion."}, "scenes": [{"sceneNumber": 1, "duration": 8, "type": "gpt-image", "visualPrompt": "Cinematic establishing shot of the subject, hook intro", "narration": "Opening: meet the subject."}, {"sceneNumber": 2, "duration": 20, "type": "sora", "visualPrompt": "The important block — hero moment close-up", "narration": "This is the moment it comes together."}, {"sceneNumber": 3, "duration": 8, "type": "gpt-image", "visualPrompt": "Confident closing shot, call to action", "narration": "Ready to take the next step?"}]}
Your response must be ONLY that JSON object (no markdown fences, no commentary).`;
        const legacyConstrain = input.mode === 'faceless'
          ? ` Return a JSON object with a "scenes" array of ${sceneCount} objects, each with sceneNumber, duration (seconds, around ${perScene}), visualType ("motion" or "still"), narration, and visualPrompt.`
          : hybridDirective;
        const decision = await aiRouter.route({ userId: input.userId, request: `Create a JSON scene script using ONLY this clean creative brief: ${cleanIdea}. Do not narrate consultant dialogue, planning notes, questions, UI instructions, or chat history. The final video is ${duration} seconds long, planned as exactly ${sceneCount} short scenes of about ${perScene} seconds each (total summing to ${duration}s).${legacyConstrain}${toneHint}${moodHint}${srcHint}\n\nSTORY ARC REQUIREMENT (mandatory): because this is a longer video, the scenes MUST form a coherent multi-scene progression with ONE continuous subject (never random unrelated clips). Structure it as: the first ~25% establishes the hook/subject, the middle ~50% develops the subject and shows the transformation or key benefit, and the final ~25% delivers the payoff and a clear call-to-action. Each scene must ADVANCE the story from the previous one — do NOT repeat the opening scene multiple times. Keep the same subject, setting, and visual identity across every scene so the video feels continuous.\n\nUNIQUENESS REQUIREMENT (mandatory): every scene's visualPrompt must describe a DIFFERENT moment, action, camera angle, or stage of the story that moves it forward — a unique scene-specific visual. It is NOT acceptable to give multiple scenes the same visual with only a change of "variant"/"angle"/"color"; if scenes 1-3 look the same, you have failed. Each of the ${sceneCount} visualPrompt and narration values must be distinct from the others.`, mode: 'generate' });
        generatedScript = decision.script || decision.parameters?.script;
        trace(`gpt52_script_end project=${projectId} generated=${!!generatedScript}`);
      } catch (error: any) { trace(`gpt52_script_failed project=${projectId} error=${error.message}`); }
    }
    const script = parseScenePlan(generatedScript || {}, cleanIdea, duration, input.mode === 'faceless' ? 'faceless' : 'scene');
    // FACELESS-ONLY: force every scene down the still path (gpt-image-2 + FFmpeg Ken
    // Burns/zoompan) regardless of what the GPT planner returned, so Faceless never
    // consumes paid Sora motion calls. Scene-Based and Neural Twin are unaffected.
    const mode = input.mode === 'faceless' ? 'faceless' : 'scene';
    if (mode === 'faceless') { for (const s of script) { s.visualType = 'still'; } }
    await db.insert(schema.videoProjects).values({id:projectId,userId:input.userId,title:input.title||input.idea.slice(0,80),status:'generating',totalDuration:script.reduce((a,s)=>a+s.duration,0),sceneCount:script.length,script,metadata:{platforms:input.platforms||[],style:input.style||'',voice:input.voice||'',tone:input.tone||'',sourceImages:input.sourceImages||[],mode,plan:{scenes:script}}});
    await db.insert(schema.videoScenes).values(script.map(s=>({id:uuidv4(),projectId,sceneNumber:s.sceneNumber,duration:s.duration,visualType:s.visualType,narration:s.narration,visualPrompt:s.visualPrompt,status:'pending',metadata:{importantSora:s.visualType==='motion'}})));
    trace(`project_created id=${projectId} scenes=${script.length}`);
    void this.processProject(projectId, input.userId).catch(e=>trace(`worker_unhandled project=${projectId} error=${e?.message}`));
    return projectId;
  }
  async processProject(projectId:string,userId:string,skipGeneration=false):Promise<void> {
    const scenes=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber));
    trace(`worker_start project=${projectId} scenes=${scenes.length}`);
    // Pull the project's voiceover selection (persisted by createProject) so scene
    // narration is voiced with the user's gender/tone instead of a hardcoded alloy.
    const [projectRow] = await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id, projectId)).limit(1);
    const pmeta = ((projectRow?.metadata as any) || {});
    const voice = pmeta.voice as 'female' | 'male' | undefined;
    const tone = pmeta.tone as 'enthusiastic' | 'calm' | 'serious' | 'warm' | 'auto' | undefined;
    const sourceImages: string[] = Array.isArray(pmeta.sourceImages)
      ? pmeta.sourceImages.filter((u: any) => typeof u === 'string' && u.length > 0)
      : [];
    const heroSource = sourceImages[0];
    if (!skipGeneration) {
      // Never let a provider call leave a scene in `generating` forever. Railway can
      // keep an outbound request alive longer than the handler; enforce a deadline at
      // the worker boundary (7 min per scene — image gen up to 3 min + gpt-audio +
      // R2 uploads observed at ~5.5 min for still+narration; Sora polls up to ~5 min).
      // Scenes are generated with bounded parallelism (SCENE_CONCURRENCY) so a
      // 5-min/30–60-scene video never fires that many concurrent Sora/image/gpt-audio
      // calls at once (rate limits, cost spike, memory). Preserves the prior
      // all-settled semantics (fulfilled/rejected per scene) so rejection handling below
      // is unchanged.
      const outcomes = await mapLimit(scenes, SCENE_CONCURRENCY, async (scene: any) => {
        try {
          await withDeadline(this.processScene(scene, userId, voice, tone, heroSource), SCENE_DEADLINE_MS, `Scene ${scene.sceneNumber}`);
          return { status: 'fulfilled' as const };
        } catch (reason) {
          return { status: 'rejected' as const, reason };
        }
      });
      const rejected = outcomes.filter(o => o.status === 'rejected').length;
      if (rejected) {
        trace(`scene_queue_rejections project=${projectId} count=${rejected}`);
        // A timed-out provider call may still be in flight; persist a terminal state
        // now so polling can never report a permanently generating scene. Scope to
        // non-completed scenes only — never clobber a scene that already finished.
        await db.update(schema.videoScenes).set({
          status: 'failed',
          metadata: { error: 'Scene generation timed out after 7 minutes' },
          updatedAt: new Date(),
        }).where(and(
          eq(schema.videoScenes.projectId, projectId),
          or(
            eq(schema.videoScenes.status, 'generating'),
            eq(schema.videoScenes.status, 'pending'),
          ),
        ));
      }
    }
    const complete=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber));
    if (complete.some(s=>s.status!=='completed')) {
      const failedCount = complete.filter(s=>s.status==='failed').length;
      await db.update(schema.videoProjects).set({
        status:'failed',
        metadata: { failedSceneCount: failedCount, totalScenes: complete.length },
        updatedAt:new Date()
      }).where(eq(schema.videoProjects.id,projectId));
      return;
    }

    // Transition to assembling
    await db.update(schema.videoProjects).set({status:'assembling',updatedAt:new Date()}).where(eq(schema.videoProjects.id,projectId));
    trace(`assembling_start project=${projectId}`);

    try {
      const dir=path.join(process.cwd(),'temp','scene-projects',projectId); fs.mkdirSync(dir,{recursive:true});
      const clips:string[]=[];
      for (const scene of complete) {
        const local=String((scene.metadata as any)?.localPath||'');
        if(!local||!fs.existsSync(local)) { trace(`scene_missing_local project=${projectId} scene=${scene.sceneNumber}`); continue; }
        const clip=path.join(dir,`scene-${scene.sceneNumber}.mp4`); const audioLocal=String((scene.metadata as any)?.audioLocalPath||'');
        // Every scene is rendered through renderClip so the delivered clip is
        // exactly scene.duration seconds: stills loop to length, and motion clips
        // use `-stream_loop -1` to pad short Sora shots up to their target (the
        // copyFileSync shortcut below was removed because it shipped raw Sora clips
        // at their native short length — the root cause of ~35% duration under-delivery).
        // Ken Burns (slow zoompan) applies to EVERY still scene — Faceless by design and
        // Scene's gpt-image scenes (mirroring the owner-approved Faceless look). Motion
        // (Sora) scenes are NOT Ken Burns'ed — they carry real motion already.
        const sceneAudio = audioLocal && fs.existsSync(audioLocal) ? audioLocal : undefined;
        await renderClip(local,clip,scene.duration||3,sceneAudio,{kenburns:scene.visualType==='still'});
        clips.push(clip);
      }
      if (clips.length === 0) throw new Error('No scene clips available for assembly');
      const assembled=path.join(dir,'final.mp4'); trace(`ffmpeg_assembly_start project=${projectId} clips=${clips.length}`); await concatClips(clips,assembled); trace(`ffmpeg_assembly_end project=${projectId}`);
      // POST-RENDER SMOOTHNESS QC (deterministic ffprobe; NO AI / NO paid render).
      // Auto-flags choppy/silent/multi-audio renders BEFORE upload and surfaces the
      // report on the draft payload for the GPT-5.2 exception-handler router
      // (decision-only, no pixel/audio edits) to choose a deterministic fix from.
      let qc: Record<string, any> | undefined;
      try {
        qc = runRenderQC(assembled);
        trace(`render_qc project=${projectId} ok=${qc.ok} flags=${(qc.flags || []).join('|') || 'none'}`);
        if (!qc.ok) trace(`render_qc_warn project=${projectId} flags=${(qc.flags || []).join('|')}`);
      } catch (qcErr: any) { trace(`render_qc_error project=${projectId} err=${qcErr?.message}`); }
      let finalUrl=assembled;
      let primaryR2Key: string | undefined;
      if(r2Storage.isAvailable) {
        try { const uploaded=await r2Storage.uploadLocalFile(assembled,userId,'video-projects','video/mp4'); finalUrl=uploaded.url||assembled; primaryR2Key=uploaded.r2Key; }
        catch(r2Err:any) { trace(`r2_upload_failed project=${projectId} error=${r2Err.message}`); }
      }
      await db.update(schema.videoProjects).set({status:'completed',finalVideoUrl:finalUrl,updatedAt:new Date(),metadata:{sceneCount:complete.length,totalDuration:complete.reduce((a,s)=>a+(s.duration||0),0)}}).where(eq(schema.videoProjects.id,projectId)); trace(`project_complete project=${projectId}`);
      // ── Deliver to Operations page AS DRAFTS (owner auto-save change) ────
      //    Videos + variants do NOT auto-go to the Library. They land in Operations
      //    as draft approval rows; the client previews/downloads there and taps
      //    Save (POST /api/approval/save-to-library) which moves each into the
      //    Client Asset Library with the 90-day expiry starting at save time.
      //    We therefore write ONLY approvals here — never `creations`/Library rows.
      //    The approvals feed IS the Operations feed (GET /api/approval/pending)
      //    and each payload carries videoUrl + ratioLabel + shape so preview,
      //    download and save-to-library all work per variant.
      try {
        const projectRow = projectId;
        let projectTitle = 'Scene-Based Video';
        try {
          const [pRow] = await db.select({ title: schema.videoProjects.title }).from(schema.videoProjects).where(eq(schema.videoProjects.id, projectId));
          if (pRow?.title) projectTitle = pRow.title;
        } catch {}

        // Shared draft metadata: mode:'scene' marks these for the scene quota
        // (counted by distinct projectId — see usageService.getDailyRemaining),
        // saved:false flags them as not-yet-in-Library drafts.
        const draftBase = {
          projectId,
          mode: 'scene',
          provider: 'ffmpeg',
          saved: false,
          // QC report attached ONLY when present (10s max extra on local disk,
          // never blocks upload; owner-facing UI ignores it).
          ...(qc ? { qc } : {}),
        };

        // Primary 9:16 master — labelled "Vertical · TikTok" alongside variants.
        await db.insert(schema.approvals).values({
          id: uuidv4(),
          userId,
          type: 'video',
          status: 'completed', // generation done; still a draft until Saved
          payload: {
            assetId: uuidv4(),
            title: projectTitle,
            videoUrl: finalUrl,
            r2Key: primaryR2Key,
            platforms: [],
            status: 'completed',
            aspectRatio: '9:16',
            ratioLabel: 'AI Video (9:16 · TikTok/Reels/Shorts)',
            shape: 'vertical',
            ...draftBase,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        trace(`scene_draft_master project=${projectId}`);

        // ── Export variants (16:9, 1:1, 2:3): pure FFmpeg contain/pad refits from the
        //    assembled master — no AI calls, no crop. Each becomes its own draft
        //    approval row (NOT a creation/Library row) with a distinct ratio label.
        let variantResults: { variant: typeof VIDEO_EXPORT_VARIANTS[number]; fileUrl: string; r2Key?: string }[] = [];
        try {
          variantResults = await generateVideoExportVariants(assembled, userId, 'video-projects');
          trace(`export_variants_ok project=${projectId} count=${variantResults.length}`);
        } catch (varErr: any) {
          trace(`export_variants_failed project=${projectId} err=${varErr?.message}`);
        }
        for (const vr of variantResults) {
          try {
            await db.insert(schema.approvals).values({
              id: uuidv4(),
              userId,
              type: 'video',
              status: 'completed',
              payload: {
                assetId: uuidv4(),
                title: `${projectTitle} (${vr.variant.aspectRatio})`,
                videoUrl: vr.fileUrl,
                r2Key: vr.r2Key,
                platforms: [],
                status: 'completed',
                aspectRatio: vr.variant.aspectRatio,
                ratioLabel: vr.variant.label,
                shape: vr.variant.shape,
                ...draftBase,
              },
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            trace(`scene_draft_variant project=${projectId} ratio=${vr.variant.key}`);
          } catch (vApprErr: any) {
            trace(`scene_variant_draft_failed project=${projectId} err=${vApprErr?.message}`);
          }
        }
      } catch (libErr: any) {
        // Draft persistence must never fail the pipeline — log and continue.
        trace(`scene_draft_insert_failed project=${projectId} err=${libErr?.message}`);
      }
    } catch(assemblyErr:any) {
      trace(`assembly_failed project=${projectId} error=${assemblyErr.message}`);
      await db.update(schema.videoProjects).set({status:'failed',metadata:{error:`Assembly: ${assemblyErr.message}`,sceneCount:complete.length},updatedAt:new Date()}).where(eq(schema.videoProjects.id,projectId));
    }
  }
  async processScene(scene:any,userId:string,voice?: 'female'|'male',tone?: 'enthusiastic'|'calm'|'serious'|'warm'|'auto',sourceImage?: string):Promise<void> {
    trace(`scene_start id=${scene.id} number=${scene.sceneNumber}`); await db.update(schema.videoScenes).set({status:'generating',updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));
    try { let localPath:string; let mime='video/mp4';
      // Use the uploaded source image as the continuous subject. Where the provider
      // supports an input image we pass it; otherwise we inject the reference URL
      // strongly into the prompt so the subject is derived from it.
      const subjectPrompt = withSourceSubject(scene.visualPrompt, sourceImage && !isVideoUrl(sourceImage) ? sourceImage : undefined);
      if(scene.visualType==='still'){const result=await renderingEngine.renderImage(subjectPrompt, userId, sourceImage && !isVideoUrl(sourceImage) ? sourceImage : undefined); if(!result.success||!result.imageUrl)throw new Error(result.error||'GPT Image 2 failed'); localPath=result.imageUrl; mime='image/png';}
      else {
        // Motion scenes: Sora 2 flakes ~50% (status:failed ~55-90s in). Retry with backoff.
        let soraResult: { success: boolean; videoPath?: string; error?: string } | null = null;
        let retriesUsed = 0;
        for (let attempt = 1; attempt <= SCENE_SORA_MAX_ATTEMPTS; attempt++) {
          if (attempt > 1) {
            retriesUsed = attempt - 1;
            const backoffMs = SCENE_SORA_RETRY_BACKOFF_MS[attempt - 1] || 10_000;
            trace(`scene_sora_retry_${retriesUsed} id=${scene.id} attempt=${attempt}/${SCENE_SORA_MAX_ATTEMPTS} backoff=${backoffMs}ms`);
            await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
          }
          const sceneSeconds = Math.min(20, scene.duration || 20);
          const isImportant = Boolean(scene.metadata?.importantSora);
          soraResult = await soraVideoService.generateVideo(subjectPrompt, {
            userId: undefined,
            // ONE consolidated call for the important ~20s block. Length is set with
            // the OFFICIAL Sora 2 `seconds` enum (the live API rejects `duration` and
            // does not change length from prose). snapSoraSeconds picks the nearest
            // enum ≤ the scene target; FFmpeg -stream_loop -1 + -t in renderClip is a
            // safety net only (never the primary length mechanism). size is set
            // EXPLICITLY to SORA_SCENE_SIZE so the 9:16 contract is deterministic.
            seconds: isImportant ? snapSoraSeconds(sceneSeconds) : undefined,
            size: isImportant ? SORA_SCENE_SIZE : undefined,
            // secondary content-continuity steer only (cannot change clip length).
            promptHint: isImportant ? `Render ONE continuous ~${sceneSeconds}-second take of this important content — no cuts, no scene changes, one fluid motion sequence.` : undefined,
          });
          if (soraResult.success && soraResult.videoPath) break;
          trace(`scene_sora_attempt_failed id=${scene.id} attempt=${attempt} error=${soraResult.error || 'no video path'}`);
        }
        if (!soraResult?.success || !soraResult.videoPath) throw new Error(soraResult?.error || 'Sora 2 failed');
        localPath = soraResult.videoPath;
      }
      let audioUrl:string|undefined; let audioLocalPath:string|undefined; if(scene.narration) { try { const audio = await this.generateAudio(scene.narration,userId,scene.id,voice,tone); audioUrl = audio.url; audioLocalPath = audio.localPath; } catch(audioErr:any) { trace(`scene_audio_failed id=${scene.id} error=${audioErr.message}`); } }
      let assetUrl = localPath;
      if (r2Storage.isAvailable) { const copyPath = path.join(path.dirname(localPath), `${path.basename(localPath)}.r2-upload`); fs.copyFileSync(localPath, copyPath); const uploaded = await r2Storage.uploadLocalFile(copyPath, userId, 'video-scenes', mime); assetUrl = uploaded.url || localPath; }
      await db.update(schema.videoScenes).set({status:'completed',assetUrl,assetType:mime,audioUrl,metadata:{provider:scene.visualType==='still'?'gpt-image-2':'sora-2',localPath,audioLocalPath,narration:scene.narration,audioProvider:audioUrl?'gpt-audio':undefined},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id)); trace(`scene_complete id=${scene.id}`);
    } catch(error:any){trace(`scene_failed id=${scene.id} error=${error.message}`); await db.update(schema.videoScenes).set({status:'failed',metadata:{error:error.message},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));}
  }
  private async generateAudio(text:string,userId:string,sceneId:string,voice?: 'female'|'male',tone?: 'enthusiastic'|'calm'|'serious'|'warm'|'auto'):Promise<{url?:string;localPath:string}> {
    const key=process.env.OPENAI_API_KEY; const dir=path.join(process.cwd(),'temp','scene-audio'); fs.mkdirSync(dir,{recursive:true});
    if(!key) return {localPath:path.join(dir,`${sceneId}.mp3`)};
    const uploadAudio=async(lp:string,mime:string):Promise<string|undefined>=>{ if(!r2Storage.isAvailable) return undefined; try{ await fs.promises.copyFile(lp,`${lp}.r2-upload`); const up=await r2Storage.uploadLocalFile(`${lp}.r2-upload`,userId,'video-scenes/audio',mime); return up.url; }catch{ return undefined; } };
    // ---- Attempt 1: gpt-audio (owner's explicitly-enabled model) via Chat Completions ----
    // gpt-audio does NOT map to /v1/audio/speech (404 "Invalid URL"). It is an audio
    // chat model: POST /v1/chat/completions with modalities:['text','audio'] + audio:{voice,format}.
    // Returns message.audio.data as base64 WAV. Verified 200 in prod ownership checks.
    try {
      const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-audio',modalities:['text','audio'],audio:{voice:resolveVoice(voice,tone),format:'mp3'},messages:[{role:'user',content:text}]}),signal:AbortSignal.timeout(90000)});
      if(r.ok){ const j=await r.json(); const aud=j?.choices?.[0]?.message?.audio; if(aud&&aud.data){ const buf=Buffer.from(aud.data as string,'base64'); if(buf.length>0){ const lp=path.join(dir,`${sceneId}.mp3`); fs.writeFileSync(lp,buf); trace(`scene_audio_model_ok model=gpt-audio voice=${resolveVoice(voice,tone)} sceneId=${sceneId}`); const url=await uploadAudio(lp,'audio/mpeg'); return {url,localPath:lp}; } } trace(`scene_audio_model_failed model=gpt-audio status=no_audio sceneId=${sceneId}`); } else { trace(`scene_audio_model_failed model=gpt-audio status=${r.status} sceneId=${sceneId}`); }
    } catch(e:any){ trace(`scene_audio_gptaudio_err sceneId=${sceneId} err=${e?.message}`); }
    // ---- Attempt 2: classic TTS speech chain (/v1/audio/speech -> mp3) ----
    const localPath=path.join(dir,`${sceneId}.mp3`);
    const ttsModels=['gpt-4o-mini-tts','tts-1','tts-1-hd'];
    let response:Response|null=null; let lastStatus=0;
    for(const model of ttsModels){
      response=await fetch('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,voice:resolveVoice(voice,tone),input:text,response_format:'mp3'}),signal:AbortSignal.timeout(60000)});
      if(response.ok) break; lastStatus=response.status; trace(`scene_audio_model_failed model=${model} status=${response.status} sceneId=${sceneId}`);
    }
    if(!response||!response.ok) throw new Error(`GPT Audio ${lastStatus}`); fs.writeFileSync(localPath,Buffer.from(await response.arrayBuffer())); let url:string|undefined;
    if(r2Storage.isAvailable){const copyPath=`${localPath}.r2-upload`; fs.copyFileSync(localPath,copyPath); const up=await r2Storage.uploadLocalFile(copyPath,userId,'video-scenes/audio','audio/mpeg'); url=up.url;} return {url,localPath};
  }
  async getProject(projectId:string,userId:string) { const [project]=await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id,projectId)); if(!project||project.userId!==userId)return null; const scenes=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber)); const done=scenes.filter(s=>s.status==='completed').length; return {project,scenes,progress:scenes.length?Math.round(done/scenes.length*100):0}; }
  async regenerateScene(sceneId:string,userId:string) { const [scene]=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.id,sceneId)); if(!scene)return null; const project=await this.getProject(scene.projectId,userId); if(!project)return null; const pmeta=((project.project.metadata as any)||{}); await this.processScene(scene,userId,pmeta.voice,pmeta.tone); await this.processProject(scene.projectId,userId,true); return scene.projectId; }
  /**
   * Resume-on-boot recovery. If the Railway process restarts (deploy, crash, scale),
   * fire-and-forget scene work dies with it and projects can sit in `generating` /
   * `assembling` forever. On boot (and periodically) mark those as failed so the UI
   * always resolves to a terminal state. Cheap + deterministic — we don't try to
   * resume mid-flight work, since the provider requests were killed with the process.
   */
  async recoverStaleProjects(minAgeMs = 0): Promise<number> {
    // Boot run (minAgeMs=0): fail every generating/assembling project — the process
    // just restarted, so nothing can be actively working. Periodic tick (minAgeMs>0):
    // only age-fail GENERATING projects. An 'assembling' project is mid-way through a
    // single long, non-resumable FFmpeg/xfade render with no updatedAt bumps (a 5-min /
    // 30–60-clip assembly can legitimately exceed the tick grace) — killing it would
    // throw away the whole render. Boot-run still rescues a truly stranded assembler
    // after a restart, and assembly errors are caught by try/catch → status fails.
    const candidateStatuses = minAgeMs > 0
      ? ['generating']
      : ['generating', 'assembling'];
    const candidates = await db.select().from(schema.videoProjects).where(or(
      ...candidateStatuses.map((s) => eq(schema.videoProjects.status, s as any)),
    ));
    if (candidates.length === 0) return 0;
    let stale = candidates;
    if (minAgeMs > 0) {
      // Periodic tick: only fail projects that have been idle for the grace period.
      // A healthy pipeline bumps scene/project updatedAt as scenes start/complete, so
      // anything younger than the cutoff is actively being worked — never fail it
      // (observed false positive: still+narration scene legitimately runs ~5.5 min,
      // the 5-min tick killed it 9ms after scene_complete).
      const cutoff = new Date(Date.now() - minAgeMs);
      const fresh: typeof candidates = [];
      stale = [];
      for (const p of candidates) {
        const scenes = await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId, p.id));
        const lastActivity = scenes.reduce((max: Date, s: any) => (s.updatedAt > max ? s.updatedAt : max), p.updatedAt);
        if (lastActivity >= cutoff) fresh.push(p); else stale.push(p);
      }
      trace(`watchdog_aged candidates=${candidates.length} fresh=${fresh.length} stale=${stale.length}`);
    }
    if (stale.length === 0) return 0;
    const ids = stale.map((p: any) => p.id);
    await db.update(schema.videoProjects).set({
      status: 'failed',
      metadata: { error: 'Pipeline interrupted by service restart — regenerate this video', recoveredBy: 'resume-on-boot' },
      updatedAt: new Date(),
    }).where(inArray(schema.videoProjects.id, ids));
    // Also fail any scene still stuck in generating/pending so per-scene UI reflects it.
    await db.update(schema.videoScenes).set({
      status: 'failed',
      metadata: { error: 'Scene interrupted by service restart' },
      updatedAt: new Date(),
    }).where(and(
      inArray(schema.videoScenes.projectId, ids),
      or(
        eq(schema.videoScenes.status, 'generating'),
        eq(schema.videoScenes.status, 'pending'),
      ),
    ));
    trace(`recovered_stale_projects count=${stale.length} ids=${ids.map(i=>i.slice(0,8)).join(',')}`);
    return stale.length;
  }
  private watchdogStarted = false;
  /** Start the periodic stale-project watchdog (Railway-safe: setInterval, no long setTimeout).
   *  Boot run fails everything stranded (process just restarted — nothing can be actively
   *  working). Periodic ticks use an age grace so a healthy in-flight pipeline is never killed. */
  startWatchdog(intervalMs = 5 * 60 * 1000, staleGraceMs = 9 * 60 * 1000): void {
    if (this.watchdogStarted) return;
    this.watchdogStarted = true;
    // Run once immediately after boot, then on the interval.
    this.recoverStaleProjects().catch(e => trace(`watchdog_initial_failed error=${e.message}`));
    setInterval(() => {
      this.recoverStaleProjects(staleGraceMs).catch(e => trace(`watchdog_tick_failed error=${e.message}`));
    }, intervalMs);
    trace(`watchdog_started interval=${intervalMs}ms grace=${staleGraceMs}ms`);
  }
}
export const sceneVideoPipelineService = new SceneVideoPipelineService();
