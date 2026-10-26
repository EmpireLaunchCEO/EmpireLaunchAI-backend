/**
 * FACELESS CONVERSATION RELAY — discriminating proof for owner (Oct 19 + Oct 26):
 * "make sure it doesn't send just the first message I sent in there."
 *
 * The studio app's Faceless launch (studio/page.tsx handleFacelessSubmit →
 * POST /api/approval/create) previously sent ONLY the GPT-refined summary
 * (`description`); approvalController.createApproval passed NO conversation into
 * sceneVideoPipelineService.createProject, so the pipeline's requestedVisuals
 * extraction ran over `idea + userConversationText(undefined)` — later chat
 * turns (2nd/3rd user asks) were invisible to the planner.
 *
 * The fix: FE relays `conversation` (full transcript, already collected by
 * handleFacelessConversation) and approvalController validates + forwards it into
 * the faceless createProject input — the exact input the LIVE pipeline reads at
 * sceneVideoPipelineService.ts:2362:
 *   extractRequestedVisuals(cleanIdea + ' ' + userConversationText(input.conversation))
 *
 * These fixtures are DISCRIMINATING: if only the first message were used
 * (owner's fear), or if conversation stayed unwired (pre-fix), the later turns'
 * dictated opening / end-flash / required scene content are NOT extracted; with
 * the fix they are. Pure functions only — no LLM, no media, no DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRequestedVisuals, userConversationText } from '../requestedVisuals.js';

// A consultant transcript where the LATER user turns carry the dictated
// opening, the end-flash domain, and a required scene subject — exactly the
// shape of the owner's live run (first ask general, specifics come later).
const FULL_CONVERSATION: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'I want to make a faceless video about my candle business, upbeat and selling.' },
  { role: 'assistant', content: 'Great — a 30s faceless promo for your candle line, energetic narration.' },
  { role: 'user', content: 'Welcome to your glow. Say that first line word for word and change nothing.' },
  { role: 'assistant', content: 'Got it: the opening line will be used verbatim.' },
  { role: 'user', content: 'And flash the domain EmpireLaunchAi.com at the very end of the video, and in the third scene show a candle on a wooden desk.' },
  { role: 'assistant', content: 'End-flash domain and a scene-three candle on a wooden desk — on it.' },
];

const CLEAN_IDEA = 'A faceless promo video for a scented-wax business, selling with an upbeat energy.';

/** Mirrors the studio/approval route filter (studioRoutes.ts / approvalController.ts). */
function normalizeConversation(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ role?: unknown; content?: unknown }>)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
}

describe('faceless conversation relay (owner: full chat, never first-message-only)', () => {
  it('userConversationText joins EVERY user turn — later asks (2nd/3rd) are present, not just the first', () => {
    const joined = userConversationText(FULL_CONVERSATION);
    assert.ok(joined.includes('Welcome to your glow'), '2nd user turn (dictated opening) missing from join');
    assert.ok(joined.includes('EmpireLaunchAi.com'), '3rd user turn (end-flash domain) missing from join');
    assert.ok(joined.includes('candle on a wooden desk'), '3rd user turn (required visual) missing from join');
    assert.ok(joined.includes('candle business'), 'first user turn missing from join');
  });

  it('DISCRIMINATOR — no-relay or first-message-only planning MISSES the dictated opening, end-flash and later required content', () => {
    const preFix = extractRequestedVisuals(`${CLEAN_IDEA} ${userConversationText(undefined)}`);
    const firstMsgOnly = extractRequestedVisuals(`${CLEAN_IDEA} ${userConversationText(FULL_CONVERSATION.slice(0, 1))}`);

    // Her dictated opening came in the SECOND user message — absent both ways.
    assert.ok(!preFix.dictatedOpening, 'pre-fix must NOT see a dictated opening');
    assert.ok(!preFix.dictatedOpening?.includes('Welcome'), 'pre-fix opening must be empty');
    assert.ok(!firstMsgOnly.dictatedOpening?.includes('Welcome'), 'first-message-only must NOT see the dictated opening');
    // End-flash domain — her third ask — absent pre-fix / first-only.
    assert.ok(!preFix.endFlash, 'pre-fix must NOT see the end flash');
    assert.ok(!firstMsgOnly.endFlash, 'first-message-only must NOT see the end flash');
    // Required scene content from her later turn — absent pre-fix / first-only.
    assert.ok(!JSON.stringify(preFix).includes('wooden desk'), 'pre-fix must NOT see the later required visual');
    assert.ok(!JSON.stringify(firstMsgOnly).includes('wooden desk'), 'first-message-only must NOT see the later required visual');
  });

  it('DISCRIMINATOR — with the relay fix, dictated opening verbatim + end-flash + later required content ALL land in the plan', () => {
    const input = { idea: CLEAN_IDEA, conversation: FULL_CONVERSATION };
    // The EXACT live expression (sceneVideoPipelineService.createProject:2362).
    const requested = extractRequestedVisuals(`${input.idea} ${userConversationText(input.conversation)}`);

    assert.ok(requested.dictatedOpening?.includes('Welcome to your glow'), 'dictated opening not extracted verbatim');
    assert.equal(requested.endFlash?.text, 'EmpireLaunchAi.com', 'end-flash domain not extracted');
    assert.ok(JSON.stringify(requested).includes('wooden desk'), 'later required visual (wooden desk) not extracted');
  });

  it('route normalization keeps ALL user/assistant messages and drops malformed ones (never slices to first)', () => {
    const raw = [
      { role: 'user', content: 'first ask' },
      { role: 'assistant', content: 'reply one' },
      { role: 'system', content: 'must be dropped' },
      { role: 'user', content: 'second ask — the important one' },
      null,
      { role: 'whatever', content: '' },
    ];
    const normalized = normalizeConversation(raw);
    assert.equal(normalized.length, 3, 'should keep first user + assistant + second user, drop system/null/other');
    assert.equal(normalized[2].content, 'second ask — the important one', 'the LAST user turn is the one that must survive');
  });
});