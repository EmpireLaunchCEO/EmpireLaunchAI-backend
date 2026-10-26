/**
 * TWIN CONVERSATION RELAY — discriminating proof (owner Oct 26: "make sure ...
 * TWIN [AI chats] are fully pushed as well, not just faceless").
 *
 * Live chain (verified in code):
 *   FE studio/page.tsx:337 — handleSynthesizeTwin sends
 *     { ..., conversation: twinConversation } → POST /api/cinema/create-twin
 *   cinemaController.ts:197-219 — normalizes:
 *     convRaw = Array.isArray(conversation) ? conversation
 *               : Array.isArray(conversationHistory) ? conversationHistory
 *               : undefined;
 *     conv = filter(m => object && typeof m.content === 'string')
 *            .map({ role: typeof m.role === 'string' ? m.role : 'user', content })
 *     → createNeuralTwin({ conversation: conv })
 *   cinemaEngineService.ts:92-94 (THE live expressions under test):
 *     const talkText = userConversationText(conversation);
 *     const requestedVisuals = extractRequestedVisuals(talkText ? `${script} ${talkText}` : script);
 *     const enforced = enforceTwinDictation(safeScript, requestedVisuals);
 *
 * Discriminators: script-alone (no conversation) or first-message-only MISS the
 * dictated opening, end-flash domain and later required visual that live only
 * in LATER user turns; with the relay they are extracted AND then enforced onto
 * the final twin script by enforceTwinDictation. Pure functions — no LLM/media.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRequestedVisuals, enforceTwinDictation, userConversationText } from '../requestedVisuals.js';

const TWIN_CONVERSATION: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'I want my twin to pitch my candle business, upbeat and selling.' },
  { role: 'assistant', content: 'Great — an energetic 30s neural-twin pitch for your candle line.' },
  { role: 'user', content: 'Welcome to your glow. Say that first line word for word and change nothing.' },
  { role: 'assistant', content: 'Got it: the opening line will be used verbatim.' },
  { role: 'user', content: 'And flash the domain EmpireLaunchAi.com at the very end of the video, and in the third scene show a candle on a wooden desk.' },
  { role: 'assistant', content: 'End-flash domain and a scene-three candle on a wooden desk — on it.' },
];

// The twin script as refined by the consultant — none of the conversation's
// later specifics (dictated opening / end-flash / required visual) appear here.
const TWIN_SCRIPT = 'An energetic pitch for our scented-wax candle line, closing with a call to the store.';

/** Mirrors cinemaController.ts:197-213 normalization (conversation OR legacy history). */
function normalizeTwinConversation(
  conversation: unknown,
  conversationHistory: unknown,
): Array<{ role?: string; content?: unknown }> | undefined {
  const convRaw = Array.isArray(conversation)
    ? conversation
    : Array.isArray(conversationHistory)
      ? conversationHistory
      : undefined;
  if (!Array.isArray(convRaw)) return undefined;
  return (convRaw as Array<{ role?: unknown; content?: unknown }>)
    .filter((m) => m && typeof m === 'object' && typeof (m as { content?: unknown }).content === 'string')
    .map((m) => ({
      role: typeof m.role === 'string' ? m.role : 'user',
      content: m.content,
    }));
}

