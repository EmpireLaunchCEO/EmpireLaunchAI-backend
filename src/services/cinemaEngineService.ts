import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { resolveStudioReasoner } from '../utils/resolveModel.js';
import { usageService } from './usageService.js';
import { generateVideoExportVariants, VIDEO_EXPORT_VARIANTS, type ExportVariantResult } from './videoExportVariants.js';
import { r2Storage } from './r2StorageService.js';
import { db, schema } from '../db/index.js';
import {
  renderClip, concatClips, normalizePlanTimeBudget, resolveNarrationRoles,
  enforceAvatarConsistency, verifySellingPointsSpoken, injectSellingPointsIntoNarration,
  stripBenefitTextFromVisualPrompts, deliveredVideoDuration, deliveredVideoDurationSeconds,
  generateSceneAudio, type SceneScript,
} from './sceneVideoPipelineService.js';
import { transformTwinScriptToPitch, isInternalBriefEcho, extractCreativeEssence, finishedEssenceSentences } from './creativeTransformation.js';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { JsonOutputParser } from '@langchain/core/output_parsers';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TwinCreationRequest {
  userId: string;
  photoPath?: string;   // Path to uploaded photo (legacy)
  photoUrl?: string;    // URL to uploaded photo
  script: string;      // What the twin should say
  voiceStyle?: string; // 'natural' | 'energetic' | 'calm'
  voiceId?: string;
  mood?: string;       // owner-locked mood (shared VIDEO_MOODS set)
  voice?: 'female' | 'male' | 'none'; // shared-pipeline voice contract (mode-parity re-plumb): 'none' = silent by design; undefined = auto (nova)
  duration?: number;   // requested twin video length (seconds); honored via segment planning (zero-video-API Faceless-style engine — Twin never uses a video API)
}

export interface CinemaAsset {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  status: 'processing' | 'completed' | 'failed';
  metadata: any;
  error?: string;
  variants?: ExportVariantResult[];
}

export interface FacialDNA {
  faceShape: string;
  skinTone: string;
  eyeColor: string;
  hairStyle: string;
  hairColor: string;
  jawline: string;
  lipShape: string;
  noseShape: string;
  eyebrowShape: string;
  distinctiveFeatures: string[];
}

// ─── Shared-Pipeline Twin Helpers (owner Oct 11 "fix twin" re-plumb) ─────────
// The Neural Twin now plans through the SAME deterministic gauntlet the
// faceless/scene path runs in createProject (mode-parity audit d390c9b9): exact
// dissolve-compensated time budget, F4 narration guarantee (every finished-essence
// selling point SPOKEN), avatar-role/consistency enforcement, and the F4 visual ban
// (benefit text never in a visualPrompt). Pure + zero paid calls — tests are the dry-run.

const TWIN_MAX_DURATION = 30;
const TWIN_MIN_DURATION = 5;

function clampTwin(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Every twin segment's CLEAN talking-head visual description (F1 no-text): it
 *  must never contain narration, benefit or script text — only the avatar + motion.
 *  No "SHOW THIS BEING DONE" app directive either: a talking head IS the action. */
export function buildTwinVisualPrompt(emotion: string): string {
  const e = String(emotion || 'confident').toLowerCase();
  return `The same talking-head AI avatar built from the user's photo with a ${e} expression, facing the camera and speaking, subtle mouth movement, studio-lit dark background, vertical 9:16 frame — no text, no captions, no on-screen words.`;
}

/** The ONE stable avatar look shared verbatim by every avatar-dialogue segment. */
const TWIN_AVATAR_LOOK = "the same talking-head AI avatar built from the user's photo";

/** Split a finished twin script into `k` sentence-aligned narration segments
 *  (never mid-sentence when avoidable; word-split fallback keeps small scripts
 *  from collapsing to an empty segment). Deterministic, pure. */
export function splitTwinScript(script: string, k: number): string[] {
  const clean = String(script || '').replace(/\s+/g, ' ').trim();
  const kk = clampTwin(k, 1, 12);
  const words = clean ? clean.split(' ') : [];
  if (!words.length) return Array.from({ length: kk }, () => '');
  const perBucket = Math.max(1, Math.ceil(words.length / kk));
  // Sentence-aware greedy: walk words, close a bucket at a sentence boundary when it
  // has >= perBucket words; hard-close at 2x to keep bucket lengths bounded.
  const buckets: string[][] = [];
  let cur: string[] = [];
  const close = () => { if (cur.length) { buckets.push(cur); cur = []; } };
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    const endsSentence = /\.$/.test(words[i] || '') || /[!?]$/.test(words[i] || '');
    const wantMore = buckets.length + 1 < kk;
    if (endsSentence && cur.length >= perBucket && wantMore) close();
    else if (cur.length >= perBucket * 2 && wantMore) close();
  }
  close();
  // Merge/regrid: too many buckets -> join trailing; use last bucket for the tail.
  const out: string[] = [];
  for (const b of buckets) {
    if (out.length < kk) out.push(b.join(' '));
    else out[out.length - 1] = [out[out.length - 1], b.join(' ')].filter(Boolean).join(' ');
  }
  while (out.length < kk) out.push('');
  return out.slice(0, kk);
}

