import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { r2Storage } from './r2StorageService.js';

export interface SoraGenerationOptions {
  duration?: number;      // seconds, default 10
  size?: string;          // e.g. '1024x1024', '1920x1080'
  style?: string;         // 'natural' | 'cinematic' | 'animated'
  userId?: string;        // For R2 upload
}

export interface SoraGenerationResult {
  success: boolean;
  videoPath?: string;     // local path to downloaded video
  videoUrl?: string;      // public-facing URL
  error?: string;
}

export class SoraVideoService {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(process.cwd(), 'public', 'assets', 'cinema', 'sora');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Generate a video using OpenAI's Sora 2 model.
   * POSTs to /v1/video/generations, polls for completion, downloads the result.
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
    const duration = options.duration || 10;
    const size = options.size || '1024x1024';
    const taskId = uuidv4();

    try {
      console.log(`[SoraVideoService] Starting generation: model=${model}, duration=${duration}s`);

      // Step 1: Submit generation request
      const submitResponse = await fetch('https://api.openai.com/v1/video/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          duration,
          size,
          n: 1,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!submitResponse.ok) {
        const errBody = await submitResponse.text().catch(() => '');
        console.error(`[SoraVideoService] API error (${submitResponse.status}):`, errBody);
        return { success: false, error: `Sora API error: ${submitResponse.status}` };
      }

      const submitData = await submitResponse.json();
      const generationId = submitData?.id || submitData?.generation_id;

      if (!generationId) {
        // Response may already contain the video URL (synchronous)
        const directUrl = submitData?.video_url || submitData?.data?.[0]?.video_url;
        if (directUrl) {
          const localPath = await this.downloadVideo(directUrl, taskId);
          const publicUrl = await this.maybeUploadToR2(localPath, options.userId);
          return {
            success: true,
            videoPath: localPath,
            videoUrl: publicUrl,
          };
        }
        return { success: false, error: 'No generation ID or video URL in Sora response' };
      }

      // Step 2: Poll for completion
      const videoUrl = await this.pollForCompletion(generationId, apiKey);
      if (!videoUrl) {
        return { success: false, error: 'Sora generation timed out' };
      }

      // Step 3: Download video locally
      const localPath = await this.downloadVideo(videoUrl, taskId);
      const publicUrl = await this.maybeUploadToR2(localPath, options.userId);

      console.log(`[SoraVideoService] Generated: ${localPath}`);
      return {
        success: true,
        videoPath: localPath,
        videoUrl: publicUrl,
      };
    } catch (error: any) {
      console.error('[SoraVideoService] Generation failed:', error.message);
      return { success: false, error: error.message };
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
   * Poll the Sora API until the video generation is complete.
   */
  private async pollForCompletion(
    generationId: string,
    apiKey: string,
    maxAttempts = 30,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, 2000)); // 2s between polls

      try {
        const response = await fetch(
          `https://api.openai.com/v1/video/generations/${generationId}`,
          {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
          },
        );

        if (!response.ok) continue;

        const data = await response.json();
        const status = data?.status;

        if (status === 'completed' || status === 'succeeded') {
          return data?.video_url || data?.data?.[0]?.video_url || null;
        }
        if (status === 'failed' || status === 'cancelled') {
          console.error(`[SoraVideoService] Generation ${generationId} failed: ${status}`);
          return null;
        }

        console.log(`[SoraVideoService] Polling ${generationId}: attempt ${attempt + 1}, status=${status}`);
      } catch (err) {
        // Retry on network errors
        console.warn(`[SoraVideoService] Poll attempt ${attempt + 1} failed:`, (err as Error).message);
      }
    }

    return null;
  }

  /**
   * Download a video from a URL and save to local storage.
   */
  private async downloadVideo(url: string, taskId: string): Promise<string> {
    const ext = '.mp4';
    const filename = `sora_${taskId}${ext}`;
    const outputPath = path.join(this.outputDir, filename);

    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    return outputPath;
  }
}

export const soraVideoService = new SoraVideoService();
