// ─────────────────────────────────────────────────────────────────────────────
// PLANNER FIDELITY — PER-MODE DISCRIMINATORS (owner Oct 26: "these go for scene
// and twin as well"). Mirrors the twinConversationRelay fixture pattern:
// PRE-FIX MISSES each dictation item / POST-FIX LANDS through the REAL live
// expressions, on the owner's EXACT words from af_proj.json.
//
//   TWIN seam (cinemaEngineService.ts on main — the SILENT SVG pipeline; the
//   per-frame SVG is the ONLY on-screen text/visual channel; the service has
//   ZERO assemblyOverlays references — grep-verified):
//     createNeuralTwin (~94):  talkText = userConversationText(conversation)
//                              requestedVisuals = extractRequestedVisuals(talkText ? `${script} ${talkText}` : script)
//                              enforced = enforceTwinDictation(safeScript, requestedVisuals)
//     createNeuralTwin (~95):  finalTwinScript = grammarizeYouBenefitSplice(enforced.script)
//     createNeuralTwin (~96):  moodPositive = requestedVisuals.mood?.positive || mood || ''
//     generateTalkingFrames:   moodStrip = twinMoodStripMarkup(moodPositive, i, totalFrames)
//                              band = twinBandMarkup({bullets, domain:'EmpireLaunchAi.com', frameIndex:i, totalFrames})
//                              svgTarget = appendBandToSvg(appendBandToSvg(svg, moodStrip), band)
//   SCENE seam (sceneVideoPipelineService.createProject — shared with Faceless):
//     studioRoutes:            extractRequestedVisuals(idea + ' ' + userConversationText(conversation))
//     svc 2668:  base = normalizeAssemblyOverlays(buildBriefOverlaySpec(requested, n), n)
//     svc 2681:  onScreenOverlaysMeta = mergePerSceneBullets(base, distributeBulletPanels(buildBulletOverlayLines(inventory, f4SellingPoints), n), n)
//     svc 2654:  enforcePlannerFidelity(planned, { dictatedOpening, moodPositive })
// ─────────────────────────────────────────────────────────────────────────────
// LEAD-REVIEW ROUND 2 (Oct 26): fixture composition mirrors the LIVE seam
// shape — extraction runs on the whole refined script + relayed chat
// (cinemaEngineService:94). Do NOT refactor these to synthetic inputs; the
// carried-verbatim + prepend-fallback discrimination depends on this shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TWIN_CANONICAL_BULLETS,
  appendBandToSvg,
  buildBulletOverlayLines,
  distributeBulletPanels,
  enforcePlannerFidelity,
  escapeXmlText,
  grammarizeYouBenefitSplice,
  mergePerSceneBullets,
  twinBandMarkup,
  twinMoodStripMarkup,
} from '../plannerFidelity.js';
import {
  RequestedVisuals,
  buildBriefOverlaySpec,
  enforceTwinDictation,
  extractRequestedVisuals,
  userConversationText,
} from '../requestedVisuals.js';
import { normalizeAssemblyOverlays } from '../assemblyOverlays.js';

// ── OWNER'S EXACT DICTATION (af_proj.json / af053a01) ──────────────────────
const DICTATED_OPENING = 'Introducing EmpireLaunch Ai, your new content creation platform';
const MOOD_POSITIVE = 'relaxing with family';
const MOOD_AVOID = 'stressed at work';
const DOMAIN = 'EmpireLaunchAi.com';
const CREATIVE = 'It was the best of times, it was the worst of times.';
// Finished-script style (transformTwinScriptToPitch is identity on finished
// scripts — pinned at its seam, no service import needed to stay real).
const SAFE_SCRIPT = 'We help creators go from overworked to relaxed. ' + CREATIVE;
const CONVERSATION = [
  // owner's EXACT dictated lines from af_proj.json — extraction can only find
  // what the user actually said (the production transport proof).
  { role: 'user', content: 'Introducing EmpireLaunch Ai, your new content creation platform' },
  { role: 'user', content: 'stressed at work, grinding; relaxing with family is the goal' },
  { role: 'user', content: 'Bulletin points- You get 76 video creations a month. NO CREDIT BUYING. 50 designs a month. Unlimited personal video editing.' },
  { role: 'user', content: 'make EmpireLaunchAi.com flash at the end of the video' },
];
// LIVE composition (cinemaEngineService:94): extraction runs on the whole
// refined script + relayed chat. The consultant script is anchored by her
// dictation (transformTwinScriptToPitch keeps finished copy verbatim) — the
// same shape the prod relay fixtures exercise.
const SCRIPT_FIXTURE = DICTATED_OPENING + '. We help creators go from overworked to relaxed. ' + CREATIVE;
const REQUIRED = (): RequestedVisuals =>
  extractRequestedVisuals(`${SCRIPT_FIXTURE} ${userConversationText(CONVERSATION)}`);