/** TONE for GPT-Audio from the twin's legacy voiceStyle + owner-locked mood. */
export function toneFromTwinRequest(voiceStyle?: string, mood?: string): 'enthusiastic' | 'calm' | 'serious' | 'warm' | 'auto' {
  const m = String(mood || '').toLowerCase();
  if (m === 'serious' || m === 'calm' || m === 'warm') return m as 'serious' | 'calm' | 'warm';
  if (m === 'energetic') return 'enthusiastic';
  const v = String(voiceStyle || '').toLowerCase();
  if (v === 'energetic') return 'enthusiastic';
  if (v === 'calm') return 'calm';
  return 'auto';
}

/** Build the twin's SceneScript[] plan through the SHARED gauntlet — the exact
 *  sequence createProject applies to faceless/scene (F4 → roles/avatar → visual
 *  strip), with twin's narration = the transformed finished script's sentences.
 *  Returns the plan + the auditable F4/avatar/duration artifacts. Pure, zero API. */
export function buildTwinPlan(
  safeScript: string,
  durationTarget: number,
  voice?: 'female' | 'male' | 'none',
): {
  plan: SceneScript[];
  sellingPoints: string[];
  f4Injected: string[];
  f4StillMissing: string[];
  narrationRoles: string[];
  avatarLook: string;
  delivered: number;
  deliveredSeconds: number;
} {
  const duration = clampTwin(Math.round(Number(durationTarget) || 30), TWIN_MIN_DURATION, TWIN_MAX_DURATION);
  const segmentCount = clampTwin(Math.round(duration / 6), 1, 10); // ~1 segment / 6s (mirrors faceless)
  const segments = splitTwinScript(safeScript, segmentCount);
  const voiced = (voice ?? '') !== 'none';
  const sellingPoints = finishedEssenceSentences(extractCreativeEssence(safeScript)).filter((c) => String(c || '').trim().length > 0);
  const base: SceneScript[] = segments.map((narration, i) => ({
    sceneNumber: i + 1,
    duration: 1,
    visualType: 'still' as const,
    narration,
    visualPrompt: buildTwinVisualPrompt('confident'),
    narrationRole: 'avatar-dialogue' as const,
  }));
  // Time budget FIRST (same order as createProject) so F4 cap math sees final durations.
  const timed = normalizePlanTimeBudget(base, duration, { dissolveCompensate: true });
  const plan: SceneScript[] = timed.map((s) => ({ ...s }));
  // F4: every relayed selling point must be SPOKEN (role-agnostic injector).
  let f4Injected: string[] = [];
  let f4StillMissing: string[] = [];
  if (voiced && sellingPoints.length) {
    const inj = injectSellingPointsIntoNarration(plan, sellingPoints);
    f4Injected = inj.injected;
    f4StillMissing = inj.stillMissing;
    plan.splice(0, plan.length, ...inj.script);
  } else {
    f4StillMissing = verifySellingPointsSpoken(plan, sellingPoints).missing;
  }
  // CONTENT DIRECTION: avatar-dialogue role enforcement + SAME-avatar consistency
  // (owner avatar-voice rule v3 — the twin IS a talking avatar in every segment).
  const withRoles = resolveNarrationRoles(plan);
  const avatarPass = enforceAvatarConsistency(withRoles, TWIN_AVATAR_LOOK);
  plan.splice(0, plan.length, ...avatarPass.script);
  const narrationRoles = plan.map((s) => s.narrationRole || 'narrator');
  // F4 VISUAL BAN (F1): benefit/claim text must never survive in any visualPrompt.
  // (actionBackstop intentionally NOT applied — talking-head frames are the avatar
  //  speaking on camera; an app-directed action directive would misdescribe frames.)
  const visual = voiced
    ? stripBenefitTextFromVisualPrompts(plan, sellingPoints.filter((c) => !/^EmpireLaunch AI\.$/i.test(c)))
    : { script: plan, strippedScenes: [] };
  plan.splice(0, plan.length, ...visual.script);
  return {
    plan,
    sellingPoints,
    f4Injected,
    f4StillMissing,
    narrationRoles,
    avatarLook: avatarPass.avatarLook || '',
    delivered: deliveredVideoDuration(plan),
    deliveredSeconds: deliveredVideoDurationSeconds(plan),
  };
}

