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

/**
 * THE VOICE CATALOGUE (owner, 23 Nov: "there is gender selection ... There also
 * needs to be a Tone selection ... what could we put so they can choose once
 * gender and tone is selected for them to hear the different voices they have to
 * choose from?"). ONE source of truth: the picker's cards, the sample route's
 * validation and `resolveVoice` all read this list, so a voice can never be
 * offered and then silently swapped for another.
 *
 * GENDER SPLIT IS MEASURED, NOT GUESSED — it is the same split asserted by
 * measured f0 in `__tests__/voiceOptions.test.ts` (ash is male-presenting: the
 * owner's recorded MP4 measured median f0 131.1 Hz). Never move a voice across.
 *
 * `character` is ONLY what the ~4s sample clip can back up — pace, brightness,
 * steadiness. No accent, no mood, no "documentary": we cannot hear that in the
 * clip, so we do not claim it.
 */
export interface VoiceCatalogueEntry {
  id: GptAudioVoice;
  gender: VoiceGender;
  name: string;
  character: string;
}

export const VOICE_CATALOGUE: readonly VoiceCatalogueEntry[] = [
  { id: 'nova', gender: 'female', name: 'Nova', character: 'bright, upbeat' },
  { id: 'shimmer', gender: 'female', name: 'Shimmer', character: 'lively, expressive' },
  { id: 'sage', gender: 'female', name: 'Sage', character: 'calm, steady' },
  { id: 'coral', gender: 'female', name: 'Coral', character: 'warm, clear' },
  { id: 'ballad', gender: 'female', name: 'Ballad', character: 'soft, measured' },
  { id: 'echo', gender: 'male', name: 'Echo', character: 'confident, clear' },
  { id: 'verse', gender: 'male', name: 'Verse', character: 'young, energetic' },
  { id: 'fable', gender: 'male', name: 'Fable', character: 'light, cheerful' },
  { id: 'onyx', gender: 'male', name: 'Onyx', character: 'deep, steady' },
  { id: 'ash', gender: 'male', name: 'Ash', character: 'firm, direct' },
  { id: 'alloy', gender: 'male', name: 'Alloy', character: 'even, neutral' },
] as const;

/** Human labels for the gender step. */
export const VOICE_GENDER_LABELS: Record<VoiceGender, string> = { female: 'Female', male: 'Male' };

/** Human labels for the tone step (the delivery direction, not the character). */
export const VOICE_TONE_LABELS: Record<VoiceTone, string> = {
  enthusiastic: 'Enthusiastic',
  calm: 'Calm',
  serious: 'Serious',
  warm: 'Warm',
  auto: 'Auto',
};

/** The picker's default card: no explicit voice — today's gender+tone behaviour. */
export const AUTO_VOICE_CHOICE = 'auto';

/** The voices offered for one gender, in catalogue order. */
export function voicesForGender(gender: VoiceGender): VoiceCatalogueEntry[] {
  return VOICE_CATALOGUE.filter((v) => v.gender === gender);
}

/** True when `value` names a voice this product can actually speak with. */
export function isCatalogueVoice(value: unknown): value is GptAudioVoice {
  return typeof value === 'string' && VOICE_CATALOGUE.some((v) => v.id === value);
}

/** The catalogue entry for a voice id, or undefined when it is not one of ours. */
export function catalogueVoice(id: string): VoiceCatalogueEntry | undefined {
  return VOICE_CATALOGUE.find((v) => v.id === id);
}

/** Voiceover config accepted by all three pipelines (optional — omit to skip/use default). */
export interface VoiceoverConfig {
  gender?: VoiceGender;
  tone?: VoiceTone;
  /**
   * The voice the client PICKED (owner, 23 Nov). Absent or `'auto'` = today's
   * behaviour exactly: gender+tone choose the voice, unchanged for every existing
   * caller and for the launch gate. When present it wins — tone then only shapes
   * how that voice reads.
   */
  voice?: GptAudioVoice | typeof AUTO_VOICE_CHOICE;
}

