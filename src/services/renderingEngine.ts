import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { ProductionScene, TextOverlay } from './productionDirector.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RenderParams {
  scenes: ProductionScene[];
  pacing: 'fast' | 'moderate' | 'slow';
  outputDir?: string;
  backgroundAudioUrl?: string;
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
 * Pipeline: DALL-E 3 → Sharp (text overlays) → FFmpeg (video composition)
 *
 * 100% FREE, no external API calls:
 * - Sharp: FREE open-source image processing
 * - FFmpeg: FREE open-source video encoding
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
   * Full render pipeline: generate images → overlay text → compose video.
   */
  async render(params: RenderParams): Promise<RenderResult> {
    const taskId = uuidv4().slice(0, 8);
    const workingDir = path.join(this.tempDir, `render_${taskId}`);
    fs.mkdirSync(workingDir, { recursive: true });

    const sceneImages: string[] = [];

    try {
      // Phase 1: Generate all scene images via DALL-E 3
      for (let i = 0; i < params.scenes.length; i++) {
        const scene = params.scenes[i];
        console.log(`[RenderingEngine] Generating scene ${i + 1}/${params.scenes.length}: "${scene.sceneId}"`);

        const dalleImage = await this.generateSceneImage(scene.imagePrompt, workingDir, i);
        
        // Phase 2: Overlay text via Sharp (SVG compositing)
        const imageWithText = await this.applyTextOverlays(dalleImage, scene.textOverlays, workingDir, i);
        
        sceneImages.push(imageWithText);
      }

      // Phase 3: Compose video via FFmpeg
      console.log(`[RenderingEngine] Composing video from ${sceneImages.length} scenes...`);
      const videoUrl = await this.composeVideo(sceneImages, params.scenes, params.pacing, workingDir, params.backgroundAudioUrl);

      return {
        success: true,
        videoUrl,
        sceneImages,
      };
    } catch (error: any) {
      console.error('[RenderingEngine] Render failed:', error.message);
      // Clean up on failure
      this.cleanupDir(workingDir);
      return {
        success: false,
        sceneImages,
        error: error.message,
      };
    }
  }

  /**
   * Phase 1: Generate a single scene image using Sharp gradients.
   * Uses the scene's color hints from the prompt to create branded backgrounds.
   * No external API needed — 100% free.
   */
  private async generateSceneImage(prompt: string, outputDir: string, index: number): Promise<string> {
    // Extract color hints from the prompt or use defaults
    const colors = this.extractColorsFromPrompt(prompt);
    
    const outputPath = path.join(outputDir, `scene_${index.toString().padStart(2, '0')}.png`);
    
    // Create a beautiful gradient background using Sharp
    const width = 1024;
    const height = 1024;
    
    // Generate SVG gradient
    const gradientSvg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${colors[0]};stop-opacity:1" />
            <stop offset="50%" style="stop-color:${colors[1]};stop-opacity:1" />
            <stop offset="100%" style="stop-color:${colors[2]};stop-opacity:1" />
          </linearGradient>
          <radialGradient id="glow" cx="50%" cy="50%" r="60%">
            <stop offset="0%" style="stop-color:${colors[0]};stop-opacity:0.3" />
            <stop offset="100%" style="stop-color:${colors[0]};stop-opacity:0" />
          </radialGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#bg)" />
        <rect width="${width}" height="${height}" fill="url(#glow)" />
        ${this.generateDecorativeCircles(colors)}
      </svg>
    `;
    
    const svgBuffer = Buffer.from(gradientSvg);
    await sharp(svgBuffer).png().toFile(outputPath);
    
    return outputPath;
  }
  
  /**
   * Extract likely color hex codes from a DALL-E prompt.
   * Falls back to branded defaults.
   */
  private extractColorsFromPrompt(prompt: string): string[] {
    const hexRegex = /#[0-9a-fA-F]{6}/g;
    const matches = prompt.match(hexRegex);
    if (matches && matches.length >= 3) {
      return matches.slice(0, 3);
    }
    
    // Color keywords in prompt
    const lower = prompt.toLowerCase();
    if (lower.includes('pastel') || lower.includes('soft') || lower.includes('gentle')) {
      return ['#F8E8E0', '#E8D5C4', '#D4C4B0'];
    }
    if (lower.includes('dark') || lower.includes('moody') || lower.includes('dramatic')) {
      return ['#1A1A2E', '#16213E', '#0F3460'];
    }
    if (lower.includes('vibrant') || lower.includes('bright') || lower.includes('bold')) {
      return ['#FF6B6B', '#4ECDC4', '#45B7D1'];
    }
    if (lower.includes('nature') || lower.includes('earth') || lower.includes('organic')) {
      return ['#2D4F1E', '#8B7355', '#E4D5B7'];
    }
    if (lower.includes('candle') || lower.includes('warm') || lower.includes('cozy')) {
      return ['#F5D6C6', '#E8C4A0', '#D4A574'];
    }
    if (lower.includes('minimal') || lower.includes('clean') || lower.includes('modern')) {
      return ['#F5F5F0', '#E0E0D8', '#C0C0B8'];
    }
    
    // Default elegant gradient
    return ['#2C3E50', '#3498DB', '#2980B9'];
  }
  
  /**
   * Generate decorative circles for visual interest.
   */
  private generateDecorativeCircles(colors: string[]): string {
    const circles = [
      { cx: 100, cy: 100, r: 80, opacity: 0.15 },
      { cx: 924, cy: 200, r: 120, opacity: 0.1 },
      { cx: 512, cy: 824, r: 100, opacity: 0.12 },
      { cx: 200, cy: 700, r: 60, opacity: 0.08 },
    ];
    
    return circles.map((c, i) => {
      const color = colors[i % colors.length];
      return `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="${color}" opacity="${c.opacity}" />`;
    }).join('\n        ');
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
      const relativePath = path.relative(
        path.join(process.cwd(), 'temp', 'renders'),
        outputPath
      );
      const publicUrl = `/renders/${relativePath}`;

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
          resolve(publicUrl);
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