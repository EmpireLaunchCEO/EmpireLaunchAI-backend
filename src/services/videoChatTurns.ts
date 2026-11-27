/**
 * A REFUSAL IS A CONVERSATION (owner, 23 Nov).
 *
 * Owner's words:
 *   "if the preflight check didn't clear, then the AI should go back in the video chat
 *    and state what the issue with the video is......and ask the client how it wants it
 *    to be fixed, what the client responds in the AI chat needs to be carried through to
 *    the video with what was previously given as well"
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The ONE place that turns a refusal into a chat turn, and the ONE place that turns a
 * chat back into the planner's input:
 *
 *   buildRefusalAsk()            a pre-flight check → ONE assistant turn: the issue in
 *                                plain words, "this video wasn't made", and ONE
 *                                specific question with the REAL options. A check the
 *                               client cannot resolve says so instead of asking.
 *   assembleVideoChat()          the whole conversation for that video: her original
 *                                brief, every earlier turn, the assistant's question,
 *                                her answer — plus the original selections.
 *   buildPlannerConversationSection()  that conversation as the planner reads it, with
 *                                her answer marked as the deciding instruction.
 *   applyAnswerToSelections()    what her answer CHANGES (a length she named, a photo
 *                                she said to leave out) applied before the next
 *                                pre-flight, so the answer changes the video and is
 *                                not just carried along.
 *
 * NEVER MENTION MONEY (owner, 23 Nov):
 *   "I wouldn't say nothing was made and nothing was charged. they may think their being
 *    charged on top of what they pay monthly. so leave out any charges or being charged,
 *    or not charged, to the clients."
 * Every string this module produces is scanned by `moneyWordsIn()` — the fixture asserts
 * it, so no future refusal copy can quietly add a money sentence.
 *
 * PURE: no I/O, no provider, no database. The pipeline persists what this returns.
 */
import { GPT_AUDIO_VOICES, VOICE_CATALOGUE, VOICE_TONES, VOICE_TONE_LABELS } from './voiceOptions.js';
import { FACELESS_LEGAL_LENGTHS, type CostPreflightCheck } from './costPreflight.js';
import type { TQuestion } from './retryThenAsk.js';

/** One turn in a video's chat. `kind` is for us and the UI, never spoken to the client. */
export interface VideoChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** What this turn is, so the planner and the UI can tell them apart. */
  kind?: 'brief' | 'refusal-question' | 'client-answer' | 'chat';
  /** The real options the assistant's question offered (assistant refusal turns only). */
  options?: string[];
  /** Which pre-flight check asked (assistant refusal turns only). */
  check?: string;
  /** ISO time the turn was written. */
  at?: string;
}

/** The selections the client made for this video — the contract the answer rides on. */
export interface VideoSelections {
  duration?: number;
  voice?: string;
  voiceId?: string;
  tone?: string;
  mood?: string;
  sourceImages?: string[];
}

/** A refusal as it goes into the chat: the turn to store, and whether it asks anything. */
export interface RefusalTurn {
  turn: VideoChatTurn;
  /** The one question (empty when the client cannot resolve it). */
  ask: TQuestion;
}

/**
 * The words that must never appear in anything a client reads: they pay one monthly
 * subscription, and a sentence about charging reads as an extra charge on top of it.
 */
const MONEY_WORDS = [
  'charge', 'charged', 'charging', 'cost', 'costs', 'costing', 'price', 'priced', 'pricing',
  'refund', 'refunded', 'refunded', 'pay', 'paid', 'payment', 'billing', 'billed', 'bill',
  'money', 'dollar', 'dollars', 'usd', 'fee', 'fees', 'quota', 'subscription', 'invoice',
];

/** Every money word in a client-facing string — empty means the copy is clean. */
export function moneyWordsIn(text: string): string[] {
  const lower = String(text || '').toLowerCase();
  const hits = MONEY_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(lower));
  if (/\$\s*\d|\d\s*\$/.test(lower)) hits.push('$');
  return hits;
}

/** "This video wasn't made." — the one sentence a refusal always carries. */
export const NOT_MADE_SENTENCE = "This video wasn't made.";