/**
 * Resolve a (gender, tone) selection to a concrete gpt-audio voice id.
 *
 * Maps (AUDIT 2026-09-21, Defect 2 — owner Faceless test heard a male voice on
 * a female+serious selection). gpt-audio voice sex per OpenAI's own voice
 * descriptions / measured f0:
 *  - female: nova (bright), sage (calm/steady), shimmer (warm), sage (serious)
 *  - male:   echo (confident), fable (warm/calm), onyx (serious/deep), verse (energetic)
 *  - 'ash' is MALE-presenting (firm/confident) — it is NOT a female voice and
 *    must never sit in a female bucket (it previously mapped female+serious →
 *    ash; owner's recorded MP4 measured median f0 131.1 Hz = male range).
 *
 * `tone === 'auto'` (or unknown tone) falls back to a gender default, which the
 * pipeline may leave as the model's natural delivery to "match the video's vibe".
 */
export function resolveVoice(
  gender?: VoiceGender,
  tone?: VoiceTone,
  voice?: GptAudioVoice | typeof AUTO_VOICE_CHOICE | null,
): GptAudioVoice {
  // AN EXPLICIT VOICE WINS (owner, 23 Nov). The client picked the character; the
  // tone now only shapes HOW it reads (ttsToneInstruction / read-aloud direction).
  // Anything not in the catalogue is not a choice we can honour, so it falls back
  // to the gender+tone behaviour below — the route rejects it with a 400 first, so
  // a real request never reaches here with a stray value.
  if (voice && voice !== AUTO_VOICE_CHOICE && isCatalogueVoice(voice)) return voice;
  const g = gender === 'male' ? 'male' : 'female';
  const t = tone && tone !== 'auto' ? tone : null;

  const femaleByTone: Partial<Record<VoiceTone, GptAudioVoice>> = {
    enthusiastic: 'nova',
    calm: 'sage',
    warm: 'shimmer',
    serious: 'sage',
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
/** Spoken-delivery direction passed into the TTS models (task 316d1a2f — the
 *  owner's launch-gate failure heard a flat "recording" read of the raw brief).
 *  'enthusiastic' (and the auto default) get an upbeat, energetic delivery;
 *  calm/serious/warm map to their own directions. Used as the gpt-audio chat
 *  system message and the gpt-4o-mini-tts `instructions` field. */
export function ttsToneInstruction(tone?: VoiceTone): string {
  if (tone === 'calm') return 'Speak in a calm, steady, reassuring tone.';
  if (tone === 'serious') return 'Speak in a serious, confident, professional tone.';
  if (tone === 'warm') return 'Speak in a warm, friendly, inviting tone.';
  if (tone === 'enthusiastic') return 'Speak with bright, energetic enthusiasm — upbeat, lively, and engaging.';
  return 'Speak naturally with a lively, engaging delivery.';
}
/**
 * Owner-LOCKED Faceless mood starter set (do not add/remove — owner-approved
 * 2026-08-24). Feed `mood` into the per-scene prompt so the video's tone
 * reflects it. Backend validation + frontend badge must both use these keys.
 */
export const FACELESS_MOODS = [
  'energetic',
  'sad',
  'calm',
  'romantic',
  'playful',
  'dramatic',
  'inspiring',
] as const;
export type FacelessMood = (typeof FACELESS_MOODS)[number];
/**
 * Owner-LOCKED mood set, shared across Faceless, Scene-Based and Neural Twin
 * (greenlit 2026-08-24). Alias of FACELESS_MOODS so we keep one source of truth;
 * non-faceless paths should reference VIDEO_MOODS. Do NOT change the option set.
 */
export const VIDEO_MOODS = FACELESS_MOODS;
export type VideoMood = (typeof VIDEO_MOODS)[number];
/** Build a hint string that folds a validated mood into a generation prompt. Empty when none. */
export function moodHintToString(mood?: string): string {
  if (!mood || String(mood).trim() === '' || String(mood).toLowerCase() === 'auto') return '';
  return ` Use a ${String(mood).toLowerCase()} mood across every scene and the narration.`;
}
/** True if the given value is a valid VIDEO_MOODS entry. */
export function isValidMood(value: unknown): value is VideoMood {
  return typeof value === 'string' && (VIDEO_MOODS as readonly string[]).includes(value.toLowerCase());
}
/** Allowed Faceless durations (seconds). Others are rejected at the gate. */
export const FACELESS_DURATIONS = [10, 15, 30] as const;
export type FacelessDuration = (typeof FACELESS_DURATIONS)[number];
/** Default Faceless duration when none supplied. */
export const DEFAULT_FACELESS_DURATION: FacelessDuration = 15;
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
    audio: { voice: voiceover ? resolveVoice(voiceover.gender, voiceover.tone, voiceover.voice) : DEFAULT_VOICE, format: 'mp3' },
    messages: [{ role: 'user', content: text }],
  };
}

