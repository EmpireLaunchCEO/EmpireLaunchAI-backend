import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { transcriptionService, WordTimestamp } from './transcriptionService.js';
import { audioAnalyzer, SilenceRegion, NoiseSpike } from './audioAnalyzer.js';
import { r2Storage } from './r2StorageService.js';
import { reasoningEngine } from './reasoningEngine.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EditDecision {
  type: 'cut' | 'trim';
  cutStart: number;  // seconds — start of region to remove
  cutEnd: number;    // seconds — end of region to remove
  reason: string;    // human-readable reason
}

interface FillerCandidate {
  wordIndex: number;   // index into words[] for single-word filler
  endIndex: number;    // index of last word (same as wordIndex for singles; +1 for bigrams)
  text: string;        // the candidate word/phrase
  context: string;     // ±5 words of surrounding context
}

export interface CleanupResult {
  success: boolean;
  outputPath?: string;
  r2Key?: string;
  editsApplied: number;
  cuts: EditDecision[];
  error?: string;
}

// ─── Known filler words ─────────────────────────────────────────────────────

const FILLER_WORDS = new Set([
  'um', 'uh', 'er', 'ah', 'hmm', 'hm',
  'like', 'you know', 'i mean', 'sort of', 'kind of',
  'basically', 'literally', 'actually', 'so', 'right',
]);

// ─── Speech Cleanup Service ─────────────────────────────────────────────────

/**
 * Intelligent speech cleanup pipeline.
 *
 * Analyzes video audio, detects issues (pauses, fillers, false starts),
 * builds an Edit Decision List, and applies cuts via FFmpeg.
 */
export class SpeechCleanupService {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp', 'cleanup');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Full analysis: extract audio, transcribe, detect silences, build EDL.
   */
  async analyzeVideo(videoPath: string): Promise<{
    transcription: Awaited<ReturnType<typeof transcriptionService.transcribe>>;
    silences: SilenceRegion[];
    edits: EditDecision[];
  } | null> {
    // 1. Extract audio
    const audioPath = await audioAnalyzer.extractAudio(videoPath);
    if (!audioPath) {
      console.warn('[SpeechCleanup] Failed to extract audio');
      return null;
    }

    // 2. Transcribe
    const transcription = await transcriptionService.transcribe(audioPath);
    if (!transcription || transcription.words.length === 0) {
      console.warn('[SpeechCleanup] Transcription failed or returned no words');
      audioAnalyzer.cleanup(audioPath);
      return null;
    }

    // 3. Detect silences
    const silences = await audioAnalyzer.detectSilences(audioPath, 1.5);

    // 4. Build Edit Decision List (needs audioPath for Pass D: noise detection)
    const edits = await this.buildEditDecisionList(transcription.words, silences, audioPath);

    // Clean up temp audio AFTER EDL is built (Pass D needs it)
    audioAnalyzer.cleanup(audioPath);

    console.log(`[SpeechCleanup] Analysis complete: ${edits.length} edit decisions`);

    return { transcription, silences, edits };
  }

  /**
   * Build an Edit Decision List from transcription + silence data.
   *
   * Four cleanup passes:
   *   A. Long pauses — trim >2s silences to 0.5s, cut >5s entirely
   *   B. Filler words — context-aware removal via Gemini classification
   *   C. False starts — detect restarted phrases
   *   D. Background noise — volume-spike + speech-gap cross-reference
   */
  async buildEditDecisionList(words: WordTimestamp[], silences: SilenceRegion[], audioPath: string): Promise<EditDecision[]> {
    const edits: EditDecision[] = [];

    // ── Pass A: Long pauses ──────────────────────────────────────────
    for (const silence of silences) {
      if (silence.duration > 5) {
        // Full cut — remove entire pause and slightly into boundary
        edits.push({
          type: 'cut',
          cutStart: Math.max(0, silence.start - 0.1),
          cutEnd: silence.end + 0.1,
          reason: `Long pause (${silence.duration.toFixed(1)}s) — full cut`,
        });
      } else if (silence.duration > 2) {
        // Trim: keep 0.5s, cut the rest
        const trimStart = silence.start + 0.5;
        edits.push({
          type: 'cut',
          cutStart: trimStart,
          cutEnd: silence.end,
          reason: `Pause trimmed ${(silence.duration - 0.5).toFixed(1)}s → 0.5s`,
        });
      }
    }

    // ── Pass B: Filler words (context-aware via Gemini) ──────────────
    // Phase 1: Collect candidates with surrounding context
    const candidates: FillerCandidate[] = [];

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const lower = word.text.toLowerCase();

      // Single-word filler candidates
      if (FILLER_WORDS.has(lower) && lower.length <= 6) {
        const ctxStart = Math.max(0, i - 5);
        const ctxEnd = Math.min(words.length, i + 6);
        const context = words.slice(ctxStart, ctxEnd).map(w => w.text).join(' ');
        candidates.push({ wordIndex: i, endIndex: i, text: word.text, context });
      }

      // Multi-word fillers: "you know", "i mean", "sort of", "kind of"
      if (i + 1 < words.length) {
        const bigram = `${lower} ${words[i + 1].text.toLowerCase()}`;
        if (FILLER_WORDS.has(bigram)) {
          const ctxStart = Math.max(0, i - 5);
          const ctxEnd = Math.min(words.length, i + 7);
          const context = words.slice(ctxStart, ctxEnd).map(w => w.text).join(' ');
          candidates.push({ wordIndex: i, endIndex: i + 1, text: bigram, context });
          i++; // Skip next word
        }
      }
    }

