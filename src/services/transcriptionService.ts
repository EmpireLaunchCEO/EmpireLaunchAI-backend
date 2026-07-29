import fs from 'fs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WordTimestamp {
  text: string;
  start: number;  // seconds
  end: number;    // seconds
  confidence: number; // 0-1
}

export interface TranscriptionResult {
  fullText: string;
  words: WordTimestamp[];
  language?: string;
  duration?: number;
}

// ─── Transcription Service ──────────────────────────────────────────────────

/**
 * Transcribes audio using OpenAI Whisper API.
 * Returns word-level timestamps for precise editing decisions.
 */
export class TranscriptionService {
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Transcribe an audio file and return word-level timestamps.
   * Falls back gracefully — returns null on failure rather than blocking the edit.
   */
  async transcribe(audioPath: string): Promise<TranscriptionResult | null> {
    if (!this.isConfigured) {
      console.warn('[TranscriptionService] OPENAI_API_KEY not configured');
      return null;
    }

    if (!fs.existsSync(audioPath)) {
      console.warn(`[TranscriptionService] Audio file not found: ${audioPath}`);
      return null;
    }

    try {
      const formData = new FormData();
      const file = new Blob([fs.readFileSync(audioPath)], { type: 'audio/mp3' });
      formData.append('file', file, 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities', '["word"]');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(120000), // 2 min timeout for long audio
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[TranscriptionService] Whisper API error (${response.status}):`, errBody);
        return null;
      }

      const data = await response.json();

      // Parse word-level timestamps
      const words: WordTimestamp[] = (data.words || []).map((w: any) => ({
        text: w.word?.trim() || '',
        start: w.start || 0,
        end: w.end || 0,
        confidence: w.confidence || 0,
      }));

      console.log(`[TranscriptionService] Transcribed ${words.length} words in ${data.duration || 0}s`);

      return {
        fullText: data.text || '',
        words,
        language: data.language,
        duration: data.duration,
      };
    } catch (err: any) {
      console.warn('[TranscriptionService] Transcription failed:', err.message);
      return null;
    }
  }

  /**
   * Group word timestamps into phrases (sentences/clauses) based on pauses.
   * A pause > 0.4s between words indicates a phrase boundary.
   */
  groupIntoPhrases(words: WordTimestamp[], maxPauseSeconds: number = 0.4): Array<{
    text: string;
    words: WordTimestamp[];
    start: number;
    end: number;
  }> {
    const phrases: Array<{ text: string; words: WordTimestamp[]; start: number; end: number }> = [];
    if (words.length === 0) return phrases;

    let currentPhrase: WordTimestamp[] = [words[0]];

    for (let i = 1; i < words.length; i++) {
      const gap = words[i].start - words[i - 1].end;
      if (gap > maxPauseSeconds) {
        // End current phrase, start new one
        phrases.push({
          text: currentPhrase.map(w => w.text).join(' '),
          words: [...currentPhrase],
          start: currentPhrase[0].start,
          end: currentPhrase[currentPhrase.length - 1].end,
        });
        currentPhrase = [words[i]];
      } else {
        currentPhrase.push(words[i]);
      }
    }

    // Push final phrase
    if (currentPhrase.length > 0) {
      phrases.push({
        text: currentPhrase.map(w => w.text).join(' '),
        words: [...currentPhrase],
        start: currentPhrase[0].start,
        end: currentPhrase[currentPhrase.length - 1].end,
      });
    }

    return phrases;
  }
}

export const transcriptionService = new TranscriptionService();
