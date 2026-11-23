/**
 * VOICE SAMPLES — a client hears the voice before she picks it (owner, 23 Nov).
 *
 * "What could we put so they can choose once gender and tone is selected for them
 * to hear the different voices they have to choose from?"
 *
 * THE ONE RULE: a sample that does not sound like the finished video is a lie. So
 * this is not a different provider and not a different model — it is the SAME
 * narration path the pipeline speaks a scene with:
 *
 *   POST https://api.openai.com/v1/chat/completions
 *   { model:'gpt-audio', modalities:['text','audio'],
 *     audio:{ voice:<the picked voice>, format:'mp3' },
 *     messages:[ { role:'system', content:<the pipeline's read-aloud instruction
 *                  for this tone> }, { role:'user', content:<the sample line> } ] }
 *
 * The system message is `ttsReadAloudInstruction(tone)` — the EXACT string
 * `generateSceneAudio` sends to gpt-audio for that delivery tone (it carries the
 * tone direction AND the verbatim read-back command; gpt-audio is a chat model and
 * without that command it answers conversationally instead of reading). A sample
 * built from a different instruction would not be the voice the video uses.
 *
 * COST — this is a paid call, and it is bounded:
 *   - only the catalogue's 11 voices x 5 tones are generatable; anything else is a
 *     400 BEFORE any provider is touched (`isCatalogueVoice` / VOICE_TONES);
 *   - generated ONCE, lazily, on first request, then cached in memory + a temp dir
 *     keyed `voice-tone` (Railway's disk is ephemeral: a cache miss after a deploy
 *     simply regenerates);
 *   - it goes through the SAME choke point as every other paid call (`paidCall`,
 *     kind 'audio'), so the attempt telemetry counts it;
 *   - it is REFUSED while a video is rendering (`renderInProgress`) — a sample is
 *     never bought out of a render's window.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { paidCall, renderInProgress } from './paidCallGate.js';
import {
  AUTO_VOICE_CHOICE,
  VOICE_CATALOGUE,
  VOICE_TONES,
  isCatalogueVoice,
  type GptAudioVoice,
  type VoiceTone,
} from './voiceOptions.js';
import { ttsReadAloudInstruction } from './creativeTransformation.js';

/** The spoken line — identical for every voice, so the comparison is fair. */
export const VOICE_SAMPLE_TEXT =
  'Here’s how your video will sound — clear, confident, and ready to post.';

/** What the sample route answers with. */
export const VOICE_SAMPLE_CONTENT_TYPE = 'audio/mpeg';

/**
 * The sample's own paid-call ledger key. It is deliberately NOT a project id: a
 * render can never record a failure against it, and it can never borrow a
 * project's clean ledger.
 */
export const VOICE_SAMPLE_LEDGER_ID = 'voice-sample';

/** The instruction the pipeline would speak this tone with. */
export function voiceSampleInstruction(tone: VoiceTone): string {
  return ttsReadAloudInstruction(tone);
}

/** A request this service refuses, with the HTTP status the route answers. */
export class VoiceSampleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'VoiceSampleError';
  }
}

/** `voice-tone` — the only cache key, and the only thing we ever generate. */
export function voiceSampleCacheKey(voice: GptAudioVoice, tone: VoiceTone): string {
  return `${voice}-${tone}`;
}

/** Generated clips, in-process. The key space is the catalogue: at most 55. */
const memoryCache = new Map<string, Buffer>();

/** Where a generated clip is kept on disk. Overridable so a test can isolate it. */
export function voiceSampleCacheDir(): string {
  return process.env.VOICE_SAMPLE_CACHE_DIR || path.join(os.tmpdir(), 'empirelaunch-voice-samples');
}

/** Test-only: forget the in-process clips (the disk cache is the caller's to clear). */
export function __clearVoiceSampleCache(): void {
  memoryCache.clear();
}

export interface VoiceSampleResult {
  buffer: Buffer;
  contentType: typeof VOICE_SAMPLE_CONTENT_TYPE;
  cacheKey: string;
  /** false on the request that generated it, true when it came from the cache. */
  cached: boolean;
}

