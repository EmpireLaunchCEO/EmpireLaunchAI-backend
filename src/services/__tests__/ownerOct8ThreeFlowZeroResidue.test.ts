import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCreativeEssence,
  transformTwinScriptToPitch,
  isChatResidueText,
  capNarrationForScene,
  stripInstructionResidue,
  buildCompactSubject,
  ttsReadAloudInstruction,
} from '../creativeTransformation.js';
/**
 * OWNER-OCT-8 THREE-FLOW ZERO-RESIDUE GUARDS (5th failure, project abca11ed)
 * Extended by lead directive (Oct 8): the anti-leak guarantees are NOT Faceless-
 * only — they apply to ALL THREE flows (Scene, Faceless, Twin) end to end:
 *   1. No raw brief / bullet / typed text in any scene visualPrompt (image
 *      prompts must never echo brief text → no on-screen typed words).
 *   2. No conversation-turn / assistant-chat text can reach narration or audio
 *      (the voice addresses CUSTOMERS about the product, never "talks as if
 *      talking to you in the conversation").
 *   3. Rewrite-to-best charter: always the best possible finished pitch, never
 *      a recital. LINE_CHANGE edits remain the only verbatim exception.
 * The owner's EXACT 612-char raw brief from the production record is the
 * fixture. These pure transformation-layer tests run in the sandbox; the
 * scene-pipeline assertions (buildComponentInventory / injectMissingComponents
 * / parseScenes) live in scenePipelineFixes.test.ts (CI/verified env).
 */
const OWNER_BRIEF_612 =
  'Introducing EmpireLaunch AI, the platform for all you need. Stop paying for credits. ' +
  'With this platform you get 96 videos a month, unlimited video edits and designs for those ' +
  'that sell. Get ahead of the game. Get started today for the Introductory price! ' +
  'Yes Make sure it\'s cohesive and makes customers want to get this app. ' +
  'Use a energetic mood across every scene and the narration.';
// The raw brief split into the 7 chunks the production inventory produced.
const RAW_CHUNKS = [
  'Introducing EmpireLaunch AI, the platform for all you need.',
  'Stop paying for credits.',
  'With this platform you get 96 videos a month, unlimited video edits and designs for those that sell.',
  'Get ahead of the game.',
  'Get started today for the Introductory price!',
  'Yes Make sure it\'s cohesive and makes customers want to get this app.',
  'Use a energetic mood across every scene and the narration.',
];
const CHAT_LINE = "I love the energy, but I'm here to chat with anything you need to chat about.";

// ─── 1. ESSENCE: the Oct 8 brief classifies as a DEGENERATE whole-brief echo ──
test('extractCreativeEssence: owner Oct 8 brief → degenerate echo (internal:false, degenerateFallback:true) with a compact subject', () => {
  const e = extractCreativeEssence(OWNER_BRIEF_612);
  assert.equal(e.internal, false, 'Oct 8 brief is NOT internal-sounding (no explicit recruiting markers)');
  assert.equal(e.degenerateFallback, true, 'but the whole-brief echo IS degenerate → fallback required (the Oct 8 defect)');
  assert.ok(e.subject.length <= 120, `subject compact: ${e.subject.length} chars`);
  assert.ok(e.subject.split(/\s+/).length <= 12, `subject ≤12 words: "${e.subject}"`);
});

// ─── 2. RESIDUE CLASSIFIER: the exact production chunks ──────────────────────
test('isChatResidueText: flags the owner\'s chat/instruction chunks, never clean customer copy', () => {
  // Chunks 6 & 7 from the production metadata.components — chat reply + mood instruction:
  assert.equal(isChatResidueText(RAW_CHUNKS[5]), true, 'chunk 6 ("Yes Make sure it\'s cohesive...") is chat residue');
  assert.equal(isChatResidueText(RAW_CHUNKS[6]), true, 'chunk 7 ("Use a energetic mood across every scene and the narration.") is instruction residue');
  assert.equal(isChatResidueText(CHAT_LINE), true, 'assistant conversational reply is residue');
  assert.equal(isChatResidueText("Sure! I'd love to help with that."), true);
  // Clean chunks 1–5 are the raw brief's selling points — they belong to the
  // brief itself (blocked from inventory by the degenerate-echo subject path),
  // but they are NOT chat/instruction residue:
  for (const c of RAW_CHUNKS.slice(0, 5)) {
    assert.equal(isChatResidueText(c), false, `not chat residue: "${c.slice(0, 50)}..."`);
  }
});

