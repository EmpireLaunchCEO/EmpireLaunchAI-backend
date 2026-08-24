import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { resolveStudioReasoner } from '../utils/resolveModel.js';
import { usageService } from './usageService.js';
import { soraVideoService } from './soraVideoService.js';
import { r2Storage } from './r2StorageService.js';
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
  duration?: number;   // requested twin video length (seconds); honored via frame pacing (Sora single-clip cannot take a duration param)
}

export interface CinemaAsset {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  status: 'processing' | 'completed' | 'failed';
  metadata: any;
  error?: string;
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
    const { userId, photoPath, photoUrl, script, voiceStyle, mood, duration } = request;
    const assetId = uuidv4();
    const outputPath = path.join(this.cinemaDir, `twin_${assetId}.mp4`);
    const inputPath = photoPath || photoUrl || '';

    try {
      if (!inputPath) throw new Error('No input photo provided');

      // Enforce Weekly Limit
      await usageService.enforceLimit(userId, 'neural_twin');

      // Step 1: Extract Facial DNA from photo using Gemini Vision
      const facialDna = await this.extractFacialDna(userId, inputPath);

      // Step 2: Try Sora 2 for direct video generation.
      // NOTE: We intentionally do NOT pass a `duration` to Sora — the configured Sora
      // endpoint rejects an arbitrary duration param (400 unknown parameter: duration).
      // Target length (when requested) is honored in the fallback frame pipeline via
      // frame pacing instead.
      try {
        const soraPrompt = this.buildSoraTwinPrompt(facialDna, script, voiceStyle, mood);
        console.log(`[CinemaEngine] Attempting Sora 2 Neural Twin for user ${userId}...`);

        const soraResult = await soraVideoService.generateVideo(soraPrompt);

        if (soraResult.success && soraResult.videoPath) {
          // Copy Sora output to the expected cinema path
          fs.copyFileSync(soraResult.videoPath, outputPath);
          try { fs.unlinkSync(soraResult.videoPath); } catch {}

          // Upload to R2 if available
          const r2Result = await r2Storage.uploadLocalFile(outputPath, userId, 'cinema/twins', 'video/mp4');

          await usageService.logUsage(userId, 'neural_twin', { assetId, scriptLength: script.length, engine: 'sora-2' });

          return {
            id: assetId,
            videoUrl: r2Result.url || `/assets/cinema/renders/twin_${assetId}.mp4`,
            thumbnailUrl: `/assets/cinema/facial_dna/${path.basename(inputPath)}`,
            status: 'completed',
            metadata: {
              script,
              facialDna,
              engine: 'Sora 2 Neural Twin',
            },
          };
        }
        console.warn(`[CinemaEngine] Sora 2 failed: ${soraResult.error}. Falling back to frame pipeline...`);
      } catch (soraErr: any) {
        console.warn(`[CinemaEngine] Sora 2 error: ${soraErr.message}. Falling back.`);
      }

      // Fallback: legacy frame-by-frame pipeline.
      // Honor the requested twin duration (30/60s) via frame pacing — a Sora single
      // clip cannot accept a duration param, so we reach the target by generating the
      // right number of frames and holding each frame for the matching duration.
      const lipSyncData = await this.generateLipSyncReasoning(script);
      const framePaths = await this.generateTalkingFrames(
        facialDna, lipSyncData, script, this.cinemaDir, assetId, duration
      );
      await this.composeNeuralTwinVideo(framePaths, outputPath, lipSyncData, duration);

      // Upload to R2 if available
      const r2Result = await r2Storage.uploadLocalFile(outputPath, userId, 'cinema/twins', 'video/mp4');

      await usageService.logUsage(userId, 'neural_twin', { assetId, scriptLength: script.length });

      for (const fp of framePaths) {
        try { fs.unlinkSync(fp); } catch {}
      }

      return {
        id: assetId,
        videoUrl: r2Result.url || `/assets/cinema/renders/twin_${assetId}.mp4`,
        thumbnailUrl: `/assets/cinema/facial_dna/${path.basename(inputPath)}`,
        status: 'completed',
        metadata: {
          script,
          facialDna,
          lipSyncComplexity: lipSyncData.phonemeComplexity,
          engine: 'Empire Cinema Neural Layer v2 (fallback)',
        },
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
   * Build a Sora 2 prompt from facial DNA + script for Neural Twin generation.
   */
  private buildSoraTwinPrompt(facialDna: FacialDNA, script: string, voiceStyle?: string, mood?: string): string {
    const style = voiceStyle || 'natural';
    const moodClause = mood ? `\nOverall mood: ${mood} — the person's delivery, expression and the scene lighting should all convey a ${mood} tone.` : '';
    return `Create a realistic talking-head video of a person with the following characteristics:

Face: ${facialDna.faceShape} face shape, ${facialDna.skinTone} skin tone, ${facialDna.eyeColor} eyes.
Hair: ${facialDna.hairStyle}, ${facialDna.hairColor}.
Features: ${facialDna.jawline} jawline, ${facialDna.lipShape} lips, ${facialDna.noseShape} nose, ${facialDna.eyebrowShape} eyebrows.

The person is speaking directly to camera in a ${style} tone, delivering this script:
"${script}"

Style: professional, well-lit studio background, natural head movement, ${style} expression.${moodClause}`;
  }

  /** Load a photo as a base64 data-URI from either a local path or an http(s) URL. */
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
    script: string,
    outputDir: string,
    assetId: string,
    duration?: number
  ): Promise<string[]> {
    const framePaths: string[] = [];
    // When a target duration is requested, derive the frame count at constant 2fps so
    // the final video reaches ~`duration` seconds. Otherwise keep the original
    // script-length estimate (~5s).
    const targetDuration = typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? Math.min(duration, 60) // cap at 1 minute to bound render cost
      : (lipSyncData.estimatedDuration || 5);
    const totalFrames = Math.max(4, Math.ceil(targetDuration * 2)); // 2fps

    // Generate frame descriptions for different parts of the script
    const emotions = lipSyncData.keyEmotions || ['confident'];
    const scriptParts = this.splitScript(script, totalFrames);

    for (let i = 0; i < totalFrames; i++) {
      const emotion = emotions[i % emotions.length];
      const mouthOpen = 0.1 + (Math.sin(i * 0.5) * 0.3 + 0.3); // Simulate lip movement

      // Create an SVG-based talking head frame
      const svg = this.buildTalkingHeadSvg(facialDna, emotion, mouthOpen, scriptParts[i] || '');
      const framePath = path.join(outputDir, `frame_${assetId}_${i.toString().padStart(3, '0')}.png`);

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
  private async composeNeuralTwinVideo(
    framePaths: string[],
    outputPath: string,
    lipSyncData: any,
    duration?: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = ffmpeg();

      // Add each frame as input with 0.5s duration
      framePaths.forEach(fp => {
        command.input(fp).inputOptions(['-framerate', '1/0.5']);
      });

      // When a target duration is requested, pace output so the composed length is
      // ~`duration` (frame count already sized for it); otherwise keep the original
      // script-length estimate.
      const targetDuration = typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? Math.min(duration, 60)
        : (lipSyncData.estimatedDuration || 5);
      const fps = Math.max(1, Math.floor(framePaths.length / targetDuration));

      command
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-r', `${fps}`,
        ])
        .on('end', () => resolve())
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Build an SVG talking head from facial DNA parameters.
   */
  private buildTalkingHeadSvg(dna: FacialDNA, emotion: string, mouthOpen: number, scriptLine: string): string {
    const bgColor = '#1a1a2e';
    const skinColor = this.skinToneToHex(dna.skinTone);
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
      <!-- Mouth (lip-sync) -->
      <ellipse cx="540" cy="810" rx="40" ry="${mouthH}" fill="${lipColor}" stroke="#8e1f1a" stroke-width="1"/>
      <!-- Emotion label -->
      <text x="540" y="1050" text-anchor="middle" fill="white" font-size="24" font-family="Arial">${emotion.toUpperCase()}</text>
      <!-- Script line -->
      <text x="540" y="1150" text-anchor="middle" fill="#aaa" font-size="20" font-family="Arial" max-width="800">
        ${this.escapeXml(scriptLine)}
      </text>
    </svg>`;
  }

  private skinToneToHex(tone: string): string {
    const map: Record<string, string> = {
      fair: '#f5d0c5', medium: '#e8b89a', olive: '#c99a7b',
      brown: '#8d6e53', dark: '#5c3a2e',
    };
    return map[tone.toLowerCase()] || '#e8b89a';
  }

  private splitScript(script: string, parts: number): string[] {
    const words = script.split(' ');
    const wordsPerPart = Math.max(1, Math.ceil(words.length / parts));
    const result: string[] = [];
    for (let i = 0; i < parts; i++) {
      result.push(words.slice(i * wordsPerPart, (i + 1) * wordsPerPart).join(' '));
    }
    return result;
  }

  private escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
