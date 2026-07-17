import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlatformManifest {
  platform: string;             // 'tiktok', 'instagram_reel', 'instagram_feed', 'facebook', 'youtube_shorts', 'youtube', 'pinterest', 'shopify', 'etsy', 'website'
  aspectRatio: string;          // '9:16', '1:1', '4:5', '16:9', '2:3'
  resolution: { width: number; height: number };
  videoBitrate?: string;        // e.g. '2500k'
  audioBitrate?: string;        // e.g. '128k'
  format?: string;              // 'mp4', 'mov'
}

export interface RenderConfig {
  sourceVideoPath: string;
  platforms?: string[];         // Which platforms to render for (default: all)
  enableWatermark?: boolean;
  watermarkUrl?: string;
  subtitles?: { text: string; start: number; end: number }[];
  titleOverlay?: string;
  callToAction?: string;
  normalizeAudio?: boolean;
  introClipPath?: string;
  outroClipPath?: string;
  mergeClips?: string[];        // Additional clips to merge
  generateThumbnail?: boolean;
}

export interface PlatformOutput {
  videoUrl: string;
  thumbnailUrl?: string;
  platform: string;
  resolution: string;
  aspectRatio: string;
}

export interface RenderResult {
  success: boolean;
  outputs: PlatformOutput[];
  error?: string;
}

// ─── Platform presets ────────────────────────────────────────────────────────

const PLATFORM_PRESETS: Record<string, PlatformManifest> = {
  tiktok:            { platform: 'tiktok',            aspectRatio: '9:16', resolution: { width: 1080, height: 1920 }, videoBitrate: '2500k' },
  instagram_reel:    { platform: 'instagram_reel',    aspectRatio: '9:16', resolution: { width: 1080, height: 1920 }, videoBitrate: '3500k' },
  instagram_feed:    { platform: 'instagram_feed',    aspectRatio: '4:5',  resolution: { width: 1080, height: 1350 }, videoBitrate: '3500k' },
  facebook:          { platform: 'facebook',          aspectRatio: '1:1',  resolution: { width: 1080, height: 1080 }, videoBitrate: '3000k' },
  youtube_shorts:    { platform: 'youtube_shorts',    aspectRatio: '9:16', resolution: { width: 1080, height: 1920 }, videoBitrate: '4000k' },
  youtube:           { platform: 'youtube',           aspectRatio: '16:9', resolution: { width: 1920, height: 1080 }, videoBitrate: '8000k' },
  pinterest:         { platform: 'pinterest',         aspectRatio: '2:3',  resolution: { width: 1000, height: 1500 }, videoBitrate: '2000k' },
  shopify:           { platform: 'shopify',           aspectRatio: '16:9', resolution: { width: 1920, height: 1080 }, videoBitrate: '4000k' },
  etsy:              { platform: 'etsy',              aspectRatio: '4:5',  resolution: { width: 1080, height: 1350 }, videoBitrate: '2500k' },
  website:           { platform: 'website',           aspectRatio: '16:9', resolution: { width: 1920, height: 1080 }, videoBitrate: '4000k' },
};

// ─── FFmpeg Render Service ───────────────────────────────────────────────────

export class FfmpegRenderService {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(process.cwd(), 'public', 'assets', 'cinema', 'renders');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Render a source video for multiple platforms.
   * Returns an array of platform-optimized outputs with URLs.
   */
  async render(sourceVideoPath: string, config: RenderConfig = {}): Promise<RenderResult> {
    const taskId = uuidv4().slice(0, 8);
    const workingDir = path.join(this.outputDir, `multi_${taskId}`);
    fs.mkdirSync(workingDir, { recursive: true });

    const targetPlatforms = config.platforms || Object.keys(PLATFORM_PRESETS);
    const outputs: PlatformOutput[] = [];

    try {
      for (const platformKey of targetPlatforms) {
        const preset = PLATFORM_PRESETS[platformKey];
        if (!preset) continue;

        console.log(`[FfmpegRender] Rendering for ${platformKey} (${preset.aspectRatio})...`);
        const outputPath = path.join(workingDir, `${platformKey}_${taskId}.mp4`);
        const publicUrl = `/assets/cinema/renders/multi_${taskId}/${platformKey}_${taskId}.mp4`;

        await this.renderForPlatform(sourceVideoPath, outputPath, preset, config);

        let thumbnailUrl: string | undefined;
        if (config.generateThumbnail !== false) {
          thumbnailUrl = await this.generateThumbnail(outputPath, workingDir, platformKey, taskId);
        }

        outputs.push({
          videoUrl: publicUrl,
          thumbnailUrl,
          platform: platformKey,
          resolution: `${preset.resolution.width}x${preset.resolution.height}`,
          aspectRatio: preset.aspectRatio,
        });
      }

      return { success: true, outputs };
    } catch (error: any) {
      console.error('[FfmpegRender] Render failed:', error.message);
      return { success: false, outputs, error: error.message };
    }
  }

  /**
   * Render a single platform version.
   */
  private async renderForPlatform(
    sourcePath: string,
    outputPath: string,
    manifest: PlatformManifest,
    config: RenderConfig,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let command = ffmpeg(sourcePath);

      // Crop/resize to target aspect ratio
      const filters: string[] = [];
      filters.push(`scale=${manifest.resolution.width}:${manifest.resolution.height}:force_original_aspect_ratio=increase`);
      filters.push(`crop=${manifest.resolution.width}:${manifest.resolution.height}`);

      // Brand watermark
      if (config.enableWatermark && config.watermarkUrl) {
        filters.push(`movie=${config.watermarkUrl}[wm];[0][wm]overlay=W-w-10:H-h-10`);
      }

      // Title overlay
      if (config.titleOverlay) {
        const escaped = config.titleOverlay.replace(/[:\/\\]/g, '\\$&');
        filters.push(`drawtext=text='${escaped}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=30`);
      }

      // Call-to-action
      if (config.callToAction) {
        const escaped = config.callToAction.replace(/[:\/\\]/g, '\\$&');
        filters.push(`drawtext=text='${escaped}':fontsize=36:fontcolor=yellow:x=(w-text_w)/2:y=h-80`);
      }

      if (filters.length > 0) {
        command = command.videoFilters(filters);
      }

      // Encoding settings
      command
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-b:v', manifest.videoBitrate || '3000k',
          '-c:a', 'aac',
          '-b:a', manifest.audioBitrate || '128k',
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });
  }

  /**
   * Generate a thumbnail from a video.
   */
  private async generateThumbnail(
    videoPath: string,
    workingDir: string,
    platform: string,
    taskId: string,
  ): Promise<string> {
    const thumbPath = path.join(workingDir, `${platform}_thumb_${taskId}.jpg`);

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          count: 1,
          folder: workingDir,
          filename: `${platform}_thumb_${taskId}.jpg`,
          timemarks: ['1'],
        })
        .on('end', () => {
          resolve(`/assets/cinema/renders/multi_${taskId}/${platform}_thumb_${taskId}.jpg`);
        })
        .on('error', () => resolve('')); // Soft fail
    });
  }

  /**
   * Get platform presets (for UI display).
   */
  getPlatformPresets(): Record<string, PlatformManifest> {
    return PLATFORM_PRESETS;
  }
}

export const ffmpegRenderService = new FfmpegRenderService();