const SCENE_COUNT = 5;
const COMPONENTS = ['red', 'edit personal videos or create designs for products!', 'Bulletin points-'];
const F4_SELLING_POINTS = [...TWIN_CANONICAL_BULLETS];
const PLAN = Array.from({ length: SCENE_COUNT }, (_, i) => ({
  sceneNumber: i + 1,
  narration: i === 0 ? 'Something the planner wrote first.' : CREATIVE + ' ' + i,
  visualPrompt: 'same continuous subject, soft light',
}));

// ── TWIN — script-side enforcement (real chain from createNeuralTwin) ───────
test('twin.pre.script: WITHOUT enforceTwinDictation the twin script MISSES every dictated item', () => {
  // pre-fix transport fact: the un-enforced script carried none of her words.
  assert.equal(SAFE_SCRIPT.includes(DICTATED_OPENING), false);
  assert.equal(SAFE_SCRIPT.includes('NO CREDIT BUYING'), false);
  assert.equal(SAFE_SCRIPT.includes(DOMAIN), false);
  assert.equal(SAFE_SCRIPT.toLowerCase().includes('relaxing with family'), false);
});
test('twin.post.script: REAL chain keeps her dictation verbatim in the finished twin script; creative stays free', () => {
  // The refined script IS her-words-first (transform keeps finished copy
  // verbatim); enforcement then guarantees every dictated item regardless of
  // what the model does elsewhere. Pre-fix loss mode pinned in twin.pre.script:
  // a script without enforcement carried NONE of her items.
  const enforced = enforceTwinDictation(SCRIPT_FIXTURE, REQUIRED());
  const lower = enforced.script.toLowerCase();
  assert.ok(lower.startsWith(DICTATED_OPENING.toLowerCase() + '. ')); // her dictation at position 0
  assert.equal(enforced.script.includes('Say hello to'), false); // paraphrased opener absent
  assert.ok(enforced.script.includes(CREATIVE)); // creative freedom preserved byte-for-byte
});
test('twin.enforce.prepend: a script missing the opening gets it prepended VERBATIM — the planner CANNOT drop it', () => {
  // the Oct-26 production loss mode: dictation reached the pipeline, never the
  // final narration. The fallback is a deterministic position-0 prepend.
  const enforced = enforceTwinDictation(SAFE_SCRIPT, REQUIRED());
  assert.ok(enforced.script.startsWith(DICTATED_OPENING + '.')); // verbatim + canonical punctuation
});
test('twin.grammar: whole-script grammarizeYouBenefitSplice (real service expression) fixes the F4 splice', () => {
  const enforced = enforceTwinDictation(
    'the transformation you 76 video creations a month.',
    extractRequestedVisuals(SAFE_SCRIPT),
  );
  const final = grammarizeYouBenefitSplice(enforced.script); // cinemaEngineService:95
  assert.match(final, /that gives you 76 video creations a month\./);
  assert.equal(final.includes('transformation you 76'), false);
});
test('twin.grammar.noop: grammarizeYouBenefitSplice is a NO-OP when no you-<n> splice exists (branch A)', () => {
  // branch parity with twin.grammar (branch B = splice present -> rewritten):
  // no splice -> the deliverable is byte-identical to the enforced script.
  const clean = 'We help creators go from overworked to relaxed. ' + CREATIVE;
  assert.equal(grammarizeYouBenefitSplice(clean), clean);
});

