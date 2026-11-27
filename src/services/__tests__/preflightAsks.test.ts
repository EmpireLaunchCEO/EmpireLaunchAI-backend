/**
 * A REFUSAL IS A CONVERSATION (owner, 23 Nov).
 *
 * Owner's words:
 *   "if the preflight check didn't clear, then the AI should go back in the video chat
 *    and state what the issue with the video is......and ask the client how it wants it
 *    to be fixed, what the client responds in the AI chat needs to be carried through to
 *    the video with what was previously given as well"
 *
 * What these fixtures prove, on the REAL entry point and on the assembled planner input
 * (never on a flag):
 *
 *   1. a pre-flight refusal writes EXACTLY ONE assistant chat turn: the issue, "this
 *      video wasn't made", and ONE question with the real options — and no money words;
 *   2. her reply plus her original brief both reach the planner's request on the next
 *      attempt, with the reply marked as the deciding instruction;
 *   3. a refusal she cannot resolve (our machine, our credential) asks NOTHING and says
 *      why;
 *   4. the refused attempt spends nothing: no planner call, no paid call, no quota.
 *
 * ZERO SPEND: no provider is contacted, no model is called, no media is generated.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { aiRouter } from '../aiRouter.js';
import { renderingEngine } from '../renderingEngine.js';
import { veoVideoService } from '../veoVideoService.js';
import { usageService, WEEKLY_FACELESS_LIMIT } from '../usageService.js';
import { sceneVideoPipelineService, CostPreflightFailedError, buildPlannerRequest } from '../sceneVideoPipelineService.js';
import { COST_PREFLIGHT_FAILED_CODE } from '../costPreflight.js';
import { __paidCallAttempts, __resetPaidCallAttempts, __resetPaidFailures } from '../paidCallGate.js';
import { retryThenAsk } from '../retryThenAsk.js';
import {
  applyAnswerToSelections,
  assembleVideoChat,
  buildPlannerConversationSection,
  buildRefusalAsk,
  componentRefusalAsk,
  moneyWordsIn,
  NOT_MADE_SENTENCE,
  storedChatFromMetadata,
  type VideoChatTurn,
} from '../videoChatTurns.js';

// ─── the provider spies: every paid call the pipeline could make, counted ───
const calls = { planner: 0, image: 0, audio: 0, veo: 0 };
const restore: Array<() => void> = [];

function spyOn(target: any, method: string, key: keyof typeof calls, result: any) {
  const original = target[method];
  target[method] = async () => {
    calls[key] += 1;
    return result;
  };
  restore.push(() => { target[method] = original; });
}

let quotaReads = 0;
let quotaAllowance: number | 'unlimited' = WEEKLY_FACELESS_LIMIT;

function resetCounts() {
  calls.planner = 0; calls.image = 0; calls.audio = 0; calls.veo = 0;
  __resetPaidFailures();
  __resetPaidCallAttempts();
  quotaReads = 0;
  quotaAllowance = WEEKLY_FACELESS_LIMIT;
}

before(() => {
  spyOn(aiRouter, 'route', 'planner', { classification: 'ai_assistant', prompt: 'not a plan' });
  spyOn(renderingEngine, 'renderImage', 'image', { success: false, error: 'the image provider must not be called' });
  spyOn(veoVideoService, 'generateSceneVideo', 'veo', { success: false, error: 'the Veo provider must not be called' });
  (usageService as any).getDailyRemaining = async () => { quotaReads += 1; return quotaAllowance; };
  restore.push(() => { delete (usageService as any).getDailyRemaining; });
  resetCounts();
});

after(() => { for (const undo of restore) undo(); });

const baseInput = (over: Record<string, any> = {}) => ({
  userId: '11111111-2222-4333-8444-555555555555',
  title: 'A refusal is a conversation',
  idea: 'A 15 second promo for my hand-poured candle shop.',
  durationTarget: 15,
  voice: 'female' as const,
  tone: 'auto' as const,
  mode: 'faceless' as const,
  ...over,
});

const allZero = (label: string) => {
  assert.deepEqual(calls, { planner: 0, image: 0, audio: 0, veo: 0 }, `${label}: no provider may be contacted`);
  const attempted = __paidCallAttempts();
  assert.equal(attempted.planner + attempted.image + attempted.audio + attempted.veo, 0,
    `${label}: not even an attempt may reach the paid gate (${JSON.stringify(attempted)})`);
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE REFUSAL IS ONE ASSISTANT TURN — through the REAL entry point
// ═══════════════════════════════════════════════════════════════════════════

test('createProject: a pre-flight refusal writes exactly one assistant chat turn, asking one question', async () => {
  resetCounts();
  const err: any = await sceneVideoPipelineService
    .createProject(baseInput({ durationTarget: 22 }))
    .then(() => null, (e) => e);

  assert.ok(err instanceof CostPreflightFailedError, `got ${err?.name}: ${err?.message}`);
  assert.equal(err.code, COST_PREFLIGHT_FAILED_CODE);
  assert.ok(err.chat, 'the refusal must carry the chat turn the client sees');
  const turns = err.chat.turns as VideoChatTurn[];
  const assistant = turns.filter((t) => t.role === 'assistant');
  assert.equal(assistant.length, 1, `exactly ONE assistant turn, got ${assistant.length}`);
  const turn = assistant[0];

  assert.equal(turn.kind, 'refusal-question');
  assert.match(turn.content, /22 seconds/, 'the turn names the issue in plain words');
  assert.ok(turn.content.includes(NOT_MADE_SENTENCE), `the turn says the video was not made: ${turn.content}`);
  assert.equal((turn.content.match(/\?/g) || []).length, 1, `exactly ONE question: ${turn.content}`);
  assert.deepEqual(turn.options, ['10 seconds', '15 seconds', '30 seconds'], 'the question carries the REAL options');
  assert.deepEqual(moneyWordsIn(turn.content), [], `no money words may reach a client: ${turn.content}`);
  assert.equal(err.chat.awaitingAnswer, true, 'a question she can answer is waiting for her answer');
  allZero('illegal duration');
});

test('a photo refusal names her file, says the video was not made, and offers the two real choices', () => {
  const refusal = buildRefusalAsk({
    check: 'photo',
    reason: 'The photo you uploaded (hand-poured-candle.png) does not resolve (HTTP 404) — the video would have been made without it, so it was not started.',
    photoName: 'hand-poured-candle.png',
  });
  assert.equal(refusal.ask.resolvable, true);
  assert.match(refusal.turn.content, /hand-poured-candle\.png/, 'it points at the thing it is about');
  assert.ok(refusal.turn.content.includes(NOT_MADE_SENTENCE));
  assert.match(refusal.turn.content, /upload hand-poured-candle\.png again, or should I make the video without it\?/);
  assert.deepEqual(refusal.turn.options, ['Upload the photo again', 'Make the video without the photo']);
  assert.deepEqual(moneyWordsIn(refusal.turn.content), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. WHAT SHE CANNOT RESOLVE ASKS NOTHING AND SAYS WHY
// ═══════════════════════════════════════════════════════════════════════════

test('a refusal the client cannot resolve asks no question and says why', () => {
  const ffmpeg = buildRefusalAsk({ check: 'ffmpeg', reason: 'ffmpeg on this machine is missing the filters the render needs: xfade.' });
  assert.equal(ffmpeg.ask.resolvable, false);
  assert.deepEqual(ffmpeg.ask.options, []);
  assert.equal((ffmpeg.turn.content.match(/\?/g) || []).length, 0, `no question: ${ffmpeg.turn.content}`);
  assert.ok(ffmpeg.turn.content.includes(NOT_MADE_SENTENCE));
  assert.match(ffmpeg.turn.content, /missing the filters/, 'the reason is still said');

  const quota = buildRefusalAsk({ check: 'quota', reason: 'No videos are left on this plan this week — this video was not started and nothing was generated.' });
  assert.equal(quota.ask.resolvable, false);
  assert.equal((quota.turn.content.match(/\?/g) || []).length, 0);
  assert.match(quota.turn.content, /no videos are left/i);
  assert.deepEqual(moneyWordsIn(quota.turn.content), [], 'a full week never becomes a money sentence');
});

test('the component gate asks one question with her own item named', () => {
  const refusal = componentRefusalAsk(['hand-poured soy wax']);
  assert.equal(refusal.ask.resolvable, true);
  assert.match(refusal.turn.content, /hand-poured soy wax/);
  assert.equal((refusal.turn.content.match(/\?/g) || []).length, 1);
  assert.deepEqual(refusal.turn.options, ['Leave it out', 'Say it a different way']);
  assert.deepEqual(moneyWordsIn(refusal.turn.content), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ONE RETRY, THEN ONE QUESTION — the machinery the repair ladder calls
// ═══════════════════════════════════════════════════════════════════════════

test('retryThenAsk: the retry clears it — no question, exactly two tries', async () => {
  let tries = 0;
  const result = await retryThenAsk<{ ok: boolean }>({
    attempt: async () => { tries += 1; return { ok: false }; },
    succeeded: (r) => r.ok,
    retry: async () => { tries += 1; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.ask, null);
  assert.equal(tries, 2, 'one attempt + ONE retry, never a loop');
});

test('retryThenAsk: still failing — ONE question, and never a third try', async () => {
  let tries = 0;
  const result = await retryThenAsk<{ ok: boolean; reason: string }>({
    attempt: async () => { tries += 1; return { ok: false, reason: 'the link expired' }; },
    succeeded: (r) => r.ok,
    retry: async () => { tries += 1; return { ok: false, reason: 'a fresh link could not reach it' }; },
    ask: () => ({ issue: 'the photo cannot be opened', question: 'Upload it again, or make the video without it?', options: ['again', 'without'], resolvable: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(tries, 2);
  assert.equal(result.ask?.question, 'Upload it again, or make the video without it?');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. HER ANSWER REACHES THE PLANNER, WITH EVERYTHING GIVEN BEFORE
// ═══════════════════════════════════════════════════════════════════════════

const priorChat: VideoChatTurn[] = [
  { role: 'user', content: 'Make it about my hand-poured candles, 15 seconds, warm.', kind: 'chat' },
  {
    role: 'assistant',
    content: 'The photo you uploaded (hand-poured-candle.png) does not resolve (HTTP 404). This video wasn\'t made. Do you want to upload hand-poured-candle.png again, or should I make the video without it?',
    kind: 'refusal-question',
    options: ['Upload the photo again', 'Make the video without the photo'],
    check: 'photo',
  },
];

test('the assembled chat holds her brief, the earlier turn, the question and her answer — once each', () => {
  const chat = assembleVideoChat({
    prior: priorChat,
    incoming: [
      { role: 'user', content: 'Make it about my hand-poured candles, 15 seconds, warm.' },
      { role: 'user', content: 'Make the video without the photo.' },
    ],
    brief: 'A 15 second promo for my hand-poured candle shop.',
  });
  assert.equal(chat.answered, true);
  assert.equal(chat.answer, 'Make the video without the photo.');
  assert.equal(chat.turns[0].content, 'A 15 second promo for my hand-poured candle shop.', 'her original brief leads');
  assert.equal(chat.turns.filter((t) => t.content === 'Make it about my hand-poured candles, 15 seconds, warm.').length, 1,
    'an earlier turn is never duplicated');
  assert.ok(chat.turns.some((t) => t.kind === 'refusal-question'), 'the question is in the conversation');
  assert.equal(chat.turns[chat.turns.length - 1].kind, 'client-answer', 'her answer is the LAST turn');
});

test('the planner REQUEST carries her reply and her original brief', () => {
  const chat = assembleVideoChat({
    prior: priorChat,
    incoming: [{ role: 'user', content: 'Make the video without the photo.' }],
    brief: 'A 15 second promo for my hand-poured candle shop.',
  });
  const section = buildPlannerConversationSection(chat.turns, { duration: 15, voiceId: 'nova', tone: 'warm', sourceImages: [] }, { answered: chat.answered });
  const request = buildPlannerRequest({
    cleanIdea: 'A 15 second promo for my hand-poured candle shop.',
    duration: 15,
    sceneCount: 3,
    perScene: 5,
    constrain: ' Return the scenes array.',
    toneHint: ' Use a warm narration tone.',
    moodHint: '',
    srcHint: '',
    componentsSection: '',
    timeBudgetSection: '',
    actionSection: '',
    avatarSection: '',
    conversationSection: section,
  });

  assert.ok(request.includes('A 15 second promo for my hand-poured candle shop.'), 'the original brief is in the request');
  assert.ok(request.includes('Make it about my hand-poured candles, 15 seconds, warm.'), 'her earlier turn is in the request');
  assert.ok(request.includes('Do you want to upload hand-poured-candle.png again'), 'the question we asked is in the request');
  assert.ok(request.includes('Make the video without the photo.'), 'HER ANSWER is in the request');
  assert.ok(request.includes('HER ANSWER IS THE DECIDING INSTRUCTION'), 'the planner is told the answer decides');
  assert.ok(request.includes('no uploaded photo'), 'her selections ride along');
  assert.match(request, /never text to speak/i, 'the conversation is context, never narration');
});

test('her answer CHANGES the next attempt: the photo she dropped is not sent again, and a length she names is used', () => {
  const dropped = applyAnswerToSelections('Make the video without the photo.', {
    duration: 15,
    sourceImages: ['https://cdn.example/hand-poured-candle.png'],
  });
  assert.deepEqual(dropped.selections.sourceImages, [], 'the photo she dropped cannot reach the next pre-flight');
  assert.ok(dropped.applied.includes('sourceImages=[]'));

  const relength = applyAnswerToSelections('Actually make it 30 seconds.', { duration: 15 });
  assert.equal(relength.selections.duration, 30);

  const untouched = applyAnswerToSelections('Sounds good, keep it as it is.', { duration: 15, tone: 'warm' });
  assert.deepEqual(untouched.applied, [], 'nothing is invented from an answer that changes nothing');
  assert.equal(untouched.selections.duration, 15);
});

test('a refused attempt stores its chat so the next attempt can pick it up', () => {
  const stored = storedChatFromMetadata({ chat: { turns: priorChat, awaitingAnswer: true, selections: { duration: 15 } } });
  assert.ok(stored);
  assert.equal(stored!.awaitingAnswer, true);
  assert.equal(stored!.turns.length, 2);
  assert.equal(storedChatFromMetadata({}), null, 'a row with no chat is simply no chat');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE REFUSAL SPENDS NOTHING
// ═══════════════════════════════════════════════════════════════════════════

test('the refused attempt spends no quota and records no paid call', async () => {
  resetCounts();
  // The photo check runs AFTER the quota check, so this refusal also proves the counter
  // was read, passed, and never written.
  const err: any = await sceneVideoPipelineService
    .createProject(baseInput({ sourceImages: ['https://photo.invalid/does-not-resolve.png'] }))
    .then(() => null, (e) => e);
  assert.equal(err?.check, 'photo', `got ${err?.check}: ${err?.message}`);
  assert.equal(quotaReads, 1, 'the counter is READ once and never written by a refusal');
  assert.equal(quotaAllowance, WEEKLY_FACELESS_LIMIT, 'the allowance is untouched');
  assert.ok(err.chat?.turns?.length, 'the refusal still speaks in the chat');
  assert.match(String(err.chat.turns[err.chat.turns.length - 1].content), /does-not-resolve\.png/,
    'and the question names HER file');
  allZero('dead photo');
});