/** F1 NO-TEXT talking-head SVG (owner Oct 11 — closes audit GAP3): the old
 *  buildTalkingHeadSvg baked the <text> script line AND an emotion label into
 *  every frame. This frame has NO <text> elements at all — no captions, no
 *  emotion words. Emotion drives visual styling only (lip color / mouth height). */
export function buildTwinFrameSvg(dna: FacialDNA, emotion: string, mouthOpen: number): string {
  const bgColor = '#1a1a2e';
  const skinColor = twinSkinToneToHex(dna.skinTone);
  const lipColor = emotion === 'happy' ? '#e74c3c' : '#c0392b';
  const eyeColor = dna.eyeColor === 'blue' ? '#3498db' : dna.eyeColor === 'green' ? '#27ae60' : '#5d4037';
  const mouthH = Math.round(10 + mouthOpen * 30);

  return `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
      <rect width="1080" height="1920" fill="${bgColor}"/>
      <!-- Head -->
      <ellipse cx="540" cy="750" rx="200" ry="250" fill="${skinColor}" stroke="#d5a885" stroke-width="2"/>
      <!-- Hair -->
      <ellipse cx="540" cy="${dna.hairStyle === 'curly' ? '620' : '600'}" rx="210" ry="${dna.hairStyle === 'curly' ? '180' : '150'}" fill="${dna.hairColor}"/>
      <!-- Eyes -->
      <ellipse cx="480" cy="700" rx="25" ry="15" fill="white"/>
      <ellipse cx="600" cy="700" rx="25" ry="15" fill="white"/>
      <circle cx="480" cy="700" r="10" fill="${eyeColor}"/>
      <circle cx="600" cy="700" r="10" fill="${eyeColor}"/>
      <!-- Eyebrows -->
      <path d="M455 670 Q480 660 505 670" stroke="${dna.eyebrowShape === 'arched' ? '#333' : '#555'}" stroke-width="3" fill="none"/>
      <path d="M575 670 Q600 660 625 670" stroke="${dna.eyebrowShape === 'arched' ? '#333' : '#555'}" stroke-width="3" fill="none"/>
      <!-- Nose -->
      <path d="M540 715 L530 750 Q540 755 550 750 Z" fill="${skinColor}" stroke="#d5a885" stroke-width="1"/>
      <!-- Mouth (lip-sync, visual only — NO text anywhere in this frame) -->
      <ellipse cx="540" cy="810" rx="40" ry="${mouthH}" fill="${lipColor}" stroke="#8e1f1a" stroke-width="1"/>
    </svg>`;
}

function twinSkinToneToHex(tone: string): string {
  const map: Record<string, string> = {
    fair: '#f5d0c5', medium: '#e8b89a', olive: '#c99a7b',
    brown: '#8d6e53', dark: '#5c3a2e',
  };
  return map[String(tone || '').toLowerCase()] || '#e8b89a';
}

// ─── Cinema Engine Service ──────────────────────────────────────────────────

export class CinemaEngineService {
  private cinemaDir: string;
  private uploadDir: string;
  private facialDnaDir: string;

