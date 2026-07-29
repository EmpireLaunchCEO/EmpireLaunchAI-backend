import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SilenceRegion {
  start: number;    // seconds
  end: number;      // seconds
  duration: number; // seconds
}

// ─── Audio Analyzer ─────────────────────────────────────────────────────────

/**
 * Audio analysis utilities: silence detection and audio extraction.
 * Uses FFmpeg's silencedetect filter for pause detection.
 */
export class AudioAnalyzer {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp', 'audio');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Extract audio track from a video file.
   * Returns path to extracted MP3 file.
   */
  async extractAudio(videoPath: string): Promise<string | null> {
    if (!fs.existsSync(videoPath)) {
      console.warn(`[AudioAnalyzer] Video not found: ${videoPath}`);
      return null;
    }

    const outputPath = path.join(this.tempDir, `audio_${uuidv4().slice(0, 8)}.mp3`);

    return new Promise((resolve) => {
      ffmpeg(videoPath)
        .outputOptions([
          '-vn',           // No video
          '-acodec', 'libmp3lame',
          '-ar', '16000',  // 16kHz mono (good enough for Whisper)
          '-ac', '1',
          '-q:a', '4',
        ])
        .on('end', () => {
          console.log(`[AudioAnalyzer] Extracted audio: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.warn('[AudioAnalyzer] Audio extraction failed:', err.message);
          resolve(null);
        })
        .save(outputPath);
    });
  }

  /**
   * Detect silence regions in an audio file using FFmpeg silencedetect.
   * Returns regions of silence/pauses > minDuration seconds.
   */
  async detectSilences(audioPath: string, minDuration: number = 1.5): Promise<SilenceRegion[]> {
    if (!fs.existsSync(audioPath)) {
      console.warn(`[AudioAnalyzer] Audio not found: ${audioPath}`);
      return [];
    }

    return new Promise((resolve) => {
      const regions: SilenceRegion[] = [];
      let stderr = '';

      ffmpeg(audioPath)
        .audioFilters(`silencedetect=n=-30dB:d=${minDuration}`)
        .outputOptions(['-f', 'null'])
        .output('/dev/null')
        .on('stderr', (line) => {
          stderr += line + '\n';
        })
        .on('end', () => {
          // Parse FFmpeg silencedetect output:
          // [silencedetect @ ...] silence_start: 1.5
          // [silencedetect @ ...] silence_end: 3.2 | silence_duration: 1.7
          const lines = stderr.split('\n');
          let currentStart: number | null = null;

          for (const line of lines) {
            const startMatch = line.match(/silence_start:\s*([\d.]+)/);
            if (startMatch) {
              currentStart = parseFloat(startMatch[1]);
            }

            const endMatch = line.match(/silence_end:\s*([\d.]+)/);
            const durMatch = line.match(/silence_duration:\s*([\d.]+)/);
            if (endMatch && currentStart !== null) {
              const end = parseFloat(endMatch[1]);
              const duration = durMatch ? parseFloat(durMatch[1]) : end - currentStart;
              regions.push({ start: currentStart, end, duration });
              currentStart = null;
            }
          }

          console.log(`[AudioAnalyzer] Detected ${regions.length} silences >${minDuration}s`);
          resolve(regions);
        })
        .on('error', (err) => {
          console.warn('[AudioAnalyzer] Silence detection failed:', err.message);
          // Try to parse whatever we got from stderr
          resolve(regions);
        })
        .run();
    });
  }

  /**
   * Get video duration in seconds via FFprobe.
   */
  async getDuration(videoPath: string): Promise<number> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err || !metadata?.format?.duration) {
          resolve(0);
        } else {
          resolve(metadata.format.duration);
        }
      });
    });
  }

  /** Clean up temp audio files. */
  cleanup(audioPath: string): void {
    try {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    } catch {}
  }
}

export const audioAnalyzer = new AudioAnalyzer();