    // Phase 2: Classify candidates via Gemini, add cuts only for FILLER-classified ones
    if (candidates.length > 0) {
      const fillerIndices = await this.classifyFillerCandidates(candidates);

      for (const idx of fillerIndices) {
        const c = candidates[idx];
        const startWord = words[c.wordIndex];
        const endWord = words[c.endIndex];
        edits.push({
          type: 'cut',
          cutStart: Math.max(0, startWord.start - 0.05),
          cutEnd: endWord.end + 0.05,
          reason: `Filler: "${c.text}"`,
        });
      }
    }

    // ── Pass C: False starts ──────────────────────────────────────────
    const phrases = transcriptionService.groupIntoPhrases(words, 0.5);

    for (let i = 0; i < phrases.length - 1; i++) {
      const current = phrases[i];
      const next = phrases[i + 1];

      const gap = next.start - current.end;
      if (gap < 0 || gap > 1.0) continue; // No gap or too large gap

      // Jaccard similarity on word sets
      const currentWords = new Set(current.text.toLowerCase().split(/\s+/));
      const nextWords = new Set(next.text.toLowerCase().split(/\s+/));

      const intersection = [...currentWords].filter(w => nextWords.has(w));
      const union = new Set([...currentWords, ...nextWords]);
      const jaccard = union.size > 0 ? intersection.length / union.size : 0;

      // If >60% overlap AND current is shorter, it's a false start
      if (jaccard > 0.6 && current.text.length < next.text.length) {
        edits.push({
          type: 'cut',
          cutStart: current.start,
          cutEnd: current.end + (gap > 0 ? gap : 0),
          reason: `False start: "${current.text.slice(0, 50)}..." → "${next.text.slice(0, 50)}..."`,
        });
      }
    }

    // ── Edge case: filler + pause + restart ──────────────────────────
    // Find patterns where a filler word is followed by >1s silence, then a restart
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const lower = word.text.toLowerCase();
      if (!FILLER_WORDS.has(lower)) continue;