/** Trim a pre-flight reason down to the ISSUE, without its "so it was not started" tail. */
export function plainIssue(reason: string): string {
  const head = String(reason || '').split(' — ')[0].trim();
  return head.replace(/[.\s]+$/, '');
}

/** The options the client can genuinely pick for a voice. */
function voiceOptions(): string[] {
  return VOICE_CATALOGUE.map((v) => `${v.name} (${v.gender})`);
}

/** The tone options, in the client's words. */
function toneOptions(): string[] {
  return VOICE_TONES.map((t) => VOICE_TONE_LABELS[t]);
}

/**
 * What ONE pre-flight check says in the chat. Each entry is the specific question with
 * the REAL options — never "please try again".
 *
 * `resolvable: false` is for what an answer from the client cannot fix: our machine, our
 * credentials, a provider outage. Those say why, and ask nothing.
 */
export function buildRefusalAsk(input: {
  check?: CostPreflightCheck | string;
  reason?: string;
  /** The file name of her upload, when the refusal is about it. */
  photoName?: string;
  at?: string;
}): RefusalTurn {
  const check = String(input.check || '');
  const issue = plainIssue(input.reason || 'This video could not be made.');
  const at = input.at || new Date().toISOString();
  const turn = (question: string, options: string[], resolvable: boolean): RefusalTurn => {
    const content = [issue ? `${issue}.` : '', NOT_MADE_SENTENCE, question].filter(Boolean).join(' ').replace(/\.\./g, '.');
    return {
      ask: { issue, question, options: resolvable ? options : [], resolvable },
      turn: {
        role: 'assistant',
        content,
        kind: 'refusal-question',
        ...(resolvable ? { options } : {}),
        check,
        at,
      },
    };
  };

  switch (check) {
    case 'photo': {
      const name = input.photoName && input.photoName !== 'the photo you uploaded' ? input.photoName : 'the photo';
      return turn(
        `Do you want to upload ${name} again, or should I make the video without it?`,
        ['Upload the photo again', 'Make the video without the photo'],
        true,
      );
    }
    case 'duration': {
      const options = FACELESS_LEGAL_LENGTHS.map((n) => `${n} seconds`);
      return turn(`Which length do you want: ${FACELESS_LEGAL_LENGTHS.join(', ')} seconds?`, options, true);
    }
    case 'voice':
      return turn('Which voice should I use instead?', voiceOptions(), true);
    case 'tone':
      return turn('Which tone should I use instead?', toneOptions(), true);
    case 'quota':
      // Nothing she can say changes this one — say so, ask nothing.
      return turn('', [], false);
    case 'ffmpeg':
    case 'workdir':
      // Our machine, not her brief. An answer from her cannot help, so we do not ask.
      return turn('', [], false);
    default:
      return turn('', [], false);
  }
}

/**
 * A refusal from the component gate: something she asked for could not be placed in the
 * plan. That IS resolvable — she can drop it or rephrase it — so it asks, with her own
 * item named.
 */
export function componentRefusalAsk(missing: string[], at?: string): RefusalTurn {
  const items = (missing || []).filter(Boolean);
  const named = items.length === 1 ? `"${items[0]}"` : `these: ${items.map((i) => `"${i}"`).join(', ')}`;
  const issue = `I couldn't find a place in the video for ${named}`;
  const question = items.length === 1
    ? `Should I leave it out, or would you like to say it a different way?`
    : 'Should I leave them out, or would you like to say them a different way?';
  const options = ['Leave it out', 'Say it a different way'];
  return {
    ask: { issue, question, options, resolvable: true },
    turn: {
      role: 'assistant',
      content: `${issue}. ${NOT_MADE_SENTENCE} ${question}`,
      kind: 'refusal-question',
      options,
      check: 'components',
      at: at || new Date().toISOString(),
    },
  };
}

/** What a refused attempt stores on its row: the chat, her selections, and whether it
 *  is still waiting for an answer (so the next attempt can pick it up). */
export interface StoredVideoChat {
  turns: VideoChatTurn[];
  selections?: VideoSelections;
  awaitingAnswer?: boolean;
  question?: TQuestion | null;
}