describe('twin conversation relay (owner Oct 26: twin must be pushed too)', () => {
  it('userConversationText unions EVERY user turn from the normalized twin conversation', () => {
    const conv = normalizeTwinConversation(TWIN_CONVERSATION, undefined);
    const talkText = userConversationText(conv); // THE live line (cinemaEngineService:92)
    assert.ok(talkText.includes('Welcome to your glow'), '2nd user turn (dictated opening) missing');
    assert.ok(talkText.includes('EmpireLaunchAi.com'), '3rd user turn (end-flash domain) missing');
    assert.ok(talkText.includes('candle on a wooden desk'), '3rd user turn (required visual) missing');
  });

  it('DISCRIMINATOR — script alone (no relay) MISSES the dictated opening, end-flash and later required visual', () => {
    // talkText falsy → extraction from the finished script only (THE live ternary).
    const requestedAlone = extractRequestedVisuals(TWIN_SCRIPT);
    assert.ok(!requestedAlone.dictatedOpening?.includes('Welcome'), 'script-alone must NOT see the dictated opening');
    assert.ok(!requestedAlone.endFlash, 'script-alone must NOT see the end flash');
    assert.ok(!JSON.stringify(requestedAlone).includes('wooden desk'), 'script-alone must NOT see the later required visual');
  });

  it('DISCRIMINATOR — with the relay, ${script} ${talkText} lands dictatedOpening verbatim + end-flash + later content', () => {
    const conv = normalizeTwinConversation(TWIN_CONVERSATION, undefined);
    const talkText = userConversationText(conv);
    const requestedVisuals = extractRequestedVisuals(talkText ? `${TWIN_SCRIPT} ${talkText}` : TWIN_SCRIPT); // THE live expression

    assert.ok(requestedVisuals.dictatedOpening?.includes('Welcome to your glow'), 'dictated opening not extracted verbatim');
    assert.equal(requestedVisuals.endFlash?.text, 'EmpireLaunchAi.com', 'end-flash domain not extracted');
    assert.ok(JSON.stringify(requestedVisuals).includes('wooden desk'), 'later required visual not extracted');
  });

  it('enforceTwinDictation puts the dictated opening + end-flash ONTO the final twin script (idempotent)', () => {
    const conv = normalizeTwinConversation(TWIN_CONVERSATION, undefined);
    const talkText = userConversationText(conv);
    const requestedVisuals = extractRequestedVisuals(talkText ? `${TWIN_SCRIPT} ${talkText}` : TWIN_SCRIPT);
    const enforced = enforceTwinDictation(TWIN_SCRIPT, requestedVisuals); // THE live line (cinemaEngineService:94)

    assert.ok(enforced.script.startsWith('Welcome to your glow.'), 'dictated opening must be PREFIXED verbatim');
    assert.equal(enforced.applied.openingPrefixed, true, 'openingPrefixed must be recorded');
    assert.ok(enforced.script.includes('Go to EmpireLaunchAi.com to get started!'), 'end-flash CTA must be appended with the EXACT domain');
    assert.equal(enforced.applied.flashAppended, true, 'flashAppended must be recorded');

    // Idempotence — re-running on the enforced script adds nothing.
    const again = enforceTwinDictation(enforced.script, requestedVisuals);
    assert.equal(again.applied.openingPrefixed, false, 'no double prefix on re-run');
    assert.equal(again.applied.flashAppended, false, 'no duplicate flash CTA on re-run');
    assert.equal(again.script, enforced.script, 'script must be stable after first enforcement');
  });

  it('controller normalization accepts `conversation` OR legacy `conversationHistory`, keeps EVERY turn, defaults role to user', () => {
    // conversation wins when both provided (controller precedence).
    const both = normalizeTwinConversation(
      [{ role: 'user', content: 'turn A' }, { role: 'assistant', content: 'turn B' }],
      [{ role: 'user', content: 'legacy turn C' }],
    );
    assert.deepEqual(both?.map((m) => m.content), ['turn A', 'turn B'], 'conversation (not history) is the source when both exist');

    // Legacy-only path: every turn kept, role defaulted to 'user' when missing.
    const legacy = normalizeTwinConversation(undefined, [
      { role: 'user', content: 'first' },
      { content: 'second — no role field' }, // role must default to 'user'
      { content: 42 }, // non-string content dropped by the filter
      null,
    ]);
    assert.equal(legacy?.length, 2, 'keeps object turns with string content, drops others');
    assert.equal(legacy?.[1].role, 'user', 'missing role defaults to user (so userConversationText keeps the turn)');
    assert.equal(legacy?.[1].content, 'second — no role field', 'the LAST real turn must survive');
    const talkText = userConversationText(legacy);
    assert.ok(talkText.includes('second — no role field'), 'defaulted-role turn must reach the twin extraction');
  });
});