      // Look ahead for a silence > 1s after this filler
      for (const silence of silences) {
        if (silence.start >= word.end - 0.1 && silence.start <= word.end + 0.3 && silence.duration > 1) {
          // Check if the phrase after the silence is a restart
          const afterSilence = words.filter(w => w.start >= silence.end);
          if (afterSilence.length < 3) continue;

          const prePhrase = words.filter(w => w.end < word.start).slice(-8);
          const preText = prePhrase.map(w => w.text).join(' ').toLowerCase();
          const postText = afterSilence.slice(0, 8).map(w => w.text).join(' ').toLowerCase();

          // Quick overlap check
          const preSet = new Set(preText.split(/\s+/));
          const postSet = new Set(postText.split(/\s+/));
          const overlap = [...preSet].filter(w => postSet.has(w)).length;
          const maxSize = Math.max(preSet.size, postSet.size);

          if (maxSize > 0 && overlap / maxSize > 0.4) {
            edits.push({
              type: 'cut',
              cutStart: word.start,
              cutEnd: silence.end,
              reason: `Filler + pause + restart: "${word.text}" + ${silence.duration.toFixed(1)}s pause`,
            });
            break; // One match per filler
          }
        }
      }
    }

    // ── Pass D: Background Noise ──────────────────────────────────────
    // Volume-spike + speech-gap cross-reference: detect screams, barks, slams, sirens
    try {
      const noiseSpikes = await audioAnalyzer.detectNoiseSpikes(audioPath, words);

      // Safety check: if >30% of video duration is flagged as noise, skip entirely
      // (probably an outdoor recording — cutting everything would destroy it)
      const duration = words.length > 0 ? words[words.length - 1].end : 60;
      const totalNoiseTime = noiseSpikes.reduce((sum, s) => sum + (s.end - s.start), 0);
      const noisePercent = duration > 0 ? (totalNoiseTime / duration) * 100 : 0;

      if (noisePercent > 30) {
        console.warn(`[SpeechCleanup] Skipping noise removal — ${noisePercent.toFixed(0)}% of audio flagged (likely outdoor recording)`);
      } else {
        for (const spike of noiseSpikes) {
          const padding = 0.1;
          if (spike.probableCause === 'no-speech') {
            edits.push({
              type: 'cut',
              cutStart: Math.max(0, spike.start - padding),
              cutEnd: spike.end + padding,
              reason: `Background noise: no speech detected (+${spike.peakDb}dB)`,
            });
          } else {
            // drowned-speech: cut noise + the garbled word
            edits.push({
              type: 'cut',
              cutStart: Math.max(0, spike.start - padding),
              cutEnd: spike.end + padding,
              reason: `Background noise: drowned speech (+${spike.peakDb}dB)`,
            });
          }
        }
      }
    } catch (noiseErr: any) {
      console.warn('[SpeechCleanup] Noise detection failed, skipping Pass D:', noiseErr.message);
    }

    // Deduplicate overlapping cuts and sort by start time
    return this.deduplicateEdits(edits);
  }

  /**
   * Apply edits to a video using FFmpeg trim + concat filters.
   * Builds a complex filter that cuts out the unwanted segments and
   * concatenates the kept segments.
   */
  async applyEdits(videoPath: string, edits: EditDecision[], outputPath: string): Promise<boolean> {
    if (edits.length === 0) {
      // No edits — just copy the file
      fs.copyFileSync(videoPath, outputPath);
      return true;
    }

    // Get video duration
    const duration = await audioAnalyzer.getDuration(videoPath);

    // Build keep segments: the inverse of cut segments
    const cuts = edits
      .filter(e => e.type === 'cut')
      .sort((a, b) => a.cutStart - b.cutStart);

    // Merge overlapping cuts
    const mergedCuts: { start: number; end: number }[] = [];
    for (const cut of cuts) {
      const last = mergedCuts[mergedCuts.length - 1];
      if (last && cut.cutStart <= last.end) {
        last.end = Math.max(last.end, cut.cutEnd);
      } else {
        mergedCuts.push({ start: cut.cutStart, end: cut.cutEnd });
      }
    }

    // Build keep segments (inverse of cuts)
    const keepSegments: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const cut of mergedCuts) {
      if (cut.start > cursor + 0.05) {
        keepSegments.push({ start: cursor, end: cut.start });
      }
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < duration - 0.05) {
      keepSegments.push({ start: cursor, end: duration });
    }

    if (keepSegments.length === 0) {
      console.warn('[SpeechCleanup] No keep segments — nothing to output');
      return false;
    }

    // If only one segment and it's the whole video, just copy
    if (keepSegments.length === 1 && keepSegments[0].start < 0.05 && keepSegments[0].end > duration - 0.05) {
      fs.copyFileSync(videoPath, outputPath);
      return true;
    }

    // Build FFmpeg command with trim + concat
    return new Promise((resolve) => {
      const filterParts: string[] = [];
      const inputLabels: string[] = [];

      for (let i = 0; i < keepSegments.length; i++) {
        const seg = keepSegments[i];
        const label = `[v${i}]`;
        const aLabel = `[a${i}]`;
        inputLabels.push(label);
        filterParts.push(
          `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS${label}`,
          `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS${aLabel}`,
        );
      }

      const concatInputs = keepSegments.map((_, i) => `[v${i}][a${i}]`).join('');
      filterParts.push(`${concatInputs}concat=n=${keepSegments.length}:v=1:a=1[vout][aout]`);

      ffmpeg(videoPath)
        .outputOptions([
          '-filter_complex', filterParts.join(';'),
          '-map', '[vout]',
          '-map', '[aout]',
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-preset', 'fast',
          '-crf', '23',
        ])
        .on('end', () => {
          console.log(`[SpeechCleanup] Applied ${edits.length} edits → ${keepSegments.length} segments`);
          resolve(true);
        })
        .on('error', (err) => {
          console.error('[SpeechCleanup] FFmpeg edit application failed:', err.message);
          resolve(false);
        })
        .save(outputPath);
    });
  }

  /**
   * Full pipeline: analyze a video, build EDL, apply cuts.
   */
  async processVideo(videoPath: string, userId?: string): Promise<CleanupResult> {
    const taskId = uuidv4().slice(0, 8);
    const outputPath = path.join(this.tempDir, `cleaned_${taskId}.mp4`);

    try {
      const analysis = await this.analyzeVideo(videoPath);
      if (!analysis) {
        return { success: false, editsApplied: 0, cuts: [], error: 'Analysis failed — could not extract or transcribe audio' };
      }

      const { edits } = analysis;
      if (edits.length === 0) {
        // No issues — copy original
        fs.copyFileSync(videoPath, outputPath);
        return { success: true, outputPath, editsApplied: 0, cuts: [] };
      }

      const applied = await this.applyEdits(videoPath, edits, outputPath);
      if (!applied) {
        return { success: false, editsApplied: 0, cuts: edits, error: 'Failed to apply edits via FFmpeg' };
      }

      // Upload to R2 if userId provided
      let r2Key: string | undefined;
      if (userId && r2Storage.isAvailable) {
        const r2Result = await r2Storage.uploadLocalFile(outputPath, userId, 'edits', 'video/mp4');
        if (r2Result.r2Key) r2Key = r2Result.r2Key;
      }

      console.log(`[SpeechCleanup] Process complete: ${edits.length} cuts applied`);
      return { success: true, outputPath, r2Key, editsApplied: edits.length, cuts: edits };
    } catch (err: any) {
      console.error('[SpeechCleanup] Process failed:', err.message);
      return { success: false, editsApplied: 0, cuts: [], error: err.message };
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Remove duplicate/overlapping edit decisions. */
  private deduplicateEdits(edits: EditDecision[]): EditDecision[] {
    // Sort by start time
    const sorted = [...edits].sort((a, b) => a.cutStart - b.cutStart);

    const result: EditDecision[] = [];
    for (const edit of sorted) {
      const last = result[result.length - 1];
      if (last && edit.cutStart <= last.cutEnd + 0.1) {
        // Merge overlapping edits
        last.cutEnd = Math.max(last.cutEnd, edit.cutEnd);
        last.reason = `${last.reason}; ${edit.reason}`;
      } else {
        result.push({ ...edit });
      }
    }

    return result;
  }

  /**
   * Send filler word candidates to Gemini for context-aware classification.
   * Batches all candidates into a single API call.
   * Returns indices of candidates classified as true fillers (discourse particles).
   */
  private async classifyFillerCandidates(candidates: FillerCandidate[]): Promise<number[]> {
    if (candidates.length === 0) return [];

    // Build a structured prompt with all candidates
    const candidateLines = candidates.map((c, i) =>
      `[${i}] Word: "${c.text}" | Context: "...${c.context}..."`,
    ).join('\n');

    const prompt = `You are a linguistics classifier. For each candidate below, determine whether the highlighted word/phrase is being used as a FILLER (discourse particle with no grammatical role) or GRAMMATICAL (part of the sentence structure).

Rules:
- "like" is FILLER only when used as a discourse particle (e.g., "It's, like, really great"). It is GRAMMATICAL when it's a verb with an object ("I like this"), a preposition ("looks like rain"), or a comparison ("feels like...").
- "you know" is FILLER only when parenthetical mid-sentence with pauses on both sides ("It's, you know, really good"). It is GRAMMATICAL in questions ("You know what?"), as a verb ("Do you know?"), or as a legitimate intro ("As you know...").
- "I mean" is FILLER when used as a discourse marker. GRAMMATICAL when actually meaning something ("What do I mean?").
- "um", "uh", "er", "ah", "hmm", "hm" are always FILLER.
- Single-word "so", "right", "actually", "basically", "literally" are FILLER when they don't contribute meaning — GRAMMATICAL when they do.
- "sort of", "kind of" are FILLER when hedges, GRAMMATICAL when describing categories.

Candidates:
${candidateLines}

Return ONLY a JSON array of indices of candidates classified as FILLER. Example: [0, 3, 5]
If none are fillers, return [].
Return ONLY the JSON array — no other text.`;

    try {
      const response = await reasoningEngine.reason(prompt, { temperature: 0.2, maxTokens: 512 });

      // Parse the response — expect a JSON array
      const trimmed = response.trim();
      const match = trimmed.match(/\[[\d,\s]*\]/);
      if (match) {
        const indices: number[] = JSON.parse(match[0]);
        const validIndices = indices.filter(i => i >= 0 && i < candidates.length);
        const skipped = candidates.length - validIndices.length;
        console.log(`[SpeechCleanup] AI classified ${validIndices.length}/${candidates.length} as FILLER (${skipped} kept as grammatical)`);
        return validIndices;
      }

      console.warn('[SpeechCleanup] Could not parse AI filler classification response:', trimmed.slice(0, 100));
      return [];
    } catch (err: any) {
      console.warn('[SpeechCleanup] Filler classification failed, skipping all candidates:', err.message);
      // On failure, skip all to avoid false positives — safer to leave speech intact
      return [];
    }
  }
}

export const speechCleanupService = new SpeechCleanupService();
