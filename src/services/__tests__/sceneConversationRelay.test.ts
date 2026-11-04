/**
 * SCENE CONVERSATION RELAY — discriminating proof (owner Oct 26: "make sure
 * SCENE ... are fully pushed as well, not just faceless").
 *
 * Live chain (verified in code):
 *   FE studio/page.tsx:522-525 — handleSubmitProject sends
 *     { ..., conversation: relayedConversation, components: relayedComponents }
 *     → POST /api/studio/video-project
 *   studioRoutes.ts:1039-1046 — route normalizes:
 *     conversation = Array.isArray(req.body.conversation) ? filter(role
 *       user|assistant + string content) : undefined;
 *     components   = filter(non-empty strings)
 *     → createProject({ conversation, components })
 *   sceneVideoPipelineService.ts:2362 (THE live expression under test):
 *     extractRequestedVisuals(cleanIdea + ' ' + userConversationText(input.conversation))
 *
 * Discriminators: if only the first message were used (owner's fear), or if
 * conversation stayed unwired (pre-fix), the later turns' dictated opening,
 * end-flash domain and required visual are NOT extracted; with the relay they
 * are. Pure functions only — no LLM, no media, no DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRequestedVisuals, userConversationText } from '../requestedVisuals.js';

// Same transcript shape as the faceless fixture (owner-style chat: first ask
// general, the specifics — dictated opening, end-flash, required visual — come
// in LATER user turns, which is precisely what the owner feared gets dropped).
const SCENE_CONVERSATION: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'I want to make a video about my candle business, upbeat and selling.' },
  { role: 'assistant', content: 'Great — a 30s promo for your candle line, energetic narration.' },
  { role: 'user', content: 'Welcome to your glow. Say that first line word for word and change nothing.' },
  { role: 'assistant', content: 'Got it: the opening line will be used verbatim.' },
  { role: 'user', content: 'And flash the domain EmpireLaunchAi.com at the very end of the video, and in the third scene show a candle on a wooden desk.' },
  { role: 'assistant', content: 'End-flash domain and a scene-three candle on a wooden desk — on it.' },
];

const SCENE_IDEA = 'A faceless promo video for a scented-wax business, selling with an upbeat energy.';

/** Mirrors studioRoutes.ts /video-project (lines ~1039-1046) conversation filter. */
function normalizeRouteConversation(raw: unknown): Array<{ role: string; content: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  return (raw as Array<{ role?: unknown; content?: unknown }>)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role as string, content: m.content as string }));
}

/** Mirrors studioRoutes.ts /video-project components filter (non-empty strings). */
function normalizeRouteComponents(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const kept = (raw as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  return kept.length ? kept : undefined;
}

describe('scene conversation relay (owner Oct 26: scene must be pushed too)', () => {
  it('userConversationText joins EVERY user turn — later asks (2nd/3rd) are present, not just the first', () => {
    const joined = userConversationText(SCENE_CONVERSATION);
    assert.ok(joined.includes('Welcome to your glow'), '2nd user turn (dictated opening) missing from join');
    assert.ok(joined.includes('EmpireLaunchAi.com'), '3rd user turn (end-flash domain) missing from join');
    assert.ok(joined.includes('candle on a wooden desk'), '3rd user turn (required visual) missing from join');
    assert.ok(joined.includes('candle business'), 'first user turn missing from join');
  });

  it('DISCRIMINATOR — no-relay or first-message-only planning MISSES the dictated opening, end-flash and later required content', () => {
    const preFix = extractRequestedVisuals(`${SCENE_IDEA} ${userConversationText(undefined)}`);
    const firstMsgOnly = extractRequestedVisuals(`${SCENE_IDEA} ${userConversationText(SCENE_CONVERSATION.slice(0, 1))}`);

    assert.ok(!preFix.dictatedOpening, 'pre-fix must NOT see a dictated opening');
    assert.ok(!firstMsgOnly.dictatedOpening?.includes('Welcome'), 'first-message-only must NOT see the dictated opening');
    assert.ok(!preFix.endFlash, 'pre-fix must NOT see the end flash');
    assert.ok(!firstMsgOnly.endFlash, 'first-message-only must NOT see the end flash');
    assert.ok(!JSON.stringify(preFix).includes('wooden desk'), 'pre-fix must NOT see the later required visual');
    assert.ok(!JSON.stringify(firstMsgOnly).includes('wooden desk'), 'first-message-only must NOT see the later required visual');
  });

  it('DISCRIMINATOR — with the live createProject expression, dictated opening verbatim + end-flash + later content ALL land', () => {
    const input = { idea: SCENE_IDEA, conversation: normalizeRouteConversation(SCENE_CONVERSATION) };
    // THE live expression (sceneVideoPipelineService.createProject:2362).
    const requested = extractRequestedVisuals(`${input.idea} ${userConversationText(input.conversation)}`);

    assert.ok(requested.dictatedOpening?.includes('Welcome to your glow'), 'dictated opening not extracted verbatim');
    assert.equal(requested.endFlash?.text, 'EmpireLaunchAi.com', 'end-flash domain not extracted');
    assert.ok(JSON.stringify(requested).includes('wooden desk'), 'later required visual (wooden desk) not extracted');
  });

  it('route normalization keeps EVERY user/assistant turn and never slices to first (system/null dropped only)', () => {
    const raw = [
      { role: 'user', content: 'first ask' },
      { role: 'assistant', content: 'reply one' },
      { role: 'system', content: 'must be dropped' },
      { role: 'user', content: 'third ask — the one that matters' },
      null,
      { role: 'whatever', content: '' },
    ];
    const normalized = normalizeRouteConversation(raw);
    assert.equal(normalized?.length, 3, 'should keep first user + assistant + last user, drop system/null/other');
    assert.equal(normalized?.[2].content, 'third ask — the one that matters', 'the LAST user turn must survive');
    assert.ok(!normalized?.some((m) => m.role === 'system'), 'system must never reach the planner');
  });

  it('components normalization feeds buildComponentInventory — non-empty strings kept in order, junk omitted, field dropped when nothing survives', () => {
    const components = normalizeRouteComponents(['Logo on screen', '  ', '', 'Tagline animation']);
    assert.deepEqual(components, ['Logo on screen', 'Tagline animation'], 'kept strings in client order, empty/whitespace dropped');

    const createProjectInput = {
      conversation: SCENE_CONVERSATION,
      ...(components && components.length ? { components } : {}),
    };
    assert.deepEqual(createProjectInput.components, ['Logo on screen', 'Tagline animation'], 'input.components must carry the list (buildComponentInventory reads input.components ?? [])');

    const none = normalizeRouteComponents(['', '  ']);
    const noInput = { ...(none && none.length ? { components: none } : {}) };
    assert.ok(!('components' in noInput), 'whitespace-only components omitted from createProject input');
  });
});