// ─── 3. RESIDUE STRIPPER: the mood instruction + chat tail are cut pre-extraction ─
test('stripInstructionResidue: cuts CTA-/Ok/You-choose/mood-hint tails before any extraction', () => {
  const stripped = stripInstructionResidue(OWNER_BRIEF_612);
  assert.ok(!/energetic mood/i.test(stripped), 'mood instruction removed');
  assert.ok(!/Make sure it's cohesive/i.test(stripped), 'chat tail removed');
  assert.ok(!/Yes\s+Make sure/i.test(stripped), '"Yes Make sure" chat start removed');
  assert.ok(/Introductory price/i.test(stripped), 'real customer copy survives');
});

// ─── 4. SUBJECT FALLBACK: deterministic compact subject, never the raw first sentence ─
test('buildCompactSubject: owner Oct 8 brief → finished ≤12-word subject, zero residue markers', () => {
  const subject = buildCompactSubject(OWNER_BRIEF_612);
  assert.ok(subject.length <= 120, `compact: ${subject.length} chars`);
  assert.equal(subject.split(/\s+/).length <= 12, true, `≤12 words: "${subject}"`);
  for (const n of ['Yes', 'Ok', 'mood', 'cohesive', 'You choose', 'CTA']) {
    assert.ok(!new RegExp(`\\b${n}\\b`, 'i').test(subject), `no "${n}" marker in subject`);
  }
  assert.ok(/EmpireLaunch AI/i.test(subject), 'brand survives in the finished subject');
});

// ─── 5. NARRATION CAP: complete sentences, no dangling "— it's" truncation ───
test('capNarrationForScene: cuts at the LAST sentence boundary inside the cap (no dangling fragments)', () => {
  // The Oct 8 production scene-1 line: raw first chunk + mid-sentence cap artifact.
  const dangling = 'Say hello to Introducing EmpireLaunch AI, the platform for all you need. — it\'s';
  const capped = capNarrationForScene(dangling, 6);
  assert.ok(!/—\s*it's\s*$/i.test(capped), 'no dangling "— it\'s" tail');
  assert.ok(!/—\s*$/.test(capped), 'no dangling em-dash tail');
  const words = capped.split(/\s+/).length;
  assert.ok(words <= 16, `fits a 6s window: ${words} words → "${capped}"`);
  // Long reader copy also ends at a real sentence boundary.
  const long = 'Say hello to Introducing EmpireLaunch AI, the platform for all you need. ' +
    'Stop paying for credits. With this platform you get 96 videos a month. Get started today!';
  const c2 = capNarrationForScene(long, 5);
  assert.ok(/[.!?]$/.test(c2.trim()), `complete sentence end: "${c2}"`);
  assert.ok(c2.split(/\s+/).length <= 13, '5s window → ~12 words cap');
});

// ─── 6. TWIN FLOW: transformTwinScriptToPitch must rewrite the DEGENERATE brief ─
test('transformTwinScriptToPitch: owner Oct 8 brief → finished customer pitch (degenerate echo rewritten, not recital)', () => {
  const pitched = transformTwinScriptToPitch(OWNER_BRIEF_612);
  assert.ok(/This is /.test(pitched), 'rewritten to a finished pitch ("This is <subject>.")');
  // Nothing from the raw typed brief can reach the twin's script/narration:
  for (const n of ['Introducing EmpireLaunch AI, the platform', 'Stop paying for credits',
    '96 videos a month', 'Get ahead of the game', 'Introductory price', 'cohesive',
    'energetic mood', 'Chat', 'I love the energy']) {
    assert.ok(!new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(pitched), `no raw/chat text: "${n}"`);
  }
  assert.ok(!/talking to you|here to chat|chat with you/i.test(pitched), 'voice never addresses the conversation');
  assert.ok(pitched.length < OWNER_BRIEF_612.length / 2, 'pitch is compact (rewrite-to-best, never a recital)');
  // Finished user script (LINE_CHANGE carve-out) stays verbatim:
  const finished = 'Handmade candles, gentle on your skin and your budget. Order before Friday for free shipping.';
  assert.equal(transformTwinScriptToPitch(finished), finished, 'finished client copy stays verbatim');
});

// ─── 7. TTS: verbatim read-back command — the chat model can NEVER answer conversationally ─
test('ttsReadAloudInstruction: forces verbatim read-back, forbids conversational replies', () => {
  const inst = ttsReadAloudInstruction('enthusiastic');
  assert.ok(/read the user's text EXACTLY as written, word for word/i.test(inst), 'verbatim read-back');
  assert.ok(/do not add, remove, rephrase, expand, explain, or respond conversationally/i.test(inst), 'no paraphrase, no chat reply');
  assert.ok(/never speak anything beyond the provided text/i.test(inst), 'bounded to the script');
  assert.ok(/energetic/i.test(inst), 'tone-directed delivery preserved');
  // The exact chat-turn class that leaked in the Oct 8 video is impossible:
  assert.ok(!/love the energy/.test(inst), 'instruction is not the chat line');
  // Default tone variant:
  const d = ttsReadAloudInstruction();
  assert.ok(/natural, lively, engaging/i.test(d), 'default enthusiastic-ish delivery');
});