/**
 * Generate ONE ~4s clip through the pipeline's own gpt-audio path.
 * Exported so a fixture can drive it with a stubbed `fetch` and read the exact
 * request body that would have been sent.
 */
export async function requestVoiceSampleFromGptAudio(args: {
  voice: GptAudioVoice;
  tone: VoiceTone;
  apiKey: string;
}): Promise<Buffer> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-audio',
      modalities: ['text', 'audio'],
      audio: { voice: args.voice, format: 'mp3' },
      messages: [
        { role: 'system', content: voiceSampleInstruction(args.tone) },
        { role: 'user', content: VOICE_SAMPLE_TEXT },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    throw new VoiceSampleError(502, `GPT Audio ${r.status} — the sample could not be generated`);
  }
  const j: any = await r.json().catch(() => null);
  const data = j?.choices?.[0]?.message?.audio?.data;
  if (!data) throw new VoiceSampleError(502, 'GPT Audio returned no audio for this sample');
  const buffer = Buffer.from(String(data), 'base64');
  if (buffer.length === 0) throw new VoiceSampleError(502, 'GPT Audio returned an empty sample');
  return buffer;
}

/**
 * The sample for one `voice-tone`, from cache when we already have it.
 *
 * Both the voice and the tone are validated FIRST: an unknown value is a 400 with
 * the real list, and nothing is ever bought for it. The 11x5 key space is the
 * cost guard — a client cannot make us speak anything else.
 */
export async function getVoiceSample(
  voiceRaw: unknown,
  toneRaw: unknown,
  opts: { apiKey?: string } = {},
): Promise<VoiceSampleResult> {
  const voiceId = typeof voiceRaw === 'string' ? voiceRaw.trim().toLowerCase() : '';
  if (!isCatalogueVoice(voiceId)) {
    throw new VoiceSampleError(
      400,
      `Unknown voice "${String(voiceRaw ?? '')}". Available voices: ${VOICE_CATALOGUE.map((v) => v.id).join(', ')}.`,
    );
  }
  const tone = (typeof toneRaw === 'string' && toneRaw.trim() !== '' ? toneRaw.trim().toLowerCase() : AUTO_VOICE_CHOICE) as VoiceTone;
  if (!(VOICE_TONES as readonly string[]).includes(tone)) {
    throw new VoiceSampleError(
      400,
      `Unknown tone "${String(toneRaw)}". Available tones: ${VOICE_TONES.join(', ')}.`,
    );
  }

  const cacheKey = voiceSampleCacheKey(voiceId, tone);
  const hit = memoryCache.get(cacheKey);
  if (hit) return { buffer: hit, contentType: VOICE_SAMPLE_CONTENT_TYPE, cacheKey, cached: true };

  const onDisk = path.join(voiceSampleCacheDir(), `${cacheKey}.mp3`);
  try {
    const buf = fs.readFileSync(onDisk);
    if (buf.length > 0) {
      memoryCache.set(cacheKey, buf);
      return { buffer: buf, contentType: VOICE_SAMPLE_CONTENT_TYPE, cacheKey, cached: true };
    }
  } catch { /* no clip on disk yet — generate it below */ }

  // NOTHING IS BOUGHT INSIDE A RENDER'S WINDOW (see the header).
  if (renderInProgress()) {
    throw new VoiceSampleError(503, 'A video is rendering right now — try the voice sample again in a minute.');
  }
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Name our own credential (design principle) — never a bare 500.
    throw new VoiceSampleError(503, 'Voice samples are unavailable: OPENAI_API_KEY is not set on the server.');
  }

  const buffer = await paidCall(
    { projectId: VOICE_SAMPLE_LEDGER_ID, kind: 'audio' },
    () => requestVoiceSampleFromGptAudio({ voice: voiceId, tone, apiKey }),
  );
  memoryCache.set(cacheKey, buffer);
  try {
    fs.mkdirSync(voiceSampleCacheDir(), { recursive: true });
    fs.writeFileSync(onDisk, buffer);
  } catch { /* the disk cache is best-effort; the in-process copy already has it */ }
  return { buffer, contentType: VOICE_SAMPLE_CONTENT_TYPE, cacheKey, cached: false };
}
