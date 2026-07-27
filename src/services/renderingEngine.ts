import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { ProductionScene, TextOverlay } from './productionDirector.js';
import { soraVideoService } from './soraVideoService.js';
import { r2Storage } from './r2StorageService.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RenderParams {
  scenes: ProductionScene[];
  pacing: 'fast' | 'moderate' | 'slow';
  outputDir?: string;
  backgroundAudioUrl?: string;
  userId?: string; // For R2 upload
}

export interface RenderResult {
  success: boolean;
  videoUrl?: string;
  sceneImages: string[];
  error?: string;
}

// ─── Rendering Engine ───────────────────────────────────────────────────────

/**
 * Rendering Engine — takes a Production Script and renders it into a video.
 * Pipeline: Sora 2 (attempted first) → GPT Image 2 + Sharp → FFmpeg (fallback)
 */
export class RenderingEngine {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp', 'renders');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Full render pipeline: try Sora 2 first, fall back to gpt-image-2 + FFmpeg.
   */
  async render(params: RenderParams): Promise<RenderResult> {
    const taskId = uuidv4().slice(0, 8);
    const workingDir = path.join(this.tempDir, `render_${taskId}`);
    fs.mkdirSync(workingDir, { recursive: true });

    const sceneImages: string[] = [];

    // Build a unified Sora prompt from all scene prompts
    const soraPrompt = params.scenes
      .map((s, i) => `Scene ${i + 1}: ${s.imagePrompt}`)
      .join('\n');

    // Sora 2 is the only video generation path — no GPT Image 2 fallback for video
    try {
      console.log(`[RenderingEngine] Generating video via Sora 2...`);
      const soraResult = await soraVideoService.generateVideo(soraPrompt, {
        duration: Math.min(params.scenes.length * 5, 30),
        size: '1024x1024',
      });

      if (soraResult.success && soraResult.videoPath) {
        console.log(`[RenderingEngine] Sora 2 generated video: ${soraResult.videoPath}`);
        const vidUrl = soraResult.videoUrl || soraResult.videoPath;
        let finalUrl = vidUrl;
        if (params.userId && r2Storage.isAvailable) {
          const r2 = await r2Storage.uploadLocalFile(soraResult.videoPath, params.userId, 'renders/sora', 'video/mp4');
          finalUrl = r2.url || vidUrl;
        }
        return {
          success: true,
          videoUrl: finalUrl,
          sceneImages: [soraResult.videoPath],
        };
      }
      return {
        success: false,
        sceneImages: [],
        error: soraResult.error || 'Sora 2 generation failed',
      };
    } catch (soraErr: any) {
      console.error(`[RenderingEngine] Sora 2 error: ${soraErr.message}`);
      return {
        success: false,
        sceneImages: [],
        error: soraErr.message || 'Sora 2 unavailable',
      };
    }
  }

  /**
   * Generate a single image using GPT Image 2. For image_creation/image_editing.
   * Returns the local path to the generated PNG.
   */
  async renderImage(prompt: string, userId?: string): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
    const taskId = uuidv4().slice(0, 8);
    const workingDir = path.join(this.tempDir, `img_${taskId}`);
    fs.mkdirSync(workingDir, { recursive: true });