/** Read the stored chat off a project row's metadata. Anything malformed is "no chat". */
export function storedChatFromMetadata(metadata: unknown): StoredVideoChat | null {
  const chat = (metadata as any)?.chat;
  if (!chat || !Array.isArray(chat.turns)) return null;
  const turns = chat.turns.filter(
    (t: any) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim(),
  );
  if (!turns.length) return null;
  return {
    turns,
    selections: chat.selections && typeof chat.selections === 'object' ? chat.selections : undefined,
    awaitingAnswer: chat.awaitingAnswer === true,
    question: chat.question && typeof chat.question === 'object' ? chat.question : null,
  };
}

/** The block a refusal writes onto the failed row, in one shape. */
export function chatMetadata(chat: {
  turns: VideoChatTurn[];
  awaitingAnswer: boolean;
  selections?: VideoSelections;
  question?: TQuestion | null;
}): { turns: VideoChatTurn[]; awaitingAnswer: boolean; selections?: VideoSelections; question?: TQuestion | null } {
  return {
    turns: chat.turns,
    awaitingAnswer: chat.awaitingAnswer,
    ...(chat.selections ? { selections: chat.selections } : {}),
    ...(chat.question ? { question: chat.question } : {}),
  };
}

/** The question an unresolved refusal asked, read back from a stored chat. */
export function pendingQuestion(turns: VideoChatTurn[] | undefined): VideoChatTurn | undefined {
  return (turns || []).filter((t) => t.role === 'assistant' && t.kind === 'refusal-question').slice(-1)[0];
}

function turnKey(t: { role?: string; content?: string }): string {
  return `${t.role || ''}\u0000${String(t.content || '').trim()}`;
}

/**
 * THE WHOLE CONVERSATION FOR THIS VIDEO. Her earlier turns and the assistant's question
 * come first, her answer comes last — and an answer already present in the incoming
 * conversation is never duplicated, so the planner reads each thing once.
 *
 * `answer` is what the client said back to the refusal. When the caller does not name
 * one, the last user turn that is NOT part of the earlier conversation IS the answer —
 * "what the client responds in the AI chat" needs no extra field to be carried through.
 */
export function assembleVideoChat(input: {
  /** Turns stored with the refused attempt (earlier chat + the assistant's question). */
  prior?: VideoChatTurn[];
  /** The conversation this request carries, as the client sent it. */
  incoming?: Array<{ role?: string; content?: unknown }>;
  /** Her reply to the question, when the caller knows it explicitly. */
  answer?: string;
  /** Her original brief, when it is not already among the turns. */
  brief?: string;
}): { turns: VideoChatTurn[]; answer: string | null; answered: boolean; question: VideoChatTurn | null } {
  const prior = (input.prior || [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .map((t) => ({ ...t }));
  const incoming = (input.incoming || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content), kind: 'chat' as const }));

  // Her brief leads the conversation — the thing every later turn is about.
  const brief = (input.brief || '').trim();
  const turns: VideoChatTurn[] = [];
  const seen = new Set<string>();
  const push = (t: VideoChatTurn) => {
    const key = turnKey(t);
    if (!t.content.trim() || seen.has(key)) return;
    seen.add(key);
    turns.push(t);
  };
  if (brief) push({ role: 'user', content: brief, kind: 'brief' });
  for (const t of prior) push(t);
  // The assistant's question stays AFTER the earlier chat, even if a stored order got it
  // wrong: it is what her answer replies to.
  const question = pendingQuestion(prior) || null;
  const priorUserKeys = new Set(prior.filter((t) => t.role === 'user').map(turnKey));
  const newUserTurns = incoming.filter((m) => m.role === 'user' && !priorUserKeys.has(turnKey(m)));
  for (const t of incoming) {
    if (t.role === 'assistant' && question && turnKey(t) === turnKey(question)) continue;
    push(t);
  }
  const explicit = typeof input.answer === 'string' ? input.answer.trim() : '';
  const derived = newUserTurns.length ? newUserTurns[newUserTurns.length - 1].content.trim() : '';
  const answer = explicit || derived || null;
  if (answer) {
    // Her answer is the LAST turn — it is what the plan must obey.
    const already = turns.some((t) => t.role === 'user' && t.content.trim() === answer);
    if (!already) push({ role: 'user', content: answer, kind: 'client-answer' });
    else {
      const idx = turns.findIndex((t) => t.role === 'user' && t.content.trim() === answer);
      if (idx >= 0) turns[idx] = { ...turns[idx], kind: 'client-answer' };
    }
  }
  return { turns, answer, answered: Boolean(answer), question };
}