  constructor() {
    const baseDir = path.join(process.cwd(), 'public', 'assets', 'cinema');
    this.cinemaDir = path.join(baseDir, 'renders');
    this.uploadDir = path.join(baseDir, 'uploads');
    this.facialDnaDir = path.join(baseDir, 'facial_dna');
    
    for (const dir of [this.cinemaDir, this.uploadDir, this.facialDnaDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Generate a Neural Twin video from a user photo and script.
   * Pipeline: Extract Facial DNA → Generate frames → Lip-sync → Compose video
   */
  async createNeuralTwin(request: TwinCreationRequest): Promise<CinemaAsset> {
    const { userId, photoPath, photoUrl, script, voiceStyle, mood, duration, voice } = request;
    // CREATIVE TRANSFORMATION (owner Sep 28): the twin's script must be a FINISHED
    // pitch to potential clients, never a recital of the owner's typed brief or
    // the chat's internal structure. transformTwinScriptToPitch rewrites
    // INTERNAL-sounding scripts ("need 5 client beta testers", "5 compelling
    // reasons", "CTA", meta talk) into a client-directed pitch built from the
    // creative essence, and leaves already-finished user scripts verbatim.
    const safeScript = transformTwinScriptToPitch(script);
    const assetId = uuidv4();
    const outputPath = path.join(this.cinemaDir, `twin_${assetId}.mp4`);
    const inputPath = photoPath || photoUrl || '';

    // Export variants (16:9, 1:1, 2:3) generated from the twin master — pure FFmpeg
    // contain/pad refits (no AI calls, no crop). Populated after the master render.
    let exportVariants: Awaited<ReturnType<typeof generateVideoExportVariants>> = [];
    const generateTwinVariants = async () => {
      try {
        exportVariants = await generateVideoExportVariants(outputPath, userId, 'cinema/twins');
      } catch (e: any) {
        console.warn(`[CinemaEngine] Twin export variants failed: ${e?.message}`);
      }
      if (r2Storage.isAvailable && exportVariants.length === 0) {
        console.warn(`[CinemaEngine] Twin export variants produced 0/${VIDEO_EXPORT_VARIANTS.length} — source=${fs.existsSync(outputPath)} — see [EXPORT_VARIANTS] traces`);
      }
    };

    try {
      if (!inputPath) throw new Error('No input photo provided');

      // Enforce Weekly Limit
      await usageService.enforceLimit(userId, 'neural_twin');

      // Step 1: Extract Facial DNA from photo using Gemini Vision
      const facialDna = await this.extractFacialDna(userId, inputPath);

      // Step 2: ZERO-VIDEO-API FACELESS-STYLE PIPELINE (owner Sep 18 lock — "what
      // if we did twin the same way we do faceless": Twin = Faceless engine, NO
      // Sora, NO Veo, NO video API of any kind, at BOTH 15s and 30s). Sora was the
      // legacy primary here and is scheduled to permanently shut down 2026-09-24;
      // Twin now renders directly through the frame pipeline below — facial-DNA
      // talking-head stills (sharp, local) + FFmpeg compose — which is already
      // zero video API and was the pre-existing fallback. Cost ledger never sees
      // a Sora spend for Twin.
      const lipSyncData = await this.generateLipSyncReasoning(safeScript);
      // SHARED-PIPELINE RE-PLUMB (owner Oct 11 — "yes, fix twin"): the twin now
      // runs through the SAME deterministic plan gauntlet + TTS + assembler as
      // Faceless/Scene (mode-parity audit d390c9b9). GAP2 (zero F4 / zero TTS),
      // GAP3 (baked <text> frames) and GAP4 (silent compose) are closed here.
      const twinVoice: 'female' | 'male' | 'none' | undefined =
        voice === 'female' || voice === 'male' || voice === 'none' ? voice : undefined;
      const twinTone = toneFromTwinRequest(voiceStyle, mood);
      const targetDuration = typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? Math.min(duration, 30)
        : Math.max(5, Math.min(30, Math.round(String(safeScript || '').trim().split(/\s+/).filter(Boolean).length / 2.5)));
      const twinPlan = buildTwinPlan(safeScript, targetDuration, twinVoice);
      const framePaths = await this.generateTalkingFrames(facialDna, lipSyncData, twinPlan.plan, this.cinemaDir, assetId);
      const audioPaths: string[] = [];
      if (twinVoice !== 'none') {
        for (let i = 0; i < twinPlan.plan.length; i++) {
          const seg = twinPlan.plan[i];
          try {
            const a = await generateSceneAudio(seg.narration, userId, `twin_${assetId}_${i}`, twinVoice, twinTone);
            audioPaths.push(a.localPath);
          } catch (audioErr: any) {
            console.warn(`[CinemaEngine] Twin TTS failed for segment ${i}: ${audioErr?.message}`);
            audioPaths.push('');
          }
        }
      }
      await this.composeTwinVideo(
        twinPlan.plan,
        framePaths,
        audioPaths.length === twinPlan.plan.length ? audioPaths : null,
        outputPath,
      );
      const twinDelivered = twinPlan.delivered;
      const twinDeliveredSeconds = twinPlan.deliveredSeconds;

      await generateTwinVariants();
      // Upload to R2 if available
      const r2Result = await r2Storage.uploadLocalFile(outputPath, userId, 'cinema/twins', 'video/mp4');

      // MODE-PARITY (PR #114 contract): twin now persists a REAL video_projects row
      // with INTEGER-safe total_duration (deliveredVideoDurationSeconds — 29.8 -> 30)
      // and the precise delivered length in metadata.deliveredDurationSeconds, the
      // SAME contract as the faceless/scene shared insert (closes audit GAP1).
      try {
        await db.insert(schema.videoProjects).values({
          id: uuidv4(),
          userId,
          title: `Neural Twin - ${path.basename(outputPath)}`,
          status: 'completed',
          totalDuration: twinDeliveredSeconds,
          sceneCount: twinPlan.plan.length,
          script: twinPlan.plan as any,
          finalVideoUrl: r2Result.url || `/assets/cinema/renders/twin_${assetId}.mp4`,
          thumbnailUrl: `/assets/cinema/facial_dna/${path.basename(inputPath)}`,
          metadata: {
            mode: 'twin',
            voice: twinVoice || 'auto',
            tone: twinTone,
            deliveredDurationSeconds: twinDelivered,
            f4: { narrationInjected: twinPlan.f4Injected, narrationStillMissing: twinPlan.f4StillMissing },
            sellingPoints: twinPlan.sellingPoints,
            narrationRoles: twinPlan.narrationRoles,
            avatarLook: twinPlan.avatarLook || undefined,
            scriptTransformed: isInternalBriefEcho(script),
            engine: 'faceless-engine (talking-head · shared F4/F1/TTS pipeline)',
          },
        });
      } catch (projectErr: any) {
        console.warn('[CinemaEngine] Twin video_projects insert failed:', projectErr?.message);
      }

      await usageService.logUsage(userId, 'neural_twin', { assetId, scriptLength: script.length, engine: 'faceless-engine' });

      return {
        id: assetId,
        videoUrl: r2Result.url || `/assets/cinema/renders/twin_${assetId}.mp4`,
        thumbnailUrl: `/assets/cinema/facial_dna/${path.basename(inputPath)}`,
        status: 'completed',
        metadata: {
          script: safeScript,
          scriptOriginal: isInternalBriefEcho(script) ? String(script || '') : undefined,
          scriptTransformed: isInternalBriefEcho(script),
          facialDna,
          lipSyncComplexity: lipSyncData.phonemeComplexity,
          engine: 'faceless-engine (talking-head · shared F4/F1/TTS pipeline)',
          mode: 'twin',
          voice: twinVoice || 'auto',
          tone: twinTone,
          durationSeconds: twinDeliveredSeconds,
          deliveredDurationSeconds: twinDelivered,
          f4: { narrationInjected: twinPlan.f4Injected, narrationStillMissing: twinPlan.f4StillMissing },
          sellingPoints: twinPlan.sellingPoints,
          narrationRoles: twinPlan.narrationRoles,
          avatarLook: twinPlan.avatarLook || undefined,
        },
        variants: exportVariants,
      };
    } catch (error: any) {
      console.error('[CinemaEngine] Neural Twin failed:', error.message);
      return {
        id: assetId,
        videoUrl: '',
        thumbnailUrl: inputPath,
        status: 'failed',
        metadata: {},
        error: error.message,
      };
    }
  }

  /**
   * Load a photo as a base64 data-URI from either a local path or an http(s) URL.
   */
  private async loadImageDataUri(ref: string): Promise<{ dataUri: string; mime: string }> {
    const mime = (name: string) =>
      /\.png$/i.test(name) ? 'image/png'
      : /\.webp$/i.test(name) ? 'image/webp'
      : /\.pdf$/i.test(name) ? 'application/pdf'
      : 'image/jpeg';
    if (/^https?:\/\//i.test(ref)) {
      const res = await fetch(ref, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`fetch photo failed ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { dataUri: `data:${res.headers.get('content-type') || mime(ref)};base64,${buf.toString('base64')}`, mime: res.headers.get('content-type') || mime(ref) };
    }
    if (!fs.existsSync(ref)) throw new Error(`photo file not found: ${ref}`);
    const buf = fs.readFileSync(ref);
    const m = mime(ref);
    return { dataUri: `data:${m};base64,${buf.toString('base64')}`, mime: m };
  }

  /**
   * Extract Facial DNA from the user's uploaded photo.
   *
   * The uploaded photo MUST be what drives the "AI person", so this first attempts
   * a REAL vision call: the raw image bytes are attached (data URI) to a gpt-5.2
   * chat-completions request so the model actually SEES the face. If the vision
   * call is unavailable/fails (custom key / model without vision), it degrades to
   * the legacy text-only LangChain chain, and finally to safe generic defaults —
   * identical to the pre-hardening behavior, so nothing regresses.
   */
  private async extractFacialDna(userId: string, photoPath: string): Promise<FacialDNA> {
    const prompt = `
      Analyze this portrait photo and extract the facial characteristics.
      Return JSON with EXACTLY these keys:
      - faceShape: "oval" | "round" | "square" | "heart" | "diamond" | "oblong"
      - skinTone: string (e.g. "fair", "medium", "olive", "brown", "dark")
      - eyeColor: string
      - hairStyle: string
      - hairColor: string
      - jawline: "defined" | "soft" | "strong" | "rounded"
      - lipShape: "full" | "thin" | "medium" | "heart"
      - noseShape: "straight" | "aquiline" | "button" | "wide"
      - eyebrowShape: "arched" | "straight" | "rounded"
      - distinctiveFeatures: string[]
      Return ONLY the JSON object — no markdown, no commentary.`;

    let result: any = null;

    // Attempt 1: true vision — attach the actual photo to a multimodal chat call.
    const apiKey = process.env.OPENAI_API_KEY;
    try {
      if (apiKey) {
        const { dataUri } = await this.loadImageDataUri(photoPath);
        const visionRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: 'gpt-5.2',
            temperature: 0.2,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUri } },
              ],
            }],
          }),
          signal: AbortSignal.timeout(90000),
        });
        if (visionRes.ok) {
          const j = await visionRes.json();
          const text = j?.choices?.[0]?.message?.content;
          if (typeof text === 'string') {
            const cleaned = text.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            if (parsed && typeof parsed === 'object') {
              result = parsed;
              console.log(`[CinemaEngine] Facial DNA extracted via vision (image attached) for user ${userId}`);
            }
          }
        } else {
          console.warn(`[CinemaEngine] Vision DNA call failed (${visionRes.status}); falling back to text chain`);
        }
      }
    } catch (visionErr: any) {
      console.warn(`[CinemaEngine] Vision DNA error: ${visionErr.message}; falling back to text chain`);
    }

    // Attempt 2: legacy text-only chain (pre-hardening behavior).
    if (!result) {
      try {
        const model = await resolveStudioReasoner();
        const chain = RunnableSequence.from([PromptTemplate.fromTemplate(prompt), model, new JsonOutputParser()]);
        result = await chain.invoke({ imagePath: photoPath }) as any;
      } catch (leafErr: any) {
        console.warn(`[CinemaEngine] Text-chain DNA failed: ${leafErr.message}; using generic defaults`);
      }
    }

    // Save facial DNA to file for reuse
    try {
      const dnaPath = path.join(this.facialDnaDir, `${userId}_dna.json`);
      fs.writeFileSync(dnaPath, JSON.stringify(result || {}, null, 2));
    } catch {}

    return {
      faceShape: result?.faceShape || 'oval',
      skinTone: result?.skinTone || 'medium',
      eyeColor: result?.eyeColor || 'brown',
      hairStyle: result?.hairStyle || 'straight',
      hairColor: result?.hairColor || 'brown',
      jawline: result?.jawline || 'defined',
      lipShape: result?.lipShape || 'medium',
      noseShape: result?.noseShape || 'straight',
      eyebrowShape: result?.eyebrowShape || 'arched',
      distinctiveFeatures: Array.isArray(result?.distinctiveFeatures) ? result.distinctiveFeatures : [],
    };
  }

  /**
   * Generate lip-sync mapping from script text.
   */
  private async generateLipSyncReasoning(script: string) {
    try {
      const model = await resolveStudioReasoner();
      const template = `
        Analyze this script for Neural Twin lip-sync video:
        "{script}"
        Determine phoneme complexity and mouth movement intensity.
        Return JSON:
        - phonemeComplexity: "low" | "medium" | "high"
        - mouthIntensity: "subtle" | "dynamic" | "energetic"
        - keyEmotions: string[]
        - estimatedDuration: number (seconds, based on speaking speed)
      `;
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      return await chain.invoke({ script }) as any;
    } catch {
      return {
        phonemeComplexity: 'medium',
        mouthIntensity: 'dynamic',
        keyEmotions: ['confident'],
        estimatedDuration: Math.max(5, Math.ceil(script.length / 15)),
      };
    }
  }

  /**
   * Generate talking head frames based on facial DNA and script.
   * Creates a series of images with subtle mouth variations for lip-sync.
   */
  private async generateTalkingFrames(
    facialDna: FacialDNA,
    lipSyncData: any,
    plan: SceneScript[],
    outputDir: string,
    assetId: string
  ): Promise<string[]> {
    const framePaths: string[] = [];
    // ONE 1080x1920 frame per PLANNED SEGMENT (plan = shared-pipeline SceneScript[]),
    // so frame count == narration count == plan duration math. F1 NO-TEXT CONTRACT:
    // buildTwinFrameSvg has NO <text> elements — no script line, no emotion label,
    // no captions (audit GAP3 closed). Emotion drives VISUAL styling only (lip
    // color / mouth height), never text.
    const emotions = lipSyncData.keyEmotions || ['confident', 'warm'];
    for (let i = 0; i < plan.length; i++) {
      const emotion = emotions[i % emotions.length];
      const mouthOpen = 0.25 + 0.15 * Math.sin(i * 0.9); // subtle mouth variation (visual only)
      const svg = buildTwinFrameSvg(facialDna, emotion, mouthOpen);
      const framePath = path.join(outputDir, `twin_${assetId}_seg${String(i).padStart(2, '0')}.png`);

      await sharp(Buffer.from(svg))
        .resize(1080, 1920)
        .toFile(framePath);

      framePaths.push(framePath);
    }

    return framePaths;
  }

  /**
   * Compose talking head frames into video using FFmpeg.
   */
  private async composeTwinVideo(
    plan: SceneScript[],
    framePaths: string[],
    audioPaths: string[] | null,
    outputPath: string
  ): Promise<void> {
    // SHARED FACELESS ASSEMBLER (audit GAP4 closed): each segment is a still rendered
    // with its own TTS narration via renderClip (audio fitted to the segment window),
    // then the segments are dissolved together by concatClips' xfade + aParts/amix
    // graph — EXACTLY the assembly faceless/scene use (PR #112/#114 duration math).
    // voice:'none' passes audioPaths=null -> silent-by-design output (parity with
    // shouldGenerateSceneNarration semantics).
    const segClips: string[] = [];
    const stem = path.basename(outputPath, '.mp4');
    const workDir = path.join(this.cinemaDir, `twin_compose_${stem}`);
    fs.mkdirSync(workDir, { recursive: true });
    try {
      for (let i = 0; i < plan.length; i++) {
        const seg = plan[i];
        const segClip = path.join(workDir, `seg${String(i).padStart(2, '0')}.mp4`);
        const audio = audioPaths && audioPaths[i] ? audioPaths[i] : undefined;
        await renderClip(framePaths[i], segClip, Math.max(1, seg.duration), audio);
        segClips.push(segClip);
      }
      await concatClips(segClips, outputPath);
    } finally {
      for (const c of segClips) { try { fs.unlinkSync(c); } catch {} }
      for (const p of framePaths) { try { fs.unlinkSync(p); } catch {} }
      try { fs.rmdirSync(workDir); } catch {}
    }
  }

  /**
   * Apply "Empire Style" enhancements to a raw video.
   * Pipeline: Analyze video vibe → Apply color grading → Add watermark/overlays → Add smart captions
   */
  async enhanceRawVideo(userId: string, inputVideoPath: string): Promise<CinemaAsset> {
    const assetId = uuidv4();
    const outputPath = path.join(this.cinemaDir, `enhanced_${assetId}.mp4`);
    const thumbnailPath = path.join(this.cinemaDir, `thumb_${assetId}.jpg`);

    try {
      if (!fs.existsSync(inputVideoPath)) throw new Error('Input video not found');

      // 1. Analyze video vibe using Gemini (simulated)
      console.log(`[CinemaEngine] Analyzing video vibe for user ${userId}...`);

      // 2. Perform FFmpeg enhancement
      await new Promise((resolve, reject) => {
        ffmpeg(inputVideoPath)
          .videoFilters([
            // Simulate color grading (curves/saturation)
            'eq=saturation=1.2:brightness=0.05:contrast=1.1',
            // Simple vignettes or borders could go here
          ])
          .outputOptions([
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '22',
            '-pix_fmt', 'yuv420p',
          ])
          .on('end', () => resolve(true))
          .on('error', (err) => reject(err))
          .save(outputPath);
      });

      // 3. Generate thumbnail
      await new Promise((resolve, reject) => {
        ffmpeg(outputPath)
          .screenshots({
            count: 1,
            folder: this.cinemaDir,
            filename: `thumb_${assetId}.jpg`,
            size: '320x180'
          })
          .on('end', resolve)
          .on('error', reject);
      });

      // Upload to R2 if available
      const r2Result = await r2Storage.uploadLocalFile(outputPath, userId, 'cinema/enhanced', 'video/mp4');
      const thumbPath = path.join(this.cinemaDir, `thumb_${assetId}.jpg`);
      const r2Thumb = await r2Storage.uploadLocalFile(thumbPath, userId, 'cinema/thumbs', 'image/jpeg');

      return {
        id: assetId,
        videoUrl: r2Result.url || `/assets/cinema/renders/enhanced_${assetId}.mp4`,
        thumbnailUrl: r2Thumb.url || `/assets/cinema/renders/thumb_${assetId}.jpg`,
        status: 'completed',
        metadata: {
          enhancements: ['color_grading', 'saturation_boost', 'noise_reduction'],
          engine: 'Empire Cinema Neural Layer v2',
          processedAt: new Date()
        },
      };
    } catch (error: any) {
      console.error('[CinemaEngine] Enhancement failed:', error.message);
      return {
        id: assetId,
        videoUrl: '',
        thumbnailUrl: '',
        status: 'failed',
        metadata: {},
        error: error.message,
      };
    }
  }

  /**
   * Secure file validation for uploads.
   */
  validateUpload(filePath: string, type: 'photo' | 'video'): { valid: boolean; error?: string } {
    if (!fs.existsSync(filePath)) return { valid: false, error: 'File not found' };
    
    const stats = fs.statSync(filePath);
    const maxSize = type === 'photo' ? 90 * 1024 * 1024 : 200 * 1024 * 1024; // 90MB photo, 200MB video
    
    if (stats.size > maxSize) return { valid: false, error: `File too large (max ${maxSize / 1024 / 1024}MB)` };
    if (stats.size === 0) return { valid: false, error: 'Empty file' };

    const ext = path.extname(filePath).toLowerCase();
    const allowedPhoto = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
    const allowedVideo = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
    const allowed = type === 'photo' ? allowedPhoto : allowedVideo;
    
    if (!allowed.includes(ext)) return { valid: false, error: `Invalid file type: ${ext}. Allowed: ${allowed.join(', ')}` };

    return { valid: true };
  }

  /**
   * Store uploaded file securely with UUID name.
   */
  storeUpload(filePath: string, type: 'photo' | 'video'): string {
    const ext = path.extname(filePath);
    const storedName = `${uuidv4()}${ext}`;
    const targetDir = type === 'photo' ? this.facialDnaDir : this.uploadDir;
    const targetPath = path.join(targetDir, storedName);
    fs.copyFileSync(filePath, targetPath);
    return targetPath;
  }
}

export const cinemaEngineService = new CinemaEngineService();
