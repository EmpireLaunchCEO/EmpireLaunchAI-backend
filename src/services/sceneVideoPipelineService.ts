import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import { eq, asc, and, inArray, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { soraVideoService, SORA_MOTION_SECONDS, SORA_SCENE_SIZE, soraCallBudget } from './soraVideoService.js';
import { renderingEngine } from './renderingEngine.js';
import { aiRouter } from './aiRouter.js';
import { r2Storage } from './r2StorageService.js';
import { generateVideoExportVariants, VIDEO_EXPORT_VARIANTS } from './videoExportVariants.js';
import { resolveVoice } from './voiceOptions.js';
export interface ConversationTurn { role: 'user' | 'assistant'; content: string }
export interface SceneScript { sceneNumber: number; duration: number; visualType: 'motion'|'still'; narration: string; visualPrompt: string; /** 0-based index of the paired soraContent block for this motion scene (multi-Sora hybrid, owner directive Sep 8); undefined for still scenes. */ soraBlock?: number; }
export interface VideoProjectInput { userId: string; title: string; idea: string; platforms?: string[]; style?: string; durationTarget?: number; script?: any; voice?: 'female' | 'male' | 'none'; tone?: 'enthusiastic' | 'calm' | 'serious' | 'warm' | 'auto'; mood?: string; sourceImages?: string[]; mode?: 'scene' | 'faceless'; conversation?: ConversationTurn[]; components?: string[]; }
/** NO-VOICEOVER MODE (owner directive): `voice:'none'` means the scene narration
 *  text is NEVER sent to GPT-Audio — no audioUrl, no narration track, and the
 *  final MP4 is silent by design (0 audio streams is OK for QC when voice==='none').
 *  Pure decision helper so the pipeline rule is unit-testable without mocks. */
export function shouldGenerateSceneNarration(narration?: string | null, voice?: string): boolean {
  return Boolean(narration) && voice !== 'none';
}
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
/** True when a string is an http(s) URL (vs a real local filesystem path). */
export function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(String(value || '').trim());
}
/**
 * Resolve a possibly-REMOTE (R2 presigned URL) asset reference to a REAL local
 * file on disk, so downstream consumers that need a file (fs.copyFileSync re-upload
 * branch, FFmpeg Ken Burns/zoompan renderClip, assembly) can never copy an https
 * URL. gpt-image-2 stills come back as an R2 presigned URL when R2 is live
 * (renderingEngine.renderImage uploads when passed a userId) — the owner's live
 * Scene test FAILED every still scene with `ENOENT: copyfile '<r2-url>' ->
 * '<r2-url>.r2-upload'` exactly because processScene set localPath to that URL.
 * Local paths pass through untouched (the common case after the renderImage call
 * below is switched to return a local path); URLs are downloaded to
 * temp/scene-assets. Pure + injectable fetch for unit tests (NO paid renders).
 */
export async function ensureLocalFile(
  pathOrUrl: string,
  label = 'asset',
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }> = fetch as any,
): Promise<string> {
  const value = String(pathOrUrl || '').trim();
  if (!value) throw new Error(`${label}: empty path/URL`);
  if (!isRemoteUrl(value)) return value; // already a real local file
  try { if (fs.existsSync(value)) return value; } catch { /* not a local path */ }
  const res = await fetchImpl(value, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${label}: download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`${label}: download returned an empty body`);
  let ext = '.png';
  try { ext = path.extname(new URL(value).pathname) || '.png'; } catch { /* keep .png */ }
  const dir = path.join(process.cwd(), 'temp', 'scene-assets');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${uuidv4()}${ext}`);
  fs.writeFileSync(dest, buf);
  return dest;
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
export function runRenderQC(media: string, opts?: { allowSilent?: boolean }): Record<string, any> {
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
    // audio-stream contract: EXACTLY ONE audio stream for a VOICED video. For a
    // voice:'none' (no-voiceover) project a SILENT final MP4 (0 audio streams) is
    // the designed output — never flagged broken (owner directive: no-voiceover
    // mode must produce a clean silent video). Multi-audio is ALWAYS a defect
    // (source/talent bleed) regardless of voice choice.
    const aList = execFileSync('ffprobe', [
      '-v','error','-select_streams','a','-show_entries','stream=codec_type','-of','csv=p=0', media,
    ], { maxBuffer: 1024 * 1024 }).toString().trim().split('\n').filter(Boolean);
    report.audioStreams = aList.length;
    const allowSilent = Boolean(opts?.allowSilent);
    if (aList.length > 1 || (aList.length === 0 && !allowSilent)) { report.ok = false; report.flags.push(aList.length === 0 ? 'no_audio' : 'multi_audio_streams'); }
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
        ...(keepMotion ? { soraBlock: 0 } : {}),
        narration: sceneCopyOrFallback(s?.narration, a.narration, a.duration, true),
        visualPrompt: sceneCopyOrFallback(s?.visualPrompt || s?.visual_prompt, a.visualPrompt, a.duration, false),
      };
    });
  }
  return arc;
}
/**
 * Pull the soraContent block prompts out of a raw planner payload: tolerates the
 * legacy single-OBJECT form (coerced to a 1-element array so no previously-valid
 * plan is rejected), filters empty prompts, and slices to the owner's duration-
 * scaled budget. Shared by parseScenePlan (prompt pairing) and the Scene MOTION
 * FLOOR so both see the identical, budget-capped block list.
 */
export function extractSoraBlockPrompts(raw: any, budget: number): string[] {
  const soraRaw = raw?.soraContent;
  const soraBlocks = Array.isArray(soraRaw) ? soraRaw : (soraRaw && typeof soraRaw === 'object' ? [soraRaw] : []);
  return (soraBlocks as any[])
    .filter((b: any) => b && typeof b === 'object' && String(b?.prompt || '').trim().length > 0)
    .map((b: any) => String(b.prompt))
    .slice(0, Math.max(0, budget));
}
/**
 * Parse the GPT 5.2 DIRECTOR output into the executable scene list.
 *
 * - FACELESS: legacy scene-script shape (scenes[] of {sceneNumber,duration,visualType,
 *   narration,visualPrompt}) → parseScenes() → stills forced downstream.
 * - SCENE (hybrid, owner-locked): the director emits a FULL-VIDEO PLAN with
 *   `soraContent` (MULTI-SORA HYBRID, owner directive Sep 8: an ARRAY of up to
 *   `soraCallBudget(duration)` {duration:20, prompt} blocks — each a 20s max single
 *   take; the legacy single-OBJECT form is tolerated and coerced to a 1-element
 *   array so no previously-valid plan is rejected) + `scenes[]` where the director
 *   types up to `budget` scenes "sora" (the motion-worthy beats: hero open, mid
 *   transformation, payoff/CTA) and the rest "gpt-image" stills that FFmpeg animates
 *   with Ken Burns (mirroring Faceless). We read the scene list with per-scene
 *   type→visualType mapping, pair the soraContent block prompts to the sora scenes
 *   IN ORDER (scene #i "sora" ↔ soraContent[i]), cap motion scenes to the budget
 *   (any extra "sora" typed scenes are coerced to stills — Sora spend never exceeds
 *   the owner's duration-scaled budget), and append each block's consolidated prompt
 *   to its scene's visualPrompt so processScene knows it's the call to make.
 *
 * If the planner returns the legacy shape (or nothing), we fall back to parseScenes()
 * so Scene still renders (motion scenes stay Sora per scene — degraded but functional).
 */
export function parseScenePlan(raw: any, idea: string, durationTarget: number, mode: 'faceless' | 'scene'): SceneScript[] {
  if (mode === 'faceless') {
    // FACELESS HARD-LOCK (owner decision Aug 30): Faceless NEVER consumes paid Sora
    // motion — every scene renders as a gpt-image-2 still animated by FFmpeg Ken
    // Burns. Force `still` at the parse layer (defense in depth: createProject also
    // forces stills after parsing, so the guarantee holds for ANY caller of the
    // parser, not just the Scene pipeline's own createProject path).
    return parseScenes(raw, idea, durationTarget).map(s => ({ ...s, visualType: 'still' as const, soraBlock: undefined }));
  }
  const scenesRaw = Array.isArray(raw) ? raw : (Array.isArray(raw?.scenes) ? raw.scenes : []);
  const budget = soraCallBudget(durationTarget);
  const usableBlocks = extractSoraBlockPrompts(raw, budget);
  const hasSoraTyped = scenesRaw.some((s: any) => String(s?.type || s?.sceneType || '').toLowerCase() === 'sora');
  if (usableBlocks.length > 0 && scenesRaw.length >= 2 && hasSoraTyped) {
    const totalPlan = scenesRaw.reduce((a: number, s: any) => a + (Number.isFinite(Number(s?.duration)) ? Number(s.duration) : 0), 0);
    const scale = totalPlan > 0 ? durationTarget / totalPlan : 1;
    const base = Math.floor(durationTarget / Math.max(1, scenesRaw.length));
    const rem = durationTarget - base * scenesRaw.length;
    // Which scene indices keep motion: the FIRST `budget` sora-typed scenes, in
    // video order (deterministic — extra GPT "sora" scenes beyond the budget are
    // coerced to gpt-image stills so Sora spend is always capped by duration).
    const soraSceneIndices = scenesRaw
      .map((s: any, i: number) => (String(s?.type || s?.sceneType || '').toLowerCase() === 'sora' ? i : -1))
      .filter((i: number) => i >= 0);
    const motionIndices = new Set(soraSceneIndices.slice(0, budget));
    let blockIdx = 0;
    const scenes: SceneScript[] = scenesRaw.map((s: any, i: number): SceneScript => {
      const isMotion = motionIndices.has(i);
      const dur = Math.round((Number.isFinite(Number(s?.duration)) ? Number(s.duration) : 0) * scale);
      const blockIdxAtScene = blockIdx;
      const blockPrompt = isMotion ? (usableBlocks[blockIdxAtScene] ?? '') : '';
      if (isMotion && blockPrompt) blockIdx++;
      return {
        sceneNumber: i + 1,
        duration: dur > 0 ? dur : base + (i < rem ? 1 : 0),
        visualType: isMotion ? 'motion' : 'still',
        ...(isMotion ? { soraBlock: blockIdxAtScene } : {}),
        narration: s?.narration || '',
        visualPrompt: isMotion && blockPrompt ? `${s.visualPrompt || ''} — ${blockPrompt}`.trim() : (s?.visualPrompt || s?.visual_prompt || ''),
      };
    });
    // Normalize the sum to exactly durationTarget (rounding drift).
    const drift = durationTarget - scenes.reduce((a, s) => a + s.duration, 0);
    if (scenes.length) scenes[scenes.length - 1].duration = Math.max(1, scenes[scenes.length - 1].duration + drift);
    return scenes;
  }
  return parseScenes(raw, idea, durationTarget);
}
/** Midsize words never used for the motion-floor keyword scoring (keep the score
 *  deterministic and meaningful — matching on "the/with/into" is noise). */
const FLOOR_STOPWORDS = new Set(['about','after','also','and','are','before','between','can','each','for','from','has','into','its','just','more','not','only','other','over','same','show','some','than','that','their','them','then','the','this','through','very','was','when','where','which','while','who','will','with','you','your']);
/**
 * SCENE MOTION FLOOR (owner directive — Scene-Based must NEVER render Sora-less):
 * the owner observed her test video "doesn't seem to be doing a 20s Sora call"
 * because the plan elected ZERO sora scenes (all visualType 'still', budget 1).
 * When a parsed SCENE plan has NO motion at all, deterministically promote the
 * most-important beat to ONE Sora 20s take (soraBlock=0) so every ≤30s Scene
 * video carries its budgeted Sora call (longer videos keep their scaled budget).
 * The promoted scene is the one whose text best overlaps soraContent[0]'s prompt
 * (keyword scoring, deterministic), falling back to the MIDDLE scene (the
 * transformation beat). The over-budget CAP is preserved — this only ever ADDS
 * motion when there is none and never exceeds `budget`. Faceless (zero-Sora
 * hard-lock) and Neural Twin never call this.
 */
export function applySceneMotionFloor(script: SceneScript[], soraBlocks: string[], budget: number): SceneScript[] {
  if (budget < 1 || !script.length) return script;
  if (script.some(s => s.visualType === 'motion')) return script;
  const next = script.map(s => ({ ...s }));
  const block = String(soraBlocks?.[0] || '');
  const blockPrompt = block.toLowerCase();
  const words = blockPrompt.split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length > 4 && !FLOOR_STOPWORDS.has(w));
  let best = -1;
  let bestHits = 0;
  if (words.length) {
    for (let i = 0; i < next.length; i++) {
      const hay = `${next[i].visualPrompt || ''} ${next[i].narration || ''}`.toLowerCase();
      const hits = words.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0);
      if (hits > bestHits) { bestHits = hits; best = i; }
    }
  }
  // No usable block prompt (or no overlap) → the middle scene (the transformation
  // beat) is the deterministic "hero" fallback.
  if (best < 0 || bestHits === 0) best = Math.floor(next.length / 2);
  const target = next[best];
  target.visualType = 'motion';
  target.soraBlock = 0;
  if (block && !`${target.visualPrompt || ''}`.toLowerCase().includes(blockPrompt.slice(0, 32))) {
    target.visualPrompt = `${target.visualPrompt || ''} — ${block}`.trim();
  }
  return next;
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
  // Empty or pure consultant/ui framing → the story-arc fallback (never narrate
  // internal planning dialogue). Everything else is REAL scene copy and MUST
  // survive into the delivered plan (owner: every relayed component must appear
  // in the video). A six-second scene can only carry a short complete line, so
  // OVER-LENGTH text is TRUNCATED at the word cap — NOT replaced by the generic
  // arc fallback. The old discard-on-length behavior silently dropped GPT's
  // component-bearing narration/prompts (the owner's live test stored pure
  // generic arc copy while metadata.componentsMissing listed every relayed
  // component: red, lavender, TikTok, 50% off, Comment, ...).
  if (!text || CONSULTANT_META_PATTERN.test(text)) return fallback;
  const maxWords = narration ? Math.max(14, Math.round(duration * 2.75)) : 90;
  if (text.split(/\s+/).length > maxWords) {
    return text.split(/\s+/).slice(0, maxWords).join(' ');
  }
  return text;
}
// ─── Planning-layer guarantee (owner directives, Sep 8) ─────────────────────
// A) every component the client relays in the conversation must appear in the
//    Scene-Based video; B) the ENTIRE story (hook → about → CTA) must fit
//    start-to-finish EXACTLY inside the chosen duration. These pure helpers
//    build the COMPONENTS INVENTORY + HARD TIME BUDGET for the planner prompt,
//    then QC the parsed plan deterministically (no paid renders) and drive ONE
//    auto-correct re-plan pass when something is missing.
export interface ComponentInventoryInput {
  components?: string[];
  cleanBrief: string;
  conversation?: ConversationTurn[];
}
export interface ArcFlags { hook: boolean; about: boolean; cta: boolean }
const INVENTORY_CAP = 14;               // bounded so the prompt stays focused
const COMPONENT_MAX_CHARS = 160;        // longest inventory item we emit
const COMPONENT_PREFER_MAX_CHARS = 100; // long chunks are cut at the last word ≤ this
const PLATFORM_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\btiktok\b/i, name: 'TikTok' },
  { re: /\binstagram\b/i, name: 'Instagram' },
  { re: /\byoutube\b/i, name: 'YouTube' },
  { re: /\bfacebook\b/i, name: 'Facebook' },
  { re: /\bpinterest\b/i, name: 'Pinterest' },
  { re: /\betsy\b/i, name: 'Etsy' },
  { re: /\bshopify\b/i, name: 'Shopify' },
  { re: /\bamazon\b/i, name: 'Amazon' },
  { re: /\bthreads\b/i, name: 'Threads' },
  { re: /\bsnapchat\b/i, name: 'Snapchat' },
  { re: /\breels?/i, name: 'Reels' },
  { re: /\bshorts\b/i, name: 'Shorts' },
];
const COLOR_WORDS = ['teal','magenta','pastel','neon','gold','silver','rose','navy','cream','beige','lavender','peach','coral','emerald','jade','burgundy','maroon','mustard','olive','charcoal','slate','ivory','blush','lilac','mint','sage','terracotta','cobalt','ruby','amber','turquoise','aqua','fuchsia','plum','indigo','violet','cyan','tangerine','apricot','sky blue','baby blue'];
const CTA_PATTERNS: RegExp[] = [
  /\bfollow\s+@?[a-z0-9_.]+/i,
  /\blink in bio\b/i,
  /\bsubscribe\b/i,
  /\bsave this\b/i,
  /\bshop now\b/i,
  /\bget yours\b/i,
  /\bact now\b/i,
  /\bdm us\b/i,
  /\bsend us a dm\b/i,
  /\bsign up\b/i,
  /\blearn more\b/i,
  /\bcomment\b(?: below)?/i,
];
const PRICE_RE = /\$\s?\d+(?:[.,]\d+)?/g;
const PCT_OFF_RE = /\b\d{1,3}\s?%\s?off\b/gi;
/** Normalize an inventory candidate for dedupe + comparison (fold curly quotes). */
function normalizeComponent(raw: string): string {
  return String(raw || '').replace(/\u2019/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim();
}
/** Deterministically split free text into short, concrete component chunks. */
function chunkText(text: string): string[] {
  const out: string[] = [];
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.replace(/\s+/g, ' ').trim();
    if (!s || s.length < 3) continue;
    if (s.length <= COMPONENT_MAX_CHARS) { out.push(s); continue; }
    // Long sentence → split on commas/semicolons into clauses; keep ≤ max.
    for (const clause of s.split(/\s*[,;]\s*/)) {
      const c = clause.trim();
      if (!c || c.length < 3) continue;
      if (c.length <= COMPONENT_MAX_CHARS) { out.push(c); continue; }
      const cut = c.slice(0, COMPONENT_PREFER_MAX_CHARS);
      const at = cut.lastIndexOf(' ');
      out.push(at > 20 ? cut.slice(0, at).trim() : cut.trim());
    }
  }
  return out;
}
/**
 * Deterministic extraction of every concrete relayed component from (a) the
 * client's explicit `components` list, (b) the clean creative brief, and (c) the
 * USER turns of the consultant conversation (assistant/consultant framing is
 * stripped). Recognizes platform names, colors, prices/offers and CTA wording as
 * canonical tokens; everything else is carried as short sentence/clause chunks.
 * Deduped case-insensitively, capped at INVENTORY_CAP, deterministic ordering.
 */
export function buildComponentInventory(input: ComponentInventoryInput): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const v = normalizeComponent(raw);
    if (!v || v.length < 3 || v.length > COMPONENT_MAX_CHARS) return;
    if (out.some(o => o.toLowerCase() === v.toLowerCase())) return;
    out.push(v);
  };
  // (a) Explicit components — highest priority, keep client's order.
  for (const c of input.components ?? []) push(c);
  // (b)+user text → canonical tokens (platform / color / price / CTA).
  const userText = (input.conversation ?? [])
    .filter(m => m?.role === 'user' && typeof m?.content === 'string')
    .map(m => m.content)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const combined = `${input.cleanBrief} ${userText}`;
  for (const p of PLATFORM_PATTERNS) if (p.re.test(combined)) push(p.name);
  for (const c of COLOR_WORDS) if (new RegExp(`\\b${c}\\b`, 'i').test(combined)) push(c);
  for (const m of combined.match(PRICE_RE) ?? []) push(m);
  for (const m of combined.match(PCT_OFF_RE) ?? []) push(m.charAt(0).toUpperCase() + m.slice(1).toLowerCase());
  for (const re of CTA_PATTERNS) { const m = combined.match(re); if (m && m[0]) push(m[0].charAt(0).toUpperCase() + m[0].slice(1)); }
  // (c) brief chunks, then user-turn chunks (carry the subject/concept itself).
  for (const c of chunkText(input.cleanBrief)) push(c);
  for (const c of chunkText(userText)) push(c);
  return out.slice(0, INVENTORY_CAP);
}
/** Every component must appear (case-insensitive substring) in ≥1 scene's text. */
export function verifyComponentsInScript(script: SceneScript[], components: string[]): { missing: string[] } {
  const haystack = script.map(s => `${s.visualPrompt || ''} ${s.narration || ''}`).join(' ').toLowerCase();
  const missing = (components ?? [])
    .map(normalizeComponent)
    .filter(c => c.length > 0 && !haystack.includes(c.toLowerCase()));
  return { missing };
}
/** Deterministic COMPONENT INJECTION backstop (owner: EVERY relayed component must
 *  appear in the video — never rely on GPT/replan compliance alone, and never let
 *  a wholesale parse-layer replacement strip it again). After parse + (at most one)
 *  replan, any STILL-missing inventory item is appended VERBATIM to a scene's
 *  visualPrompt so it renders on-screen: CTA wording → the FINAL scene, colors /
 *  platforms / offers → the MIDDLE (transformation) scene, subject chunks → the
 *  hook (scene 1). Pure + cheap (no GPT, no paid render); returns the injected
 *  list for audit + the re-verified missing list (empty on a successful pass). */
export function injectMissingComponents(script: SceneScript[], inventory: string[]): { script: SceneScript[]; injected: string[]; stillMissing: string[] } {
  const next = script.map(s => ({ ...s }));
  if (!inventory.length || !next.length) return { script: next, injected: [], stillMissing: verifyComponentsInScript(next, inventory).missing };
  const missing = verifyComponentsInScript(next, inventory).missing;
  if (!missing.length) return { script: next, injected: [], stillMissing: [] };
  const injected: string[] = [];
  const last = next.length - 1;
  const mid = Math.floor(next.length / 2);
  const isCtaish = (c: string) => {
    const t = normalizeComponent(c).toLowerCase();
    return CTA_PATTERNS.some(re => re.test(c)) || /follow|comment|subscribe|link in bio|shop now|order now|buy now|\bcta\b|call to action|check out|\bdm\b|sign up|join us|visit|tap|click|share|save this|learn more|get yours|act now|\bbeta\b/i.test(t);
  };
  const isColorish = (c: string) => COLOR_WORDS.includes(normalizeComponent(c).toLowerCase());
  const isPlatformish = (c: string) => PLATFORM_PATTERNS.some(p => p.name.toLowerCase() === normalizeComponent(c).toLowerCase());
  const isOfferish = (c: string) => /%\s*off|\$\s?\d/i.test(c);
  for (const c of missing) {
    let target: number;
    if (isCtaish(c)) target = last;
    else if (isColorish(c) || isPlatformish(c) || isOfferish(c)) target = mid === last ? Math.max(0, mid - 1) : mid;
    else target = 0;
    const s = next[target];
    s.visualPrompt = `${s.visualPrompt || ''}${s.visualPrompt ? ' — ' : ''}${c}`.trim();
    injected.push(c);
  }
  return { script: next, injected, stillMissing: verifyComponentsInScript(next, inventory).missing };
}
/** Structural story-arc check: hook in the first ~25% of scenes, 'what it's
 *  about' in the middle ~50%, CTA in the FINAL scene (deterministic heuristics). */
export function verifyArcCoverage(script: SceneScript[]): ArcFlags {
  if (!script.length) return { hook: false, about: false, cta: false };
  const count = script.length;
  const hookEnd = Math.max(1, Math.ceil(count * 0.25));
  const midEnd = Math.max(hookEnd + 1, Math.ceil(count * 0.75));
  const hookScenes = script.slice(0, hookEnd);
  const middleScenes = script.slice(hookEnd, midEnd);
  const last = script[count - 1];
  const textOf = (s: SceneScript) => `${s.visualPrompt || ''} ${s.narration || ''}`.toLowerCase();
  const mentions = (s: SceneScript, re: RegExp) => re.test(textOf(s));
  const HOOK_RE = /hook|open|intro|introduc|establish|first look|\bmeet\b|attention|grab|start|begin/i;
  const ABOUT_RE = /about|benefit|feature|essentials|\bkey\b|value|how it works|transformation|getting started|payoff|comes together|understand/i;
  const CTA_RE = /call to action|\bcta\b|follow|subscribe|link in bio|comment|share|save this|shop now|order|buy now|visit|click|tap|sign up|join|check out|\bdm\b|learn more|get yours|act now/i;
  const hook = hookScenes.some(s => mentions(s, HOOK_RE) && (s.visualPrompt || '').trim().length > 0);
  const about = middleScenes.some(s => mentions(s, ABOUT_RE) && (s.visualPrompt || '').trim().length > 0);
  const cta = !!last && mentions(last, CTA_RE) && ((last.visualPrompt || '').trim().length > 0 || (last.narration || '').trim().length > 0);
  return { hook, about, cta };
}
/** Rescale GPT's scene durations so the WHOLE video sums to EXACTLY target (the
 *  owner's hard time budget). Proportional + integer-round, then a deterministic
 *  greedy pass distributes any residual so total === target — never short, never
 *  over. Pure and unit-testable; handles GPT duration drift. */
export function normalizePlanTimeBudget(script: SceneScript[], targetDuration: number): SceneScript[] {
  if (!script.length) return [];
  const target = Math.max(1, Math.round(targetDuration));
  const sum = script.reduce((a, s) => a + (Number.isFinite(s.duration) ? s.duration : 0), 0);
  const scale = sum > 0 ? target / sum : 1;
  const scaled = script.map(s => ({ ...s, duration: Math.max(0, Math.round((Number.isFinite(s.duration) ? s.duration : 0) * scale)) }));
  // Greedy deterministic pass (last → first): add/remove 1s until total === target.
  let diff = target - scaled.reduce((a, s) => a + s.duration, 0);
  let guard = 0;
  while (diff !== 0 && guard < 10000) {
    guard++;
    let moved = false;
    for (let i = scaled.length - 1; i >= 0 && diff !== 0; i--) {
      if (diff > 0) { scaled[i].duration += 1; diff -= 1; moved = true; }
      else if (scaled[i].duration > 0) { scaled[i].duration -= 1; diff += 1; moved = true; }
    }
    if (!moved) break; // pathological only: target < scene count with every scene at 0
  }
  return scaled;
}
function runPlanQC(script: SceneScript[], inventory: string[]): { missingComponents: string[]; arcFlags: ArcFlags } {
  return { missingComponents: verifyComponentsInScript(script, inventory).missing, arcFlags: verifyArcCoverage(script) };
}
/** COMPONENTS INVENTORY section injected into the planner prompt. */
function buildPlannerComponentsSection(inventory: string[], voice?: 'female' | 'male' | 'none'): string {
  if (!inventory.length) return '';
  const list = inventory.map((c, i) => `${i + 1}. "${c}"`).join('\n');
  const narrationRule = voice === 'none'
    ? ' There is NO voiceover (silent video), so every component MUST appear in a scene\'s visualPrompt — the narration field will NOT be spoken.'
    : ' Every component MUST appear in at least one scene — in its visualPrompt or its narration.';
  return `\n\nCOMPONENTS INVENTORY (mandatory): these are the specific components the client/owner relayed in the conversation.${narrationRule} Distribute them across the scenes so the WHOLE video together includes ALL of them, and make sure the FINAL/CTA scene carries the relayed call-to-action wording (if the client gave one). Never invent or substitute components that contradict the brief — use exactly what the client said. The full conversation was also read to build this list — do not drop any item.\n${list}\n`;
}
/** HARD TIME BUDGET section injected into the planner prompt. */
function buildPlannerTimeBudgetSection(duration: number): string {
  return `\n\nHARD TIME BUDGET (mandatory): the ENTIRE video must complete start-to-finish inside EXACTLY ${duration} seconds — hook in the first ~25%, what the video is about in the middle ~50%, and the CTA in the final ~25%. All scene durations YOU return MUST sum to EXACTLY ${duration}s — do not plan scenes whose total exceeds ${duration}s or falls short of it.`;
}
/** One-shot auto-correct feedback appended to the planner prompt when the first
 *  plan missed components and/or story-arc stages (cheap GPT 5.2 decision-only). */
function buildReplanFeedback(missingComponents: string[], arcFlags: ArcFlags): string {
  const parts: string[] = [];
  if (missingComponents.length > 0) {
    parts.push(`MISSING RELAYED COMPONENTS — each of these MUST appear (verbatim, or clearly referencing the same thing) in at least one scene's visualPrompt or narration: ${missingComponents.map(c => `"${c}"`).join(', ')}.`);
  }
  if (!arcFlags.hook) parts.push('MISSING ARC STAGE — HOOK: the first ~25% of scenes must open with the hook / attention-grabber (wording like "opening", "introducing", establishing shot of the subject).');
  if (!arcFlags.about) parts.push('MISSING ARC STAGE — ABOUT: the middle ~50% must say what the video is about (the essentials / key benefit / how it works of the subject).');
  if (!arcFlags.cta) parts.push('MISSING ARC STAGE — CTA: the FINAL scene must deliver the call-to-action (wording like "follow", "link in bio", "shop now", "call to action").');
  if (!parts.length) return '';
  return `\n\nYOUR PREVIOUS PLAN FAILED THE PLANNING-QUALITY CHECK. Return a COMPLETE, corrected JSON plan in the exact same shape. Fix ALL of the following while keeping every correct scene you already planned:\n${parts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
}
/** Assemble the full planner request (brief + shape + arc + components + time
 *  budget + uniqueness). Factored out so the ONE re-plan pass reuses the exact
 *  same prompt with corrective feedback appended. */
function buildPlannerRequest(params: {
  cleanIdea: string; duration: number; sceneCount: number; perScene: number;
  constrain: string; toneHint: string; moodHint: string; srcHint: string;
  componentsSection: string; timeBudgetSection: string;
}): string {
  const { cleanIdea, duration, sceneCount, perScene, constrain, toneHint, moodHint, srcHint, componentsSection, timeBudgetSection } = params;
  return `Create a JSON scene script using ONLY this clean creative brief: ${cleanIdea}. Do not narrate consultant dialogue, planning notes, questions, UI instructions, or chat history. The final video is ${duration} seconds long, planned as exactly ${sceneCount} short scenes of about ${perScene} seconds each (total summing to ${duration}s).${constrain}${toneHint}${moodHint}${srcHint}\n\nSTORY ARC REQUIREMENT (mandatory)\n: because this is a longer video, the scenes MUST form a coherent multi-scene progression with ONE continuous subject (never random unrelated clips). Structure it as: the first ~25% establishes the hook/subject, the middle ~50% develops the subject and shows the transformation or key benefit, and the final ~25% delivers the payoff and a clear call-to-action. Each scene must ADVANCE the story from the previous one — do NOT repeat the opening scene multiple times. Keep the same subject, setting, and visual identity across every scene so the video feels continuous.${componentsSection}${timeBudgetSection}\n\nUNIQUENESS REQUIREMENT (mandatory): every scene's visualPrompt must describe a DIFFERENT moment, action, camera angle, or stage of the story that moves it forward — a unique scene-specific visual. It is NOT acceptable to give multiple scenes the same visual with only a change of "variant"/"angle"/"color"; if scenes 1-3 look the same, you have failed. Each of the ${sceneCount} visualPrompt and narration values must be distinct from the others.`;
}
export class SceneVideoPipelineService {
  async createProject(input: VideoProjectInput): Promise<string> {
    trace(`project_create_start user=${input.userId}`);
    const projectId = uuidv4();
    // The consultant UI may send its transcript as `idea`; isolate the actual
    // creative brief before it reaches the planner or fallback arc.
    const cleanIdea = normalizeVideoIdea(input.idea);
    // Planning-layer inventory (owner directives, Sep 8): every concrete component
    // the client relayed — explicit `components`, the clean brief, and the USER
    // turns of the consultant conversation — is extracted deterministically and
    // fed to the planner as a COMPONENTS INVENTORY (never invent components).
    const inventory = buildComponentInventory({ components: input.components, cleanBrief: cleanIdea, conversation: input.conversation });
    const mode = input.mode === 'faceless' ? 'faceless' : 'scene';
    // Clamp to the 3-min cap (defense in depth — the route also rejects > MAX).
    const rawDuration = input.durationTarget && Number.isFinite(input.durationTarget) ? input.durationTarget : 30;
    const duration = clamp(Math.round(rawDuration), 1, MAX_SCENE_DURATION);
    // Duration-scaled Sora call budget (owner directive, live Sep 8):
    // soraCallBudget(duration) = clamp(ceil(duration/30), 1, 3) — 30s→1, ~1min→2,
    // 2–3min→3. Sora is ONLY used where GPT explicitly elects motion (it names
    // WHICH 20s blocks deserve it); everything else renders as gpt-image-2 stills
    // animated with slow FFmpeg Ken Burns. Worst-case Sora spend ≈ $15/mo/client.
    const budget = soraCallBudget(duration);
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
        const importantBlock = Math.min(20, duration);
        const heroComponentHint = mode !== 'faceless' && inventory.length > 0
          ? ` soraContent[0]'s prompt MUST center the single most-important relayed component — "${inventory[0]}" — as the hero moment / key benefit / payoff of this video.`
          : '';
        // Hybrid Scene director (owner-locked): GPT 5.2 plans the WHOLE video up front —
        // which up-to-`budget` 20-second blocks genuinely need motion (each ONE Sora call,
        // a continuous 20s max single take), and the full scene list/order/timings.
        // Everything else renders as gpt-image-2 stills animated with slow FFmpeg Ken
        // Burns (mirroring Faceless). Sora is called per elected block, NEVER fragmented
        // into many 5-6s clips, and NEVER more than the `budget` calls.
        const hybridDirective = ` The final video is a HYBRID: Sora motion ONLY where you genuinely elect it — a duration-scaled budget of AT MOST ${budget} Sora call(s), each a ${importantBlock}s single take (continuous, no cuts, no scene changes). ALL other scenes are "gpt-image" stills (animated with slow Ken Burns pan/zoom). Return a JSON object with EXACTLY: a "soraContent" ARRAY of exactly ${budget} objects, each { duration: ${importantBlock}, prompt: ONE consolidated detailed prompt for that specific ${importantBlock}s block } — you decide WHICH ${importantBlock}s blocks are the motion-worthy beats (e.g. hero open, mid transformation, payoff/CTA) and list them in video order${heroComponentHint}, and
 a "scenes" array of exactly ${sceneCount} objects each { sceneNumber, duration (sum exactly ${duration}), type: "sora" | "gpt-image" (at most ${budget} type "sora" scenes — you decide how many genuinely need motion, each pairs in order with soraContent[i]; the rest are "gpt-image"), visualPrompt, narration (one complete natural sentence ≤ ${maxNarrationWords} words) }. Do NOT narrate consultant dialogue, planning notes, questions, UI instructions, or chat history. High quality, coherent single subject, distinct visuals per scene, story arc: hook → important sora beat(s) → payoff/CTA.
FEW-SHOT EXAMPLE (shape to return EXACTLY — do not copy the topic, only the structure): for a 60-second video with a 2-call budget this is the required JSON:
{"soraContent": [{"duration": 20, "prompt": "One continuous ~20s cinematic take of the hero moment showing the product's key benefit in action, no cuts, fluid motion."}, {"duration": 20, "prompt": "One continuous ~20s cinematic take of the payoff: the final result in motion, closing on the call to action, no cuts."}], "scenes": [{"sceneNumber": 1, "duration": 8, "type": "gpt-image", "visualPrompt": "Cinematic establishing shot of the subject, hook intro", "narration": "Opening: meet the subject."}, {"sceneNumber": 2, "duration": 20, "type": "sora", "visualPrompt": "The hero block — key benefit in action", "narration": "This is the moment it comes together."}, {"sceneNumber": 3, "duration": 7, "type": "gpt-image", "visualPrompt": "Medium shot continuing the benefit, same subject", "narration": "Watch how it keeps delivering."}, {"sceneNumber": 4, "duration": 7, "type": "gpt-image", "visualPrompt": "Wide shot of the transformation in progress", "narration": "The transformation is unmistakable."}, {"sceneNumber": 5, "duration": 8, "type": "sora", "visualPrompt": "The payoff block — final result, call to action", "narration": "This is the payoff you can get."}, {"sceneNumber": 6, "duration": 10, "type": "gpt-image", "visualPrompt": "Confident closing shot, call to action", "narration": "Ready to take the next step?"}]}
Your response must be ONLY that JSON object (no markdown fences, no commentary).`;
        const legacyConstrain = mode === 'faceless'
          ? ` Return a JSON object with a "scenes" array of ${sceneCount} objects, each with sceneNumber, duration (seconds, around ${perScene}), visualType ("motion" or "still"), narration, and visualPrompt.`
          : hybridDirective;
        const componentsSection = buildPlannerComponentsSection(inventory, input.voice);
        const timeBudgetSection = buildPlannerTimeBudgetSection(duration);
        const request = buildPlannerRequest({ cleanIdea, duration, sceneCount, perScene, constrain: legacyConstrain, toneHint, moodHint, srcHint, componentsSection, timeBudgetSection });
        const decision = await aiRouter.route({ userId: input.userId, request, mode: 'generate' });
        generatedScript = decision.script || decision.parameters?.script;
        // Planning-layer QC (deterministic, NO paid renders): every relayed component
        // must appear somewhere in the plan and the arc must cover hook → about → CTA.
        // If the first plan misses any of it, run ONE auto-correct re-plan pass that
        // emphasizes exactly what failed (cheap GPT 5.2 decision-only call, not a
        // media render, so this respects the paid-render QA policy).
        const firstPlan = parseScenePlan(generatedScript || {}, cleanIdea, duration, mode);
        const firstQc = runPlanQC(firstPlan, inventory);
        const needsReplan = firstQc.missingComponents.length > 0 || !firstQc.arcFlags.hook || !firstQc.arcFlags.about || !firstQc.arcFlags.cta;
        if (needsReplan) {
          trace(`gpt52_replan_start project=${projectId} missing=[${firstQc.missingComponents.join(' | ')}] arc=${JSON.stringify(firstQc.arcFlags)}`);
          const replan = await aiRouter.route({ userId: input.userId, request: request + buildReplanFeedback(firstQc.missingComponents, firstQc.arcFlags), mode: 'generate' });
          generatedScript = replan.script || replan.parameters?.script;
          trace(`gpt52_replan_end project=${projectId} replanned=${!!generatedScript}`);
        }
        trace(`gpt52_script_end project=${projectId} generated=${!!generatedScript}`);
      } catch (error: any) { trace(`gpt52_script_failed project=${projectId} error=${error.message}`); }
    }
    const scriptBeforeFloor = parseScenePlan(generatedScript || {}, cleanIdea, duration, mode);
    // FACELESS-ONLY: force every scene down the still path (gpt-image-2 + FFmpeg Ken
    // Burns/zoompan) regardless of what the GPT planner returned, so Faceless never
    // consumes paid Sora motion calls. Scene-Based and Neural Twin are unaffected.
    if (mode === 'faceless') { for (const s of scriptBeforeFloor) { s.visualType = 'still'; } }
    // SCENE MOTION FLOOR (owner directive — blocked her live test): a Scene plan
    // that elected ZERO sora scenes renders Sora-less. Deterministically promote
    // the most-important beat to ONE 20s Sora take (soraBlock=0) so every ≤30s
    // Scene video carries its budgeted call. Never exceeds the budget; Faceless
    // (zero-Sora hard-lock) skips this by mode.
    const script = mode === 'scene'
      ? applySceneMotionFloor(scriptBeforeFloor, extractSoraBlockPrompts(generatedScript || {}, budget), budget)
      : scriptBeforeFloor;
    // HARD TIME BUDGET (owner directive): rescale scene durations so the ENTIRE video
    // completes start-to-finish inside EXACTLY `duration` — hook → about → CTA is never
    // cut short or overrun (deterministic; handles any GPT duration drift).
    const planned = normalizePlanTimeBudget(script, duration);
    // Final auditable QC of the plan we actually persist (components → componentsVerified
    // / componentsMissing, arc → arcFlags). Never blocks; missing items are recorded so
    // the owner can audit that every relayed component was planned in.
    let qc = runPlanQC(planned, inventory);
    // COMPONENT INJECTION BACKSTOP (owner: every relayed component MUST actually flow
    // into the delivered plan — GPT (and even the one auto-correct replan) is not
    // guaranteed to comply, and the old parse layer could strip long component-bearing
    // copy). When components are still missing after parse + replan, append them
    // VERBATIM to scene visualPrompts (CTA→final, colors/platforms/offers→middle,
    // subject chunks→hook). Deterministic, zero paid renders.
    const injected: string[] = [];
    if (qc.missingComponents.length > 0) {
      const inj = injectMissingComponents(planned, inventory);
      const afterInjection = inj.script;
      injected.push(...inj.injected);
      qc = runPlanQC(afterInjection, inventory);
      trace(`components_injected project=${projectId} count=${inj.injected.length} stillMissing=[${inj.stillMissing.join(' | ')}]`);
      // Durations are untouched by injection (text only) — the exact time budget holds.
      planned.splice(0, planned.length, ...afterInjection);
    }
    await db.insert(schema.videoProjects).values({id:projectId,userId:input.userId,title:input.title||input.idea.slice(0,80),status:'generating',totalDuration:planned.reduce((a,s)=>a+s.duration,0),sceneCount:planned.length,script:planned,metadata:{platforms:input.platforms||[],style:input.style||'',voice:input.voice||'',tone:input.tone||'',sourceImages:input.sourceImages||[],mode,soraCallBudget:budget,plan:{scenes:planned,soraCallBudget:budget},conversation:input.conversation||[],components:inventory,componentsVerified:qc.missingComponents.length===0,componentsMissing:qc.missingComponents,componentsInjected:injected,arcFlags:qc.arcFlags}});
    await db.insert(schema.videoScenes).values(planned.map(s=>({id:uuidv4(),projectId,sceneNumber:s.sceneNumber,duration:s.duration,visualType:s.visualType,narration:s.narration,visualPrompt:s.visualPrompt,status:'pending',metadata:{importantSora:s.visualType==='motion',...(s.soraBlock !== undefined ? { soraBlock: s.soraBlock } : {})}})));
    trace(`project_created id=${projectId} scenes=${planned.length}`);
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
    const voice = pmeta.voice as 'female' | 'male' | 'none' | undefined;
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
        qc = runRenderQC(assembled, { allowSilent: voice === 'none' });
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
  async processScene(scene:any,userId:string,voice?: 'female'|'male'|'none',tone?: 'enthusiastic'|'calm'|'serious'|'warm'|'auto',sourceImage?: string):Promise<void> {
    trace(`scene_start id=${scene.id} number=${scene.sceneNumber}`); await db.update(schema.videoScenes).set({status:'generating',updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));
    try { let localPath:string; let mime='video/mp4';
      // Use the uploaded source image as the continuous subject. Where the provider
      // supports an input image we pass it; otherwise we inject the reference URL
      // strongly into the prompt so the subject is derived from it.
      const subjectPrompt = withSourceSubject(scene.visualPrompt, sourceImage && !isVideoUrl(sourceImage) ? sourceImage : undefined);
      if(scene.visualType==='still'){
        // ENOENT BLOCKER FIX (owner's live test f3773f0a — all 5 scenes failed):
        // renderImage with NO userId returns a LOCAL path (no premature R2 upload)
        // so the r2-upload copy branch below and FFmpeg Ken Burns/zoompan assembly
        // receive a REAL on-disk file. The old call passed userId, which made
        // renderImage upload to R2 and return a PRESIGNED URL as `localPath` →
        // `fs.copyFileSync('<url>', '<url>.r2-upload')` threw ENOENT. The scene
        // upload branch uploads exactly once (provider 'gpt-image-2'). ensureLocalFile
        // is a defense-in-depth guard for any caller path that still lands a URL.
        const result = await renderingEngine.renderImage(subjectPrompt, undefined, sourceImage && !isVideoUrl(sourceImage) ? sourceImage : undefined);
        if(!result.success||!result.imageUrl)throw new Error(result.error||'GPT Image 2 failed');
        localPath = await ensureLocalFile(result.imageUrl, `still image scene ${scene.sceneNumber}`);
        mime='image/png';
      }
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
            // 20s MAX SINGLE-TAKE POLICY (owner directive, live): EVERY motion scene
            // requests the Sora 2 `seconds` MAX ("20" — enum 4|8|12|16|20; the live
            // API rejects `duration` and does not change length from prose). Never a
            // shorter snapped value: scenes become continuous single takes, and
            // renderClip trims with `-t` to the scene window, so a 20s shot into a
            // shorter scene yields smooth continuous motion — NO loop-padding, no
            // repeat, no transition judder. size is set EXPLICITLY to SORA_SCENE_SIZE
            // so the 9:16 contract is deterministic.
            seconds: SORA_MOTION_SECONDS,
            size: isImportant ? SORA_SCENE_SIZE : undefined,
            // secondary content-continuity steer only (cannot change clip length).
            promptHint: isImportant ? `Render ONE continuous 20-second single take of this important content — no cuts, no scene changes, one fluid motion sequence. FFmpeg will trim it to this scene's ~${sceneSeconds}s window.` : undefined,
          });
          if (soraResult.success && soraResult.videoPath) break;
          trace(`scene_sora_attempt_failed id=${scene.id} attempt=${attempt} error=${soraResult.error || 'no video path'}`);
        }
        if (!soraResult?.success || !soraResult.videoPath) throw new Error(soraResult?.error || 'Sora 2 failed');
        localPath = soraResult.videoPath;
      }
      let audioUrl:string|undefined; let audioLocalPath:string|undefined; if(shouldGenerateSceneNarration(scene.narration, voice)) { try { const audio = await this.generateAudio(scene.narration,userId,scene.id,voice,tone); audioUrl = audio.url; audioLocalPath = audio.localPath; } catch(audioErr:any) { trace(`scene_audio_failed id=${scene.id} error=${audioErr.message}`); } }
      let assetUrl = localPath;
      if (r2Storage.isAvailable) {
        // HARDENING: never let a URL reach fs.copyFileSync (the owner's live ENOENT).
        // ensureLocalFile is a no-op passthrough for real local paths (the normal
        // case after the renderImage fix) and downloads any stray URL first.
        const safeLocal = await ensureLocalFile(localPath, `scene ${scene.sceneNumber} visual`);
        const copyPath = path.join(path.dirname(safeLocal), `${path.basename(safeLocal)}.r2-upload`);
        fs.copyFileSync(safeLocal, copyPath);
        const uploaded = await r2Storage.uploadLocalFile(copyPath, userId, 'video-scenes', mime);
        assetUrl = uploaded.url || safeLocal;
      }
      await db.update(schema.videoScenes).set({status:'completed',assetUrl,assetType:mime,audioUrl,metadata:{provider:scene.visualType==='still'?'gpt-image-2':'sora-2',localPath,audioLocalPath,narration:scene.narration,audioProvider:audioUrl?'gpt-audio':undefined},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id)); trace(`scene_complete id=${scene.id}`);
    } catch(error:any){trace(`scene_failed id=${scene.id} error=${error.message}`); await db.update(schema.videoScenes).set({status:'failed',metadata:{error:error.message},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));}
  }
  /**
   * Regenerate ONE scene's narration audio via GPT-Audio (or TTS fallback) in the
   * SAME voice the project used (project.metadata.voice/tone → resolveVoice).
   * Exposed standalone (no instance state) so the LINE_CHANGE auto-fix loop
   * (neuralFeedbackAutoFixService) can re-voice an edited line in place without a
   * full scene re-render. $0-ish: ONE gpt-audio call (~micro-cost per line).
   */
  private async generateAudio(text:string,userId:string,sceneId:string,voice?: 'female'|'male'|'none',tone?: 'enthusiastic'|'calm'|'serious'|'warm'|'auto'):Promise<{url?:string;localPath:string}> {
    return generateSceneAudio(text, userId, sceneId, voice, tone);
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

/**
 * Generate (or regenerate) ONE scene narration audio file in the project's SAME
 * voice/tone (project.metadata.voice/tone → resolveVoice → same OpenAI voice id),
 * via GPT-Audio first then the classic TTS chain. Standalone and instance-free so
 * the LINE_CHANGE auto-fix can re-voice an edited line without a full re-render.
 * Returns the R2 upload URL (if R2 configured) + the local file path.
 */
export async function generateSceneAudio(
  text: string,
  userId: string,
  sceneId: string,
  voice?: 'female' | 'male' | 'none',
  tone?: 'enthusiastic' | 'calm' | 'serious' | 'warm' | 'auto',
): Promise<{ url?: string; localPath: string }> {
  // voice:'none' is the NO-voiceover sentinel. The caller never reaches here with
  // it (processScene guards with shouldGenerateSceneNarration), but normalize so
  // resolveVoice (typed 'female'|'male'|undefined) accepts the widened union.
  const g = voice === 'none' ? undefined : voice;
  const key = process.env.OPENAI_API_KEY;
  const dir = path.join(process.cwd(), 'temp', 'scene-audio');
  fs.mkdirSync(dir, { recursive: true });
  if (!key) return { localPath: path.join(dir, `${sceneId}.mp3`) };
  const uploadAudio = async (lp: string, mime: string): Promise<string | undefined> => {
    if (!r2Storage.isAvailable) return undefined;
    try {
      await fs.promises.copyFile(lp, `${lp}.r2-upload`);
      const up = await r2Storage.uploadLocalFile(`${lp}.r2-upload`, userId, 'video-scenes/audio', mime);
      return up.url;
    } catch {
      return undefined;
    }
  };
  // ---- Attempt 1: gpt-audio (owner's explicitly-enabled model) via Chat Completions ----
  // gpt-audio does NOT map to /v1/audio/speech (404 "Invalid URL"). It is an audio
  // chat model: POST /v1/chat/completions with modalities:['text','audio'] + audio:{voice,format}.
  // Returns message.audio.data as base64 WAV. Verified 200 in prod ownership checks.
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-audio', modalities: ['text', 'audio'],
        audio: { voice: resolveVoice(g, tone), format: 'mp3' },
        messages: [{ role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (r.ok) {
      const j = await r.json();
      const aud = j?.choices?.[0]?.message?.audio;
      if (aud && aud.data) {
        const buf = Buffer.from(aud.data as string, 'base64');
        if (buf.length > 0) {
          const lp = path.join(dir, `${sceneId}.mp3`);
          fs.writeFileSync(lp, buf);
          trace(`scene_audio_model_ok model=gpt-audio voice=${resolveVoice(g, tone)} sceneId=${sceneId}`);
          const url = await uploadAudio(lp, 'audio/mpeg');
          return { url, localPath: lp };
        }
      }
      trace(`scene_audio_model_failed model=gpt-audio status=no_audio sceneId=${sceneId}`);
    } else {
      trace(`scene_audio_model_failed model=gpt-audio status=${r.status} sceneId=${sceneId}`);
    }
  } catch (e: any) {
    trace(`scene_audio_gptaudio_err sceneId=${sceneId} err=${e?.message}`);
  }
  // ---- Attempt 2: classic TTS speech chain (/v1/audio/speech -> mp3) ----
  const localPath = path.join(dir, `${sceneId}.mp3`);
  const ttsModels = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
  let response: Response | null = null;
  let lastStatus = 0;
  for (const model of ttsModels) {
    response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice: resolveVoice(g, tone), input: text, response_format: 'mp3' }),
      signal: AbortSignal.timeout(60000),
    });
    if (response.ok) break;
    lastStatus = response.status;
    trace(`scene_audio_model_failed model=${model} status=${response.status} sceneId=${sceneId}`);
  }
  if (!response || !response.ok) throw new Error(`GPT Audio ${lastStatus}`);
  fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
  let url: string | undefined;
  if (r2Storage.isAvailable) {
    const copyPath = `${localPath}.r2-upload`;
    fs.copyFileSync(localPath, copyPath);
    const up = await r2Storage.uploadLocalFile(copyPath, userId, 'video-scenes/audio', 'audio/mpeg');
    url = up.url;
  }
  return { url, localPath };
}