/** Every length the client named in her answer, in seconds (10/15/30 for Faceless). */
export function lengthFromAnswer(answer: string): number | null {
  const text = String(answer || '');
  const named = text.match(/\b(10|15|30|20|25|40|45|60)\s*(?:seconds|second|secs|sec|s)\b/i);
  if (named) return Number(named[1]);
  return null;
}

/** Did her answer say to leave the photo out? (Only plain phrasings — never guessed.) */
export function answerDropsPhoto(answer: string): boolean {
  const text = String(answer || '').toLowerCase();
  if (!text) return false;
  return (
    /\bwithout (it|the photo|the picture|my photo|my picture|the image|any photo)\b/.test(text)
    || /\b(leave|leaving) (it|the photo|the picture) out\b/.test(text)
    || /\b(no|skip|drop|remove) (the |my )?(photo|picture|image)\b/.test(text)
    || /\bdon'?t use (it|the photo|the picture|my photo)\b/.test(text)
    || /\bmake (the video|it) without\b/.test(text)
  );
}

/** The voice id her answer names, if it names one ("use Nova", "the male voice"). */
export function voiceFromAnswer(answer: string): string | null {
  const text = String(answer || '').toLowerCase();
  for (const voice of VOICE_CATALOGUE) {
    if (new RegExp(`\\b${voice.id}\\b`, 'i').test(text)) return voice.id;
  }
  for (const voice of GPT_AUDIO_VOICES) {
    if (new RegExp(`\\b${voice}\\b`, 'i').test(text)) return voice;
  }
  return null;
}

/** The tone her answer names, if it names one. */
export function toneFromAnswer(answer: string): string | null {
  const text = String(answer || '').toLowerCase();
  for (const tone of VOICE_TONES) {
    if (tone === 'auto') continue;
    if (new RegExp(`\\b${tone}\\b`, 'i').test(text)) return tone;
  }
  return null;
}

/**
 * HER ANSWER CHANGES THE NEXT ATTEMPT. A reply that is only carried along is the same
 * defect as a question never asked, so the parts of the answer that are unambiguous are
 * applied to the request BEFORE the next pre-flight runs: a length she names, a voice or
 * tone she names, and "make it without the photo".
 *
 * Only what she actually said is applied — anything ambiguous is left to the planner,
 * which reads her answer in the conversation section. Nothing is defaulted.
 */
export function applyAnswerToSelections(
  answer: string | null | undefined,
  selections: VideoSelections,
): { selections: VideoSelections; applied: string[] } {
  const applied: string[] = [];
  const next: VideoSelections = { ...selections };
  if (!answer) return { selections: next, applied };
  const length = lengthFromAnswer(answer);
  if (length && length !== selections.duration) {
    next.duration = length;
    applied.push(`duration=${length}`);
  }
  const voice = voiceFromAnswer(answer);
  if (voice && voice !== selections.voiceId) {
    next.voiceId = voice;
    applied.push(`voiceId=${voice}`);
  }
  const tone = toneFromAnswer(answer);
  if (tone && tone !== selections.tone) {
    next.tone = tone;
    applied.push(`tone=${tone}`);
  }
  if (answerDropsPhoto(answer) && (selections.sourceImages || []).length) {
    next.sourceImages = [];
    applied.push('sourceImages=[]');
  }
  return { selections: next, applied };
}

/**
 * THE PLANNER READS THE CONVERSATION (owner, 23 Nov — "what the client responds in the AI
 * chat needs to be carried through to the video with what was previously given as well").
 * Every turn, in order, with the question and her answer named as such, plus the
 * selections that still stand. Empty when there is nothing to say, so a first launch's
 * prompt is unchanged.
 */
