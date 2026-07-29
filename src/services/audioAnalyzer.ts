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

export interface NoiseSpike {
  start: number;       // seconds
  end: number;         // seconds
  peakDb: number;      // approximate peak dB above mean
  probableCause: 'no-speech' | 'drowned-speech';
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
   * Detect background noise spikes (screams, barks, slams, sirens).
   *
   * Strategy: volume-spike + speech-gap cross-reference.
   *   1. Get per-second RMS levels via FFmpeg astats filter
   *   2. Flag chunks where RMS > 3x the median RMS
   *   3. Cross-reference with Whisper word timestamps:
   *      - no-speech: loud chunk has zero word overlap → pure noise
   *      - drowned-speech: loud chunk overlaps low-confidence words (<0.5)
   */
  async detectNoiseSpikes(
    audioPath: string,
    words: Array<{ start: number; end: number; confidence: number }>,
  ): Promise<NoiseSpike[]> {
    if (!fs.existsSync(audioPath)) {
      console.warn(`[AudioAnalyzer] Audio not found: ${audioPath}`);
      return [];
    }

    // 1. Get per-second RMS levels via FFmpeg astats
    interface RmsChunk { time: number; rms: number }
    const chunks: RmsChunk[] = [];

    try {
      await new Promise<void>((resolve) => {
        let stderr = '';
        ffmpeg(audioPath)
          .audioFilters('astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level')
          .outputOptions(['-f', 'null'])
          .output('/dev/null')
          .on('stderr', (line) => { stderr += line + '\n'; })
          .on('end', () => {
            // Parse: frame:N pts:X pts_time:T \n lavfi.astats.Overall.RMS_level=-25.3
            const lines = stderr.split('\n');
            let currentTime = -1;
            for (const line of lines) {
              const timeMatch = line.match(/pts_time:([\d.]+)/);
              if (timeMatch) {
                currentTime = parseFloat(timeMatch[1]);
              }
              const rmsMatch = line.match(/RMS_level=([\-\d.]+)/);
              if (rmsMatch && currentTime >= 0) {
                const rms = parseFloat(rmsMatch[1]);
                if (!isNaN(rms)) {
                  chunks.push({ time: currentTime, rms });
                }
              }
            }
            resolve();
          })
          .on('error', () => resolve())
          .run();
      });
    } catch {
      console.warn('[AudioAnalyzer] Noise spike detection failed — astats unavailable');
      return [];
    }

    if (chunks.length < 4) return []; // Too few chunks to analyze

    // 2. Compute median RMS, flag chunks >3x median
    const sortedRms = [...chunks].map(c => c.rms).sort((a, b) => a - b);
    const medianRms = sortedRms[Math.floor(sortedRms.length / 2)];

    // RMS is in dB (negative values). "3x louder" ≈ +10dB above median.
    // Use a threshold of median + 10dB to catch significant spikes.
    const threshold = medianRms + 10;

    const flagged = chunks
      .map((c, i) => ({ ...c, index: i, flagged: c.rms > threshold }))
      .filter(c => c.flagged);

    if (flagged.length === 0) return [];

    // 3. Merge adjacent flagged chunks into contiguous noise regions
    const regions: Array<{ start: number; end: number; peakRms: number }> = [];
    let currentRegion = { start: flagged[0].time, end: flagged[0].time + 1, peakRms: flagged[0].rms };

    for (let i = 1; i < flagged.length; i++) {
      if (flagged[i].time <= currentRegion.end + 0.5) {
        // Adjacent or close — merge
        currentRegion.end = flagged[i].time + 1;
        currentRegion.peakRms = Math.max(currentRegion.peakRms, flagged[i].rms);
      } else {
        regions.push({ ...currentRegion });
        currentRegion = { start: flagged[i].time, end: flagged[i].time + 1, peakRms: flagged[i].rms };
      }
    }
    regions.push(currentRegion);

    // 4. Cross-reference with Whisper words
    const spikes: NoiseSpike[] = [];
    for (const region of regions) {
      // Filter to noise-only: regions shorter than 3 seconds
      const duration = region.end - region.start;
      if (duration > 3) continue; // Too long — probably not a transient noise

      // Check word overlap
      const overlappingWords = words.filter(w =>
        w.end >= region.start - 0.1 && w.start <= region.end + 0.1,
      );

      if (overlappingWords.length === 0) {
        // No speech in this region — pure noise
        spikes.push({
          start: region.start,
          end: region.end,
          peakDb: Math.round(region.peakRms - medianRms),
          probableCause: 'no-speech',
        });
      } else {
        // Check if overlapping words are low-confidence (< 0.5)
        const allLowConfidence = overlappingWords.every(w => w.confidence < 0.5);
        if (allLowConfidence && overlappingWords.length <= 3) {
          spikes.push({
            start: Math.min(region.start, overlappingWords[0].start),
            end: Math.max(region.end, overlappingWords[overlappingWords.length - 1].end),
            peakDb: Math.round(region.peakRms - medianRms),
            probableCause: 'drowned-speech',
          });
        }
      }
    }

    console.log(`[AudioAnalyzer] Detected ${spikes.length} noise spikes (${spikes.filter(s => s.probableCause === 'no-speech').length} no-speech, ${spikes.filter(s => s.probableCause === 'drowned-speech').length} drowned-speech)`);
    return spikes;
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
