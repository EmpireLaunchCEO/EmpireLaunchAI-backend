import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { r2Storage } from './r2StorageService.js';

export interface SoraGenerationOptions {
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
   * POST /v1/videos to create, GET /v1/videos/{id} to poll, downloads on completion.
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

    try {
      console.log(`[PIPELINE] sora_create_start model=${model} prompt_length=${prompt.length}`);

      // Step 1: Create video generation
      console.log(`[SoraVideoService] POST to Sora create video...`);
      const createResponse = await fetch('https://api.openai.com/v1/videos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, prompt }),
        signal: AbortSignal.timeout(60000),
      });

      if (!createResponse.ok) {
        const errBody = await createResponse.text().catch(() => '');
        console.error(`[SoraVideoService] Create error (${createResponse.status}):`, errBody);
        return { success: false, error: `Sora API error: ${createResponse.status} — ${errBody.slice(0, 200)}` };
      }

      const createData = await createResponse.json();
      console.log(`[SoraVideoService] Sora create RESPONSE: status=${createResponse.status}, id=${createData?.id}, status=${createData?.status}`);
      const videoId = createData?.id;

      if (!videoId) {
        return { success: false, error: 'No video ID in Sora create response' };
      }

      console.log(`[PIPELINE] sora_created id=${videoId} status=${createData.status}`);

      // Step 2: Poll until complete
      console.log(`[SoraVideoService] Starting poll for video ${videoId}`);
      const completed = await this.pollVideo(videoId, apiKey);
      if (!completed) {
        return { success: false, error: 'Sora generation failed or timed out' };
      }

      // Step 3: Download video from /v1/videos/{id}/content
      const downloadUrl = `https://api.openai.com/v1/videos/${videoId}/content`;
      const localPath = await this.downloadVideo(downloadUrl, taskId, apiKey);
      const publicUrl = await this.maybeUploadToR2(localPath, options.userId);

      console.log(`[PIPELINE] sora_downloaded path=${localPath} url=${publicUrl}`);
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
   * Poll GET /v1/videos/{id} until status is "completed" or "failed".
   * No artificial attempt cap — relies on 5-min failsafe in studioRoutes.ts.
   * Returns true on completion, false on failure.
   */
  private async pollVideo(
    videoId: string,
    apiKey: string,
  ): Promise<boolean> {
    const MAX_ATTEMPTS = 58; // 58 × 5s ~= 4m50s, within Railway request budget
    const MAX_ELAPSED_MS = 5 * 60 * 1000; // 5 minute hard cap
    const startTime = Date.now();
    let attempt = 0;
    let consecutiveErrors = 0;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      // Railway-safe short interval instead of long timer.
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => { clearInterval(interval); resolve(); }, 5000);
      });
      console.log(`[PIPELINE] sora_poll_wait_complete video=${videoId} attempt=${attempt}`);
      // Hard time cap
      if (Date.now() - startTime > MAX_ELAPSED_MS) {
        console.error(`[SoraVideoService] Video ${videoId} timed out after ${attempt} polls`);
        return false;
      }

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