/**
 * MOOD → SPOKEN-DELIVERY TONE (owner Nov 12: "pick Calm and the read is still
 * the default lively one" — the mood reached the planner prompt but never the
 * voice). The Faceless box sends `mood` (energetic|sad|calm|romantic|playful|
 * dramatic|inspiring) and `tone`; an EXPLICIT tone always wins, otherwise the
 * mood decides the delivery so the chosen mood is actually heard.
 *
 * Mapping is the delivery equivalent of each mood (VoiceTone only carries
 * enthusiastic|calm|serious|warm): a calm/sad video is read calmly, a
 * romantic/inspiring one warmly, a dramatic one seriously, and
 * energetic/playful with enthusiasm. No mood and no tone → 'auto' (the model's
 * natural lively default — the pre-existing behaviour, unchanged).
 */
export function resolveDeliveryTone(tone?: VoiceTone, mood?: string): VoiceTone {
  // An explicit tone is the client's own instruction — never overridden by mood.
  if (tone && tone !== 'auto') return tone;
  const m = String(mood || '').trim().toLowerCase();
  const byMood: Partial<Record<FacelessMood, VoiceTone>> = {
    calm: 'calm',
    sad: 'calm',
    romantic: 'warm',
    inspiring: 'warm',
    dramatic: 'serious',
    energetic: 'enthusiastic',
    playful: 'enthusiastic',
  };
  return byMood[m as FacelessMood] ?? 'auto';
}

/** One card in the picker: the voice, two or three words of character, and the
 *  URL that plays ~4s of THAT voice in the tone the client chose. */
export interface VoiceCatalogueCard {
  id: GptAudioVoice;
  name: string;
  character: string;
  /** Relative to the API host — the tone is appended by the picker as ?tone=… */
  sampleUrl: string;
}

export interface VoiceCataloguePayload {
  genders: { id: VoiceGender; label: string; voices: VoiceCatalogueCard[] }[];
  tones: { id: VoiceTone; label: string }[];
  defaultVoice: typeof AUTO_VOICE_CHOICE;
}

/** The sample URL for a voice (tone is a query param the picker adds). */
export function voiceSampleUrl(voice: GptAudioVoice): string {
  return `/api/voices/${voice}/sample`;
}

/**
 * `GET /api/voices` — the picker's whole catalogue, built from the one list
 * above. No provider call, no DB read: this route can never cost anything.
 */
export function voiceCataloguePayload(): VoiceCataloguePayload {
  return {
    genders: VOICE_GENDERS.map((gender) => ({
      id: gender,
      label: VOICE_GENDER_LABELS[gender],
      voices: voicesForGender(gender).map((v) => ({
        id: v.id,
        name: v.name,
        character: v.character,
        sampleUrl: voiceSampleUrl(v.id),
      })),
    })),
    tones: VOICE_TONES.map((tone) => ({ id: tone, label: VOICE_TONE_LABELS[tone] })),
    defaultVoice: AUTO_VOICE_CHOICE,
  };
}

/**
 * Read a client's PICKED voice off a request. Three outcomes, and no fourth:
 *   - absent / empty / 'auto' → `{ ok: true, voice: undefined }` — today's
 *     gender+tone behaviour, unchanged (the picker's default card);
 *   - a voice in the catalogue → that voice;
 *   - anything else → `{ ok: false }` with the real list, so the route answers 400.
 * NEVER a silent swap: a voice she did not choose is not a voice she chose.
 */
export function parseVoiceChoice(
  raw: unknown,
): { ok: true; voice?: GptAudioVoice } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  const value = String(raw).trim().toLowerCase();
  if (value === '' || value === AUTO_VOICE_CHOICE) return { ok: true };
  if (isCatalogueVoice(value)) return { ok: true, voice: value };
  return {
    ok: false,
    error: `Unknown voice "${String(raw)}". Available voices: ${VOICE_CATALOGUE.map((v) => v.id).join(', ')}.`,
  };
}