export function buildPlannerConversationSection(
  turns: VideoChatTurn[],
  selections?: VideoSelections,
  options?: { answered?: boolean },
): string {
  const usable = (turns || []).filter((t) => t && typeof t.content === 'string' && t.content.trim());
  const selectionLines: string[] = [];
  const sel = selections || {};
  if (Number.isFinite(Number(sel.duration)) && Number(sel.duration) > 0) selectionLines.push(`length: ${sel.duration} seconds`);
  if (sel.voiceId) selectionLines.push(`voice: ${sel.voiceId}`);
  else if (sel.voice) selectionLines.push(`voice: ${sel.voice}`);
  if (sel.tone) selectionLines.push(`tone: ${sel.tone}`);
  if (sel.mood) selectionLines.push(`mood: ${sel.mood}`);
  const photos = sel.sourceImages || [];
  if (photos.length) selectionLines.push(`her uploaded photo is used (${photos.length} photo${photos.length === 1 ? '' : 's'})`);
  else if (sel.sourceImages) selectionLines.push('no uploaded photo (she chose to make it without one)');

  if (!usable.length && !selectionLines.length) return '';

  const lines = usable.map((t, i) => {
    const who = t.role === 'user' ? 'CLIENT' : 'YOU (the assistant)';
    const label = t.kind === 'refusal-question'
      ? ' — the question you asked her about this video'
      : t.kind === 'client-answer'
        ? ' — her ANSWER to your question'
        : t.kind === 'brief'
          ? ' — her brief for this video'
          : '';
    const opts = t.options?.length ? ` [options offered: ${t.options.join(' | ')}]` : '';
    return `${i + 1}. ${who}${label}: "${t.content.replace(/\s+/g, ' ').trim()}"${opts}`;
  });

  const answered = options?.answered ?? usable.some((t) => t.kind === 'client-answer');
  const asked = usable.some((t) => t.kind === 'refusal-question');
  const questionClause = asked
    ? ` including a question we asked her and ${answered ? 'her answer to it' : 'no answer from her yet'}.${answered ? ' HER ANSWER IS THE DECIDING INSTRUCTION — where it changes something (a length, a voice, a tone, a photo to leave out, wording to drop), apply it to the plan, and never repeat a question she has already answered.' : ''}`
    : '';
  return `\n\nTHE CONVERSATION FOR THIS VIDEO (mandatory): everything said about this video, oldest first${asked ? '' : ', so nothing she already said is asked again or dropped'}.${questionClause} Read ALL of it: her earlier turns are still part of the brief. This is CONTEXT to obey — never text to speak, never a line of narration, never on-screen text.\n${lines.join('\n')}${selectionLines.length ? `\n\nHER SELECTIONS FOR THIS VIDEO (still stand unless her answer changes them): ${selectionLines.join('; ')}.` : ''}\n`;
}

/**
 * WHAT A REFUSAL HANDS THE CLIENT'S UI (owner, 23 Nov — the question belongs in the chat).
 *
 * `err.chat.turns` is the WHOLE conversation for that video: her brief, every earlier
 * turn, and the question we just asked. Her earlier messages are already on her screen,
 * so sending them back duplicates them in her chat. This returns ONLY what is new — the
 * question we asked and any answer of hers to it — as a plain array, which is the shape
 * the Studio chat renders (each turn keeps its `options` so the choices are tappable).
 *
 * Returns `{}` when the error carries no chat at all, so the caller spreads it and the
 * response shape is unchanged for every failure that asks nothing.
 */
export function refusalChatPayload(
  chat: { turns?: VideoChatTurn[]; awaitingAnswer?: boolean } | null | undefined,
): { chat?: VideoChatTurn[]; awaitingAnswer?: boolean } {
  const turns = Array.isArray(chat?.turns) ? chat!.turns : [];
  const own = turns.filter((t) => t?.kind === 'refusal-question' || t?.kind === 'client-answer');
  return own.length ? { chat: own, awaitingAnswer: chat!.awaitingAnswer === true } : {};
}