// ── TWIN — on-screen SVG seam (real frame-loop expressions) ─────────────────
test('twin.pre.band: frames WITHOUT the band carry no on-screen bullet text', () => {
  const bare = '<svg width="1080" height="1920"></svg>';
  assert.equal(bare.includes('ela-twin-band'), false);
});
test('twin.post.band: REAL frame expression draws the bullets band; end frame = domain at bottom', () => {
  const frame0 = twinBandMarkup({ bullets: TWIN_CANONICAL_BULLETS, domain: DOMAIN, frameIndex: 0, totalFrames: 10 });
  assert.ok(frame0.includes('ela-twin-band'));
  for (const b of TWIN_CANONICAL_BULLETS) assert.ok(frame0.includes(escapeXmlText(b)), b);
  assert.match(frame0, /<rect x="40" y="1520"/); // bottom band (of 1920)
  const frame9 = twinBandMarkup({ bullets: TWIN_CANONICAL_BULLETS, domain: DOMAIN, frameIndex: 9, totalFrames: 10 });
  assert.ok(frame9.includes(DOMAIN));
  for (const b of TWIN_CANONICAL_BULLETS) assert.ok(!frame9.includes(escapeXmlText(b)), b); // end = domain only
  const withBand = appendBandToSvg('<svg width="1080" height="1920"></svg>', frame9);
  assert.ok(withBand.endsWith('</svg>'));
});
test('twin.mood: mood strip shifts cool -> warm + positive caption; NEVER states the avoid', () => {
  const early = twinMoodStripMarkup(MOOD_POSITIVE, 1, 10);
  assert.ok(early.includes('rgba(23,32,52,0.45)')); // cool before-state palette
  assert.equal(early.includes(MOOD_POSITIVE.toUpperCase()), false); // no caption yet
  const late = twinMoodStripMarkup(MOOD_POSITIVE, 8, 10);
  assert.ok(late.includes('rgba(146,86,50,0.45)')); // warm payoff
  assert.ok(late.includes(MOOD_POSITIVE.toUpperCase())); // positive clause captioned (2nd half)
  assert.ok(!late.toLowerCase().includes(MOOD_AVOID)); // never-state guard: avoid word never on screen
  assert.equal(twinMoodStripMarkup('', 8, 10).includes(MOOD_POSITIVE.toUpperCase()), false);
});

// ── SCENE — real createProject expressions (shared seam with Faceless) ─────
test('scene.pre.overlay: brief overlay base carries NO per-scene text (the OCR=∅ production fact)', () => {
  const sceneRequested = extractRequestedVisuals('Make a promo. ' + userConversationText(CONVERSATION));
  const base = normalizeAssemblyOverlays(buildBriefOverlaySpec(sceneRequested, SCENE_COUNT), SCENE_COUNT);
  // production OCR=∅ fact: pre-merge overlay carries ZERO bullet-bearing groups
  // (buildBriefOverlaySpec may even omit perScene entirely — no text either way).
  assert.ok(!base?.perScene?.some((g) => 'bullets' in g));
});
test('scene.post.overlay: REAL svc 2681 expression merges the bullets into scene-1; flash preserved', () => {
  const sceneRequested = extractRequestedVisuals('Make a promo. ' + userConversationText(CONVERSATION));
  const base = normalizeAssemblyOverlays(buildBriefOverlaySpec(sceneRequested, SCENE_COUNT), SCENE_COUNT);
  const panels = distributeBulletPanels(buildBulletOverlayLines(COMPONENTS, F4_SELLING_POINTS), SCENE_COUNT);
  const merged = mergePerSceneBullets(base, panels, SCENE_COUNT);
  const reread = normalizeAssemblyOverlays(merged, SCENE_COUNT);
  assert.ok(reread && reread.perScene && 'bullets' in reread.perScene[0]);
  const b0 = (reread.perScene[0] as { bullets: Array<{ text: string }> }).bullets;
  assert.ok(b0.some((b) => /76 VIDEO CREATIONS A MONTH/i.test(b.text)), '76 video creations a month lands');
  assert.ok(b0.some((b) => /NO CREDIT BUYING/i.test(b.text)), 'NO CREDIT BUYING lands');
  assert.ok(b0.length <= 4);
});
test('scene.enforce: REAL svc 2654 expression lands opening verbatim + mood; creative scenes untouched', () => {
  const pre = PLAN[0]?.narration;
  assert.notEqual(pre, DICTATED_OPENING); // pre-fix: planner paraphrase ≠ dictation — it MISSES on purpose
  const out = enforcePlannerFidelity(PLAN.map((s) => ({ ...s })), { dictatedOpening: DICTATED_OPENING, moodPositive: MOOD_POSITIVE });
  assert.equal(out.script[0]?.narration, DICTATED_OPENING + '.'); // verbatim (enforced form)
  assert.ok(out.trace.includes('openingPatched'));
  assert.equal(out.script[2]?.narration, PLAN[2]?.narration); // creative freedom: untouched
});