    try {
      const localPath = await this.generateSceneImage(prompt, workingDir, 0);
      let finalUrl = localPath;
      if (userId && r2Storage.isAvailable) {
        const r2 = await r2Storage.uploadLocalFile(localPath, userId, 'renders/images', 'image/png');
        finalUrl = r2.url || localPath;
      }
      return { success: true, imageUrl: finalUrl };
    } catch (err: any) {
      console.error('[RenderingEngine] Image generation failed:', err.message);
      this.cleanupDir(workingDir);
      return { success: false, error: err.message };
    }
  }

  /**
   * Phase 1: Generate a single scene image using OpenAI gpt-image-2.
   * Uses the scene's image prompt to create a photorealistic background.
   */
  private async generateSceneImage(prompt: string, outputDir: string, index: number): Promise<string> {
    const outputPath = path.join(outputDir, `scene_${index.toString().padStart(2, '0')}.png`);
    
    // Call OpenAI gpt-image-2 via chat completions API
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured — cannot generate scene images');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        messages: [
          { 
            role: 'user', 
            content: [
              { type: 'text', text: prompt }
            ]
          }
        ],
        n: 1,
        size: '1024x1024'
      }),
      signal: AbortSignal.timeout(30000) // 30 second timeout for image gen
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error(`[RenderingEngine] gpt-image-2 error (${response.status}):`, errorBody);
      // Fallback: generate a solid color placeholder
      const fallbackSvg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" fill="#2C3E50"/></svg>`;
      await sharp(Buffer.from(fallbackSvg)).png().toFile(outputPath);
      return outputPath;
    }

    const data = await response.json();
    const b64Json = data?.choices?.[0]?.message?.content;
    
    if (!b64Json) {
      console.warn('[RenderingEngine] No image data in response, using fallback');
      const fallbackSvg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" fill="#2C3E50"/></svg>`;
      await sharp(Buffer.from(fallbackSvg)).png().toFile(outputPath);
      return outputPath;
    }

    // Decode base64 and save as PNG
    // The response may be plain base64 or a data URL
    const base64Data = b64Json.replace(/^data:image\/png;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    await sharp(imageBuffer).png().toFile(outputPath);

    console.log(`[RenderingEngine] Scene ${index} image generated via gpt-image-2`);
    return outputPath;
  }

  /**
   * Phase 2: Apply text overlays via Sharp (SVG compositing).
   * Pure native rendering — no external design tool needed.
   */
  private async applyTextOverlays(
    imagePath: string,
    overlays: TextOverlay[],
    outputDir: string,
    index: number
  ): Promise<string> {
    if (overlays.length === 0) return imagePath;

    let image = sharp(imagePath);

    for (const overlay of overlays) {
      const svg = this.buildTextSvg(overlay);
      image = image.composite([{
        input: Buffer.from(svg),
        gravity: 'south',
        top: 0,
        left: 0,
      }]);
    }

    const outputPath = path.join(outputDir, `scene_${index.toString().padStart(2, '0')}_text.png`);
    await image.toFile(outputPath);

    return outputPath;
  }

  /**
   * Phase 3: Compose video from scene images via FFmpeg.
   * Each scene has a configurable duration + transition.
   */
  private composeVideo(
    sceneImages: string[],
    scenes: ProductionScene[],
    pacing: string,
    outputDir: string,
    backgroundAudioUrl?: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(outputDir, `final_render.mp4`);

      // Calculate frames per scene based on duration (30fps)
      const frameRates = scenes.map(s => `-framerate 1/${s.durationSeconds}`);

      // Build FFmpeg command
      const command = ffmpeg();

      // Add each scene as input
      sceneImages.forEach((img, i) => {
        command.input(img);
      });

      // Build filter complex for transitions and concatenation
      const filterParts: string[] = [];
      const inputLabels: string[] = [];

      for (let i = 0; i < sceneImages.length; i++) {
        const label = `[${i}:v]`;
        const scene = scenes[i];
        // Set frame duration by repeating the frame at target fps
        const totalFrames = scene.durationSeconds * 30;
        inputLabels.push(`[v${i}]`);
        filterParts.push(
          `${label}trim=duration=${scene.durationSeconds}[v${i}]`
        );
      }

      // Concat all scenes
      const concatInput = inputLabels.join('');
      filterParts.push(`${concatInput}concat=n=${sceneImages.length}:v=1:a=0[vout]`);

      command
        .outputOptions([
          '-filter_complex', filterParts.join(';'),
          '-map', '[vout]',
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-r', '30',
        ]);

      // Add background audio if provided
      if (backgroundAudioUrl) {
        command.input(backgroundAudioUrl)
          .outputOptions(['-c:a', 'aac', '-shortest']);
      }

      command
        .on('end', () => {
          console.log(`[RenderingEngine] Video rendered: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('[RenderingEngine] FFmpeg error:', err.message);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Build SVG text overlay for Sharp compositing.
   */
  private buildTextSvg(overlay: TextOverlay): string {
    const fontFamily = overlay.fontStyle.includes('serif')
      ? "'Playfair Display', Georgia, serif"
      : "'Inter', Helvetica, sans-serif";

    const fontWeight = overlay.fontStyle.includes('bold') ? 700 : 300;

    const yPos = this.getTextYPosition(overlay.position);

    // Semi-transparent background for readability
    const bgHeight = overlay.fontSize * 1.8;
    const bgY = overlay.position === 'top' ? 20 :
               overlay.position === 'center' ? 512 - bgHeight / 2 :
               overlay.position === 'bottom_third' ? 650 - bgHeight / 2 :
               1024 - bgHeight - 30;

    return `
      <svg width="1024" height="1024">
        <style>
          .bg { fill: rgba(0,0,0,0.3); }
          .text { 
            font-family: ${fontFamily}; 
            font-weight: ${fontWeight}; 
            font-size: ${overlay.fontSize}px; 
            fill: ${overlay.color}; 
            text-anchor: middle;
            dominant-baseline: central;
          }
          .shadow {
            filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.4));
          }
        </style>
        <rect class="bg" x="50" y="${bgY}" width="924" height="${bgHeight}" rx="12"/>
        <text class="text shadow" x="512" y="${yPos}">${this.escapeXml(overlay.text)}</text>
      </svg>
    `;
  }

  private getTextYPosition(position: string): number {
    switch (position) {
      case 'top': return 60 + 30; // 20px padding + half font
      case 'center': return 512;
      case 'bottom_third': return 650;
      case 'bottom': return 1024 - 50;
      default: return 512;
    }
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Clean up temporary files.
   */
  cleanupDir(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Silently ignore cleanup errors
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const renderingEngine = new RenderingEngine();