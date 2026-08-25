import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { r2Storage } from './r2StorageService.js';

/**
 * Video Export Variants — pure-FFmpeg aspect-ratio refits (contain/pad, NO crop).
 *
 * Owner mandate (hard):
 *  1. NO AI calls for variants — re-encode only (render time, not AI spend).
 *  2. NO cropping / NO cutting off content — use contain/refit
 *     `scale=W:H:force_original_aspect_ratio=decrease` + centered `pad`.
 *  3. Labels are METADATA/UI ONLY — never burned into the video. The downloaded
 *     file is clean (no watermark, no text, no bar-label).
 * The 9:16 vertical master is produced by the primary assembly; these are the
 * ADDITIONAL formats generated from that same master.
 */

export interface ExportVariant {
  key: string;          // '16_9' | '1_1' | '2_3'
  aspectRatio: string;  // '16:9' | '1:1' | '2:3'
  label: string;        // UI/Library label only — never baked into video
  shape: string;        // 'horizontal' | 'square' | 'portrait' — shape preview icon
  width: number;
  height: number;
}

/** The extra variants beyond the existing 9:16 master. */
export const VIDEO_EXPORT_VARIANTS: ExportVariant[] = [
  { key: '16_9', aspectRatio: '16:9', label: 'AI Video (16:9 · YouTube/IG)',     shape: 'horizontal', width: 1920, height: 1080 },
  { key: '1_1',  aspectRatio: '1:1',  label: 'AI Video (1:1 · IG Feed)',         shape: 'square',     width: 1080, height: 1080 },
  { key: '2_3',  aspectRatio: '2:3',  label: 'AI Video (2:3 · Pinterest)',       shape: 'portrait',   width: 1080, height: 1620 },
];

export interface ExportVariantResult {
  variant: ExportVariant;
  fileUrl: string;
  r2Key?: string;
}

function trace(message: string) { process.stderr.write(`[EXPORT_VARIANTS] ${message}\n`); }

/**
 * Refit a video to exactly WxH without cropping: scale down to fit inside the
 * target box, then center-pad the remaining space with letterbox/pillarbox bars.
 * Audio is carried through (re-encoded to aac) when present.
 */
function refitVideo(input: string, output: string, w: number, h: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', input,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      output,
    ];
    execFile('ffmpeg', args, { maxBuffer: 32 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).split('\n').filter(Boolean).slice(-4).join(' ');
        reject(new Error(`ffmpeg variant exit ${err.code ?? ''}: ${tail}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Generate the extra aspect-ratio variants from an existing master video and
 * upload each to R2 (brand-isolated, provider tag stays 'ffmpeg'). Pure re-encode
 * — no AI calls. Returns the successfully-published variants (best effort: a
 * single failing variant never throws for the caller).
 */
export async function generateVideoExportVariants(
  sourceVideo: string,
  userId: string,
  prefix = 'video-projects',
): Promise<ExportVariantResult[]> {
  if (!r2Storage.isAvailable) {
    trace('r2 unavailable — skipping variant generation');
    return [];
  }
  if (!fs.existsSync(sourceVideo)) {
    trace(`source missing: ${sourceVideo}`);
    return [];
  }
  const dir = path.join(process.cwd(), 'temp', 'scene-export-variants', `${path.basename(sourceVideo)}-${uuidv4().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  const results: ExportVariantResult[] = [];

  for (const v of VIDEO_EXPORT_VARIANTS) {
    try {
      const local = path.join(dir, `${v.key}.mp4`);
      trace(`refit_${v.key}_start ${v.width}x${v.height}`);
      await refitVideo(sourceVideo, local, v.width, v.height);
      const size = fs.existsSync(local) ? fs.statSync(local).size : 0;
      if (size < 1024) {
        trace(`refit_${v.key}_empty_skip size=${size}`);
        continue;
      }
      const up = await r2Storage.uploadLocalFile(local, userId, `${prefix}/variants`, 'video/mp4');
      if (!up.url || !/^https?:\/\//.test(up.url)) {
        trace(`refit_${v.key}_upload_missing skip`);
        continue;
      }
      results.push({ variant: v, fileUrl: up.url, r2Key: up.r2Key });
      trace(`refit_${v.key}_ok r2=${up.r2Key}`);
    } catch (e: any) {
      trace(`refit_${v.key}_failed err=${e?.message}`);
    }
  }
  return results;
}
