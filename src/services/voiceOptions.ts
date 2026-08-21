/**
 * voiceOptions.ts — Shared voiceover configuration for the Customize Video,
 * Faceless, and Scene-Based pipelines.
 *
 * All three boxes expose the SAME voiceover control (gender + tone + auto),
 * and the backend must only surface options it genuinely supports. The voice
 * set + gender/tone→voice mapping below was VERIFIED live against the owner's
 * OpenAI key via POST /v1/chat/completions with { model:'gpt-audio',
 * modalities:['text','audio'], audio:{voice, format:'mp3'} } — every voice
 * returned HTTP 200 with valid audio on 2026-08-21.
 *
 * gpt-audio is an audio CHAT model. It does NOT work at /v1/audio/speech or
 * with tts-* model ids — never send those (both rejected by the key). Always
 * call chat/completions with modalities + audio:{voice,format:'mp3'}.
 */

/** All gpt-audio voices verified available on the owner's key. */
export const GPT_AUDIO_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
] as const;
export type GptAudioVoice = (typeof GPT_AUDIO_VOICES)[number];

/** Gender options surfaced in the UI (each maps to a set of voices). */
export const VOICE_GENDERS = ['female', 'male'] as const;
export type VoiceGender = (typeof VOICE_GENDERS)[number];

/** Tone options surfaced in the UI. 'auto' = let the model match the video vibe. */
export const VOICE_TONES = ['enthusiastic', 'calm', 'serious', 'warm', 'auto'] as const;
export type VoiceTone = (typeof VOICE_TONES)[number];

/** Voiceover config accepted by all three pipelines (optional — omit to skip/use default). */
export interface VoiceoverConfig {
  gender?: VoiceGender;
  tone?: VoiceTone;
}

/**
 * Resolve a (gender, tone) selection to a concrete gpt-audio voice id.
 *
 * Maps:
 *  - female: nova (bright), sage (calm), shimmer (warm), ash (serious)
 *  - male:   echo (confident), fable (warm/calm), onyx (serious/deep), verse (energetic)
 *
 * `tone === 'auto'` (or unknown tone) falls back to a gender default, which the
 * pipeline may leave as the model's natural delivery to "match the video's vibe".
 */
export function resolveVoice(gender?: VoiceGender, tone?: VoiceTone): GptAudioVoice {
  const g = gender === 'male' ? 'male' : 'female';
  const t = tone && tone !== 'auto' ? tone : null;

  const femaleByTone: Partial<Record<VoiceTone, GptAudioVoice>> = {
    enthusiastic: 'nova',
    calm: 'sage',
    warm: 'shimmer',
    serious: 'ash',
  };
  const maleByTone: Partial<Record<VoiceTone, GptAudioVoice>> = {
    enthusiastic: 'verse',
    calm: 'fable',
    warm: 'fable',
    serious: 'onyx',
  };

  if (t) {
    const picked = g === 'male' ? maleByTone[t] : femaleByTone[t];
    if (picked) return picked;
  }
  // Default / auto: one clear female and one clear male voice.
  return g === 'male' ? 'echo' : 'nova';
}

/** Default gpt-audio voice (used when no gender/tone supplied). */
export const DEFAULT_VOICE: GptAudioVoice = 'nova';

/**
 * Build the `audio` payload for the gpt-audio chat/completions call.
 * Always mp3 — verified working and smaller than wav for R2/serving.
 */
export function gptAudioPayload(
  text: string,
  voiceover?: VoiceoverConfig,
): { model: 'gpt-audio'; modalities: ['text', 'audio']; audio: { voice: GptAudioVoice; format: 'mp3' }; messages: [{ role: 'user'; content: string }] } {
  return {
    model: 'gpt-audio',
    modalities: ['text', 'audio'],
    audio: { voice: voiceover ? resolveVoice(voiceover.gender, voiceover.tone) : DEFAULT_VOICE, format: 'mp3' },
    messages: [{ role: 'user', content: text }],
  };
}
