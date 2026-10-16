/**
 * MODE-PARITY AUDIT (owner Oct 11: "all the work done yesterday needs to be applied
 * to twin and scene videos as well. Twin I haven't tested yet, but scene and faceless
 * have the same issues. So likely twin will have the same issues.")
 *
 * Zero-API regression matrix PROVING the launch-gate guarantees hold PER MODE:
 *   F1  portrait no-text stills (benefit/copy text BANNED from visualPrompts +
 *       deterministic appendNoTextGuard contract)
 *   F2  shared assembly path (aParts/amix audio graph) for faceless/twin/scene
 *   F3  transformation + subject EXACTLY "EmpireLaunch AI"
 *   F4  every relayed selling point SPOKEN (deterministic inject backstop) +
 *       visual-prompt ban
 *   DUR  dissolve-compensated scene budget → delivered 29.8s (in band) +
 *       INTEGER total_duration (PR #114: 29.8 → 30 via deliveredVideoDurationSeconds)
 *
 * Each mode variant is run through the SAME createProject planning sequence
 * (parseScenePlan → normalizePlanTimeBudget(dissolveCompensate) → F4 inject →
 * span/cap (scene only) → content direction/avatar consistency → F4 visual strip)
 * exactly as sceneVideoPipelineService.createProject wires it — NO paid renders,
 * NO mocks, NO ffmpeg (pure deterministic helpers).
 *
 * ALSO pins the ARCHITECTURE FACT that the audit surfaced: production Neural Twin
 * (cinemaEngineService.createNeuralTwin) is a SEPARATE engine that NEVER routes
 * through sceneVideoPipelineService.createProject — no video_projects row, no F4
 * inject, no narration/audio at all, and script text painted into SVG frames.
 * Those pins are the twin-specific gap list for the follow-up fix PRs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseScenePlan,
  normalizePlanTimeBudget,
  deliveredVideoDuration,
  deliveredVideoDurationSeconds,
  dissolveCompensatedSceneSum,
  injectSellingPointsIntoNarration,
  verifySellingPointsSpoken,
  stripBenefitTextFromVisualPrompts,
  resolveNarrationRoles,
  enforceAvatarConsistency,
  extractAvatarLook,
  looksLikeFirstPersonDialogue,
  applyActionBackstop,
  applySceneMotionFloor,
  planSoraSpans,
  capVeoMotionWindows,
  extractSoraBlockPrompts,
  DISSOLVE_OVERLAP_SECONDS,
  type SceneScript,
} from '../sceneVideoPipelineService.js';
import { extractCreativeEssence, finishedEssenceSentences, capNarrationForScene } from '../creativeTransformation.js';
import { appendNoTextGuard } from '../renderingEngine.js';
import { VEO_CALL_SECONDS, VEO_MOTION_BUDGET_SECONDS } from '../veoVideoService.js';
import { soraCallBudget } from '../soraVideoService.js';

/** OCT 10 owner brief — VERBATIM (the acceptance re-render input; 496 chars). */
const OCT10_BRIEF = 'Introducing EmpireLaunch AI - Your go to content creation platform. Tired of spending hours editing all your videos, taking out word blobs or time gaps, this platform does that to! Make your life easier, save time and money. No more needing to purchase credits. Get started early with our introductory price. You get 76 video creations a month. For those of you that create designs for your business - you get 50 per month- cut you creation time down. Get started today - go to E'
  + 'mpirelaunchai.com';

/** Repo-root helper for the architecture-pin tests (lazy read, at call time). */
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
function readRepoFile(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}
const DURATION = 30;
const { subject, benefits } = extractCreativeEssence(OCT10_BRIEF);
assert.equal(subject, 'EmpireLaunch AI', 'fixture: subject must be exactly the brand');
const sellingPoints = finishedEssenceSentences(extractCreativeEssence(OCT10_BRIEF));
assert.equal((benefits ?? []).length, 7, 'fixture: essence.benefits must carry all 7 selling points');
const KEYS = sellingPoints.map(s => s.replace(/\.$/, '').toLowerCase());
const BENEFIT_KEYS = KEYS.slice(1); // 7 selling points (brand sentence excluded)
const hasKey = (text: string, key: string) => String(text || '').toLowerCase().includes(key);

// ─── THE REAL createProject PLANNING SEQUENCE (mirrors sceneVideoPipelineService) ───
function runSharedPlanner(
  raw: any,
  mode: 'faceless' | 'scene',
  opts: { voice?: boolean } = {},
) {
  const cleanIdea = OCT10_BRIEF;
  const budget = soraCallBudget(DURATION);
  // createProject order (verbatim):
  const scriptBeforeFloor = parseScenePlan(raw, cleanIdea, DURATION, mode);
  const timeExact = normalizePlanTimeBudget(scriptBeforeFloor, DURATION, { dissolveCompensate: true });
  const script = mode === 'scene'
    ? applySceneMotionFloor(timeExact, extractSoraBlockPrompts(raw || {}, budget), budget)
    : timeExact;
  let planned = script.map(s => ({ ...s }));
  const f4SellingPoints = finishedEssenceSentences(extractCreativeEssence(cleanIdea));
  const f4Voice = opts.voice !== false;
  const f4Narr = f4Voice
    ? injectSellingPointsIntoNarration(planned, f4SellingPoints)
    : { script: planned, injected: [], stillMissing: verifySellingPointsSpoken(planned, f4SellingPoints).missing };
  planned = f4Narr.script.map(s => ({ ...s }));
  // span planning + VEO window cap (scene only; faceless/twin skip by mode)
  let spanPlans = mode === 'scene'
    ? planSoraSpans(planned, extractSoraBlockPrompts(raw || {}, budget))
    : [];
  if (mode === 'scene' && spanPlans.length) {
    const cap = capVeoMotionWindows(planned, spanPlans);
    spanPlans = cap.spans;
    planned = cap.script.map(s => ({ ...s }));
  }
  // content direction + avatar consistency
  const withRoles = resolveNarrationRoles(planned);
  const avatarPass = enforceAvatarConsistency(withRoles, extractAvatarLook(raw || {}));
  const actionPass = applyActionBackstop(avatarPass.script);
  planned = actionPass.script.map(s => ({ ...s }));
  const avatarRoleViolations = planned
    .filter(s => s.narrationRole === 'avatar-dialogue' && !looksLikeFirstPersonDialogue(s.narration))
    .map(s => s.sceneNumber);
  // F4 visual ban (after every backstop)
  const f4Visual = f4Voice
    ? stripBenefitTextFromVisualPrompts(planned, f4SellingPoints.filter(c => !/^EmpireLaunch AI\.$/i.test(c)))
    : { script: planned, strippedScenes: [] };
  planned = f4Visual.script.map(s => ({ ...s }));
  return {
    planned,
    spanPlans,
    sellingPoints: f4SellingPoints,
    f4Injected: f4Narr.injected,
    f4StillMissing: f4Narr.stillMissing,
    visualStrippedScenes: f4Visual.strippedScenes,
    avatarLook: avatarPass.avatarLook,
    avatarRoleViolations,
    delivered: deliveredVideoDuration(planned),
    dbSeconds: deliveredVideoDurationSeconds(planned),
    roles: planned.map(s => s.narrationRole || 'narrator'),
  };
}

// Real-route raw shapes -------------------------------------------------------
/** FACELESS director output: legacy scenes shape (what the approval API plans). */
const FACELESS_RAW = { scenes: [
  { sceneNumber: 1, duration: 6, visualType: 'still', narration: 'Say hello to EmpireLaunch AI. It\'s about to make things a lot easier.', visualPrompt: 'Cinematic establishing shot: hook intro of EmpireLaunch AI, the subject shown clearly for the first time.' },
  { sceneNumber: 2, duration: 6, visualType: 'still', narration: 'The essentials come together fast, and the process is simpler than it looks.', visualPrompt: 'Cinematic medium shot: setting up the fundamentals of EmpireLaunch AI, subject continues from the opening, early stage.' },
  { sceneNumber: 3, duration: 6, visualType: 'still', narration: 'And this is where it clicks — the transformation you came for.', visualPrompt: 'Cinematic wide shot: EmpireLaunch AI delivering its key benefit, the transformation in progress, same continuous subject.' },
  { sceneNumber: 4, duration: 6, visualType: 'still', narration: 'That\'s the payoff — real results, right in front of you.', visualPrompt: 'Cinematic close-up: the payoff result of EmpireLaunch AI, same continuous subject, breakthrough moment.' },
  { sceneNumber: 5, duration: 6, visualType: 'still', narration: 'Ready to make the move? Tap the link in bio.', visualPrompt: 'Cinematic closing shot: EmpireLaunch AI final call-to-action, same continuous subject, confident ending.' },
]};

/** TWIN-shaped director output: faceless stills + a shared avatarLook + two
 *  avatar-dialogue scenes (first-person lines) + narrator scenes — the shape the
 *  shared planner must handle if twin is served by the same createProject path.
 *  Narrations are SHORT generic story lines (no benefit phrasing) so the F4
 *  determinism check must inject ALL 7 selling points — mirroring the real
 *  prod-failing plan shape (over-long narration would overflow the SHORT cap). */
const TWIN_RAW = {
  avatarLook: 'confident young woman with dark hair, teal blazer, speaking warmly to camera',
  scenes: [
    { sceneNumber: 1, duration: 6, visualType: 'still', narrationRole: 'narrator', narration: 'Say hello to EmpireLaunch AI. It\'s about to make things a lot easier.', visualPrompt: 'Cinematic hook: a person\'s phone showing an edited video timeline, EmpireLaunch AI brand, clean studio desk.' },
    { sceneNumber: 2, duration: 6, visualType: 'still', narrationRole: 'avatar-dialogue', narration: 'I used to lose whole evenings to editing — not anymore.', visualPrompt: 'Talking avatar: the confident young woman with dark hair in a teal blazer speaks to camera, walking through the app.' },
    { sceneNumber: 3, duration: 6, visualType: 'still', narrationRole: 'narrator', narration: 'Everything you need lands in one place, and the process simply works.', visualPrompt: 'Cinematic wide shot: the same workspace, app showing ready-to-post videos, growth charts on screen.' },
    { sceneNumber: 4, duration: 6, visualType: 'still', narrationRole: 'avatar-dialogue', narration: 'Our team runs on it every single day.', visualPrompt: 'Talking avatar: the same confident young woman with dark hair in a teal blazer, smiling, pointing at the app.' },
    { sceneNumber: 5, duration: 6, visualType: 'still', narrationRole: 'narrator', narration: 'Ready to make the move? Tap the link in bio.', visualPrompt: 'Cinematic closing shot: EmpireLaunch AI brand wordmark on a clean background, call-to-action button.' },
  ],
};

/** SCENE director output: hybrid scenes with ONE soraContent block + sora-typed
 *  scenes paired IN ORDER (the owner-locked Scene plan shape). Narrations SHORT +
 *  generic so all 7 selling points must be injected deterministically. */
const SCENE_RAW = {
  soraContent: [{ prompt: 'One continuous smooth camera move through a bright modern content-creation studio, the EmpireLaunch AI interface glowing softly, no cuts, no text, no words, no letters anywhere in the frame.' }],
  scenes: [
    { sceneNumber: 1, duration: 6, type: 'sora', narration: 'Say hello to EmpireLaunch AI. It\'s about to make things a lot easier.', visualPrompt: 'Smooth cinematic push-in: EmpireLaunch AI app glowing on a studio desk, same continuous camera move.' },
    { sceneNumber: 2, duration: 6, type: 'gpt-image', narration: 'The essentials come together fast, and the process is simpler than it looks.', visualPrompt: 'Cinematic medium shot: hands on a keyboard, timeline being cleaned automatically, same studio.' },
    { sceneNumber: 3, duration: 6, type: 'sora', narration: 'And this is where it clicks — the transformation you came for.', visualPrompt: 'One continuous glide: the studio desk with design canvas and video preview side by side, same camera move.' },
    { sceneNumber: 4, duration: 6, type: 'gpt-image', narration: 'That\'s the payoff — real results, right in front of you.', visualPrompt: 'Cinematic wide shot: wall of published content, growth charts, same studio lighting.' },
    { sceneNumber: 5, duration: 6, type: 'gpt-image', narration: 'Ready to make the move? Tap the link in bio.', visualPrompt: 'Cinematic closing shot: EmpireLaunch AI wordmark, confident end card, no text overlays.' },
  ],
};

// ═══════════════════════════════ MODE 1: FACELESS ═══════════════════════════════
test('faceless baseline: OCT10 brief through shared planner — F4 7/7 SPOKEN, visuals clean, subject exact, durations 29.8/30', () => {
  const r = runSharedPlanner(FACELESS_RAW, 'faceless');
  assert.equal(r.f4StillMissing.length, 0, 'all 7 selling points must be SPOKEN');
  const haystack = r.planned.map(s => s.narration).join(' ').toLowerCase();
  for (const key of BENEFIT_KEYS) assert.ok(haystack.includes(key), `"${key}" must be SPOKEN (faceless)`);
  // F4 visual ban
  for (const s of r.planned) {
    const low = (s.visualPrompt || '').toLowerCase();
    for (const key of BENEFIT_KEYS) assert.ok(!low.includes(key), `"${key}" must NEVER remain in faceless scene ${s.sceneNumber} visualPrompt`);
  }
  // F1: every faceless still is a still; no-text guard contract applies at render
  for (const s of r.planned) {
    assert.equal(s.visualType, 'still', `faceless scene ${s.sceneNumber} must be a still`);
    const guarded = appendNoTextGuard(s.visualPrompt);
    assert.ok(/NO text, NO words/i.test(guarded), 'deterministic no-text guard must be present for faceless stills');
  }
  // F3: subject exact
  assert.ok(r.planned.some(s => /EmpireLaunch AI/i.test(s.narration)), 'subject spoken');
  assert.ok(r.planned.some(s => /EmpireLaunch AI/i.test(s.visualPrompt ?? '')), 'subject present as imagery');
  // DUR: dissolve-compensated → delivered 29.8 (in band), DB integer 30
  assert.ok(Math.abs(r.delivered - 29.8) < 0.01, `delivered must be ~29.8 (got ${r.delivered})`);
  assert.ok(r.delivered >= 29.5 && r.delivered <= 30.5, `delivered in 29.5-30.5 band (got ${r.delivered})`);
  assert.equal(r.dbSeconds, 30, 'total_duration column must be INTEGER 30 (PR #114)');
  assert.equal(Number.isInteger(r.dbSeconds), true, 'deliveredVideoDurationSeconds must return an integer');
  // roles: all narrator (no avatar) for faceless
  assert.ok(r.roles.every(x => x === 'narrator'), 'faceless must be all-narrator');
});

// ═══════════════════════════════ MODE 2: TWIN (SHARED PATH) ═══════════════════════════════
test('twin-shaped plan: F4 verify passes with avatar roles — 7/7 SPOKEN (injector is role-agnostic)', () => {
  const r = runSharedPlanner(TWIN_RAW, 'faceless'); // twin rides the faceless still engine
  assert.ok(r.roles.includes('avatar-dialogue'), 'fixture must include avatar-dialogue roles');
  assert.ok(r.roles.includes('narrator'), 'fixture must mix narrator roles');
  assert.equal(r.f4StillMissing.length, 0, 'all 7 selling points must be SPOKEN with MIXED roles (twin)');
  const haystack = r.planned.map(s => s.narration).join(' ').toLowerCase();
  for (const key of BENEFIT_KEYS) assert.ok(haystack.includes(key), `"${key}" must be SPOKEN across narrator+avatar lines (twin)`);
  // avatar consistency: EVERY avatar-dialogue scene carries the SAME avatarLook verbatim
  const avatarScenes = r.planned.filter(s => s.narrationRole === 'avatar-dialogue');
  assert.ok(avatarScenes.length >= 2, 'must be ≥2 avatar scenes');
  assert.ok(r.avatarLook, 'avatarLook must be resolved');
  for (const s of avatarScenes) {
    assert.ok((s.visualPrompt || '').toLowerCase().includes(r.avatarLook.toLowerCase().slice(0, 24)), `avatar scene ${s.sceneNumber} must reference the SAME avatar`);
  }
  // avatar-dialogue narration must still read first-person (no role violation after F4 injection)
  assert.deepEqual(r.avatarRoleViolations, [], 'avatar-dialogue scenes must remain first-person dialogue');
  // F4 visual ban holds for avatar stills too
  for (const s of r.planned) {
    const low = (s.visualPrompt || '').toLowerCase();
    for (const key of BENEFIT_KEYS) assert.ok(!low.includes(key), `"${key}" must NEVER remain in twin scene ${s.sceneNumber} visualPrompt`);
  }
  // F1: twin stills portrait + no-text guard
  for (const s of r.planned) {
    assert.equal(s.visualType, 'still', `twin scene ${s.sceneNumber} must be a still`);
    assert.ok(/NO text, NO words/i.test(appendNoTextGuard(s.visualPrompt)), 'no-text guard must apply to twin avatar stills (F1)');
  }
  // F3: subject exact
  assert.ok(r.planned.some(s => /EmpireLaunch AI/i.test(s.narration)), 'subject spoken (twin)');
  // DUR: identical compensation
  assert.ok(Math.abs(r.delivered - 29.8) < 0.01, `twin delivered must be ~29.8 (got ${r.delivered})`);
  assert.equal(r.dbSeconds, 30, 'twin total_duration must be INTEGER 30');
});

test('twin scene-1 avatar-dialogue F4 guard: non-first-person avatar line is FLAGGED (audit trail)', () => {
  // A twin avatar line that reads third-person must be caught by the violation audit
  // (owner rule v3: avatar-dialogue = the avatar\'s OWN first-person words).
  const bad: SceneScript[] = [
    { sceneNumber: 1, duration: 6, visualType: 'still', narrationRole: 'avatar-dialogue', narration: 'This brand saves users hours every week.', visualPrompt: 'Talking avatar: confident young woman in teal blazer speaking to camera.' },
  ];
  const resolved = resolveNarrationRoles(bad);
  assert.equal(resolved[0].narrationRole, 'avatar-dialogue');
  assert.equal(looksLikeFirstPersonDialogue(resolved[0].narration), false, 'third-person avatar line is NOT first-person');
});

// ═══════════════════════════════ MODE 3: SCENE (VEO MOTION) ═══════════════════════════════
test('scene mode: OCT10 brief — durations compensated identically, F4 holds WITH motion scenes, total_duration integer', () => {
  const r = runSharedPlanner(SCENE_RAW, 'scene');
  assert.ok(r.planned.some(s => s.visualType === 'motion'), 'scene plan must keep motion scenes');
  // F4 still holds with motion scenes
  assert.equal(r.f4StillMissing.length, 0, 'all 7 selling points SPOKEN (scene)');
  const haystack = r.planned.map(s => s.narration).join(' ').toLowerCase();
  for (const key of BENEFIT_KEYS) assert.ok(haystack.includes(key), `"${key}" must be SPOKEN (scene)`);
  // F4 visual ban on BOTH motion and still prompts
  for (const s of r.planned) {
    const low = (s.visualPrompt || '').toLowerCase();
    for (const key of BENEFIT_KEYS) assert.ok(!low.includes(key), `"${key}" must NEVER remain in scene ${s.sceneNumber} visualPrompt`);
  }
  // DUR: identical dissolve compensation (29.8 delivered / 30 int)
  assert.ok(Math.abs(r.delivered - 29.8) < 0.01, `scene delivered must be ~29.8 (got ${r.delivered})`);
  assert.ok(r.delivered >= 29.5 && r.delivered <= 30.5, 'scene delivered in band');
  assert.equal(r.dbSeconds, 30, 'scene total_duration must be INTEGER 30 (PR #114)');
  // motion math: every window inside Veo call bounds; total paid motion ≤ budget
  const windows = r.spanPlans.flatMap(sp => sp.windows);
  assert.ok(windows.length >= 1, 'must have ≥1 Veo motion window');
  for (const w of windows) {
    assert.ok(w.motionSeconds > 0 && w.motionSeconds <= VEO_CALL_SECONDS, `window scene ${w.sceneNumber} must be ≤ VEO_CALL_SECONDS (${VEO_CALL_SECONDS}s)`);
  }
  const totalMotion = r.spanPlans.reduce((a, sp) => a + sp.totalSeconds, 0);
  assert.ok(totalMotion <= VEO_MOTION_BUDGET_SECONDS, `paid motion ${totalMotion}s must never exceed VEO_MOTION_BUDGET_SECONDS (${VEO_MOTION_BUDGET_SECONDS}s)`);
  // span/motion math stays in band: every span window floor ≥ 1, span ≤ 16s take
  for (const sp of r.spanPlans) {
    assert.ok(sp.totalSeconds <= 16, `span totalSeconds ${sp.totalSeconds} must never exceed one 16s take`);
  }
  // subject exact
  assert.ok(r.planned.some(s => /EmpireLaunch AI/i.test(s.narration)), 'subject spoken (scene)');
});

test('capVeoMotionWindows: hard caps motion windows at ≤2 (demotes the tail to stills)', () => {
  // Build 4 motion scenes with windows (2 spans × 2 windows) — constraining shape.
  const script: SceneScript[] = [1, 2, 3, 4].map(n => ({
    sceneNumber: n, duration: 8, visualType: 'motion' as const, soraBlock: Math.floor((n - 1) / 2),
    narration: `scene ${n}`, visualPrompt: `beat ${n}`,
  }));
  const spans = planSoraSpans(script, ['block A', 'block B']);
  assert.ok(spans.length >= 2, 'fixture expects ≥2 spans');
  const windowsBefore = spans.reduce((a, sp) => a + (sp.windows?.length ?? 0), 0);
  assert.ok(windowsBefore > 2, `fixture expects >2 windows before cap (got ${windowsBefore})`);
  const cap = capVeoMotionWindows(script, spans);
  const windowsAfter = cap.spans.reduce((a, sp) => a + (sp.windows?.length ?? 0), 0);
  assert.ok(windowsAfter <= 2, `capVeoMotionWindows must keep ≤2 windows (got ${windowsAfter})`);
  // Demoted scenes became stills in the returned script
  const demoted = cap.script.filter(s => s.visualType === 'still');
  assert.ok(demoted.length === script.length - windowsAfter, 'demoted scenes must become stills (no paid motion)');
  // Every kept window's scene is still motion
  const keptScenes = new Set(cap.spans.flatMap(sp => sp.windows.map(w => w.sceneNumber)));
  for (const s of cap.script) {
    if (keptScenes.has(s.sceneNumber)) assert.equal(s.visualType, 'motion');
  }
});

test('capVeoMotionWindows default = floor(VEO_MOTION_BUDGET/VEO_CALL) = 2 (canonical 2×6s bill)', () => {
  assert.equal(VEO_CALL_SECONDS, 6);
  assert.equal(VEO_MOTION_BUDGET_SECONDS, 12);
  const maxWindows = Math.max(1, Math.floor(VEO_MOTION_BUDGET_SECONDS / VEO_CALL_SECONDS));
  assert.equal(maxWindows, 2, 'canonical Scene motion budget = 2 Veo calls');
});

// ═══════════════════════════════ F2: SHARED ASSEMBLY PATH ═══════════════════════════════
test('F2: faceless + scene plans both flow through the SAME shared concatClips assembler (aParts/amix graph)', () => {
  // The F2 aParts/amix graph (PR #108) lives in sceneVideoPipelineService.concatClips —
  // the ONE assembler every createProject-produced plan (faceless AND scene, and any
  // shared-path twin) renders through. This test pins that single shared entry exists
  // and that both production createProject callers use the same service (approvalController
  // faceless + studioRoutes scene), so F2 holds for all three modes by construction.
  const svc = readRepoFile('src/services/sceneVideoPipelineService.ts');
  assert.ok(/function concatClips/.test(svc), 'sceneVideoPipelineService must own the shared concatClips assembler');
  assert.ok(/aParts/.test(svc), 'concatClips must emit the per-track aParts audio graph');
  assert.ok(/amix=/.test(svc), 'concatClips must mix via amix (normalize=0)');
  const approvalCtrl = readRepoFile('src/controllers/approvalController.ts');
  const studioRoutes = readRepoFile('src/routes/studioRoutes.ts');
  assert.ok(/sceneVideoPipelineService\.createProject/.test(approvalCtrl), 'faceless createProject must run through the shared pipeline service');
  assert.ok(/sceneVideoPipelineService\.createProject/.test(studioRoutes), 'scene createProject must run through the shared pipeline service');
  assert.ok(!/mode.*['"]twin['"]/.test(svc), 'createProject has no twin branch — a shared-path twin would ride the faceless still engine (parity by construction)');
});

// ═══════════════════════════════ ARCHITECTURE PIN: TWIN REBUILD (GAPS CLOSED) ═══════════════════════════════
/** The audit SURFACED five twin gaps (sep engine, GAP1-GAP5). The owner-approved
 *  NEURAL TWIN REBUILD (Oct 11 — "yes, fix twin") re-plumbed the TWIN ENGINE onto
 *  the shared deterministic pipeline: same F4 gauntlet, no-text frames, TTS audio,
 *  integer-safe video_projects insert. These pins assert the CLOSED state — the
 *  twin engine now necessarily rides the same guarantees faceless/scene get. */

test('REBUILD PIN 1 (twin): twin engine now writes video_projects with INTEGER-safe total_duration (GAP1 CLOSED)', () => {
  // PR #114 parity: the twin insert uses deliveredVideoDurationSeconds (29.8 -> 30)
  // + precise metadata.deliveredDurationSeconds; creations/approvals inserts remain.
  const cinemaSrc = readRepoFile('src/services/cinemaEngineService.ts');
  const cinemaController = readRepoFile('src/controllers/cinemaController.ts');
  assert.ok(/insert\(schema\.videoProjects\)/.test(cinemaSrc), 'twin engine must insert a video_projects row (PR #114 parity)');
  assert.ok(/deliveredVideoDurationSeconds/.test(cinemaSrc), 'twin insert must use the INTEGER-safe duration helper');
  assert.ok(/medatadata.deliveredDurationSeconds|deliveredDurationSeconds/.test(cinemaSrc), 'twin metadata must carry precise deliveredDurationSeconds');
  assert.ok(/insert\(schema\.creations\)/.test(cinemaController), 'twin controller still inserts creations rows');
  assert.ok(/insert\(schema\.approvals\)/.test(cinemaController), 'twin controller still inserts approvals rows');
});

test('REBUILD PIN 2 (twin): twin engine now runs the shared F4 gauntlet + TTS voiceover (GAP2 CLOSED)', () => {
  // buildTwinPlan runs injectSellingPointsIntoNarration / verifySellingPointsSpoken /
  // stripBenefitTextFromVisualPrompts on the twin plan; generateSceneAudio voices it.
  const cinemaSrc = readRepoFile('src/services/cinemaEngineService.ts');
  for (const h of ['buildTwinPlan', 'injectSellingPointsIntoNarration', 'verifySellingPointsSpoken', 'stripBenefitTextFromVisualPrompts', 'generateSceneAudio']) {
    assert.ok(cinemaSrc.includes(h), `cinemaEngineService must use ${h} (rebuild)`);
  }
  assert.ok(/twinVoice !== 'none'/.test(cinemaSrc) || /voice !== 'none'/.test(cinemaSrc), 'twin engine respects the shared voice contract incl. voice:none');
});

test('REBUILD PIN 3 (twin): twin frames are NO-TEXT SVGs — F1 no-text holds on the talking head (GAP3 CLOSED)', () => {
  // buildTalkingHeadSvg (baked <text> script line + emotion label) is GONE; frames
  // now render via buildTwinFrameSvg which has NO <text> elements whatsoever.
  const cinemaSrc = readRepoFile('src/services/cinemaEngineService.ts');
  assert.ok(cinemaSrc.includes('export function buildTwinFrameSvg'), 'twin must render frames via the exported clean buildTwinFrameSvg');
  assert.ok(!/private buildTalkingHeadSvg/.test(cinemaSrc), 'legacy text-baking SVG method must be gone (identifier may survive only in comments)');
  const svgStart = cinemaSrc.indexOf('export function buildTwinFrameSvg');
  const svgEnd = cinemaSrc.indexOf('function twinSkinToneToHex', svgStart);
  const svg = cinemaSrc.slice(svgStart, svgEnd > 0 ? svgEnd : svgStart + 2600);
  assert.ok(!/<text/i.test(svg), 'twin frame SVG must contain NO <text> elements (no captions, no emotion label, no script line)');
});

test('REBUILD PIN 4 (twin): twin compose uses the SHARED renderClip+concatClips audio graph (GAP4 CLOSED)', () => {
  // composeTwinVideo renders each segment through renderClip (TTS audio fitted to the
  // segment window) and assembles via concatClips' xfade + aParts/amix graph — the
  // exact assembly faceless/scene use. The legacy silent frame-paced compose is gone.
  const cinemaSrc = readRepoFile('src/services/cinemaEngineService.ts');
  assert.ok(cinemaSrc.includes('private async composeTwinVideo'), 'twin compose method renamed composeTwinVideo');
  assert.ok(!cinemaSrc.includes('composeNeuralTwinVideo'), 'legacy silent compose must be gone');
  const start = cinemaSrc.lastIndexOf('private async composeTwinVideo');
  const end = cinemaSrc.indexOf('  /**', start + 10);
  const compose = cinemaSrc.slice(start, end > 0 ? end : start + 4000);
  assert.ok(/renderClip/.test(compose), 'per-segment clips render via the SHARED renderClip (real audio fit)');
  assert.ok(/concatClips/.test(compose), 'segments assemble via the SHARED concatClips xfade + aParts/amix graph');
  assert.ok(/audioPaths/.test(compose), 'audio flows into the compose from per-segment TTS');
  assert.ok(/audioPaths && audioPaths\[i\]/.test(compose), 'voice:none yields silent-by-design segments');
});

test('REBUILD PIN 5 (twin): twin controllers still call cinemaEngineService (re-plumb lives INSIDE the engine)', () => {
  const cinemaController = readRepoFile('src/controllers/cinemaController.ts');
  const empireStudio = readRepoFile('src/controllers/empireStudioController.ts');
  assert.ok(/cinemaEngineService|CinemaEngine/.test(cinemaController), 'cinemaController must use the cinema engine');
  assert.ok(/createNeuralTwin/.test(empireStudio), 'empireStudio twin route must call createNeuralTwin');
  assert.ok(!/sceneVideoPipelineService\.createProject/.test(cinemaController), 'twin controller must NOT call createProject (talking-head engine reuses shared helpers, not the storyboard planner)');
});

// ─── cross-mode invariant: dissolve-compensated sum is identical for every mode ───
test('cross-mode: dissolve-compensated scene sum contract is mode-independent', () => {
  for (const mode of ['faceless', 'scene'] as const) {
    const r = runSharedPlanner(mode === 'faceless' ? FACELESS_RAW : SCENE_RAW, mode);
    const sum = r.planned.reduce((a, s) => a + s.duration, 0);
    const expected = dissolveCompensatedSceneSum(DURATION, r.planned.length);
    assert.equal(Math.round(sum), Math.round(expected), `mode=${mode}: scene durations must sum to ${expected.toFixed(1)} (dissolve-compensated)`);
  }
});

test('cross-mode: capNarrationForScene SHORT cap holds on every final narration (all modes)', () => {
  for (const [name, raw, mode] of [['faceless', FACELESS_RAW, 'faceless'], ['twin', TWIN_RAW, 'faceless'], ['scene', SCENE_RAW, 'scene']] as const) {
    const r = runSharedPlanner(raw, mode);
    for (const s of r.planned) {
      assert.equal(capNarrationForScene(s.narration, s.duration), s.narration, `mode=${name} scene ${s.sceneNumber} narration must respect the SHORT cap`);
    }
  }
});

test('cross-mode: subject EXACTLY "EmpireLaunch AI" for both Oct-9 AND Oct-10 brief shapes AND all modes', () => {
  assert.equal(subject, 'EmpireLaunch AI');
  // The essence layer is the single source of subject truth for every mode variant:
  for (const [name, raw, mode] of [['faceless', FACELESS_RAW, 'faceless'], ['twin', TWIN_RAW, 'faceless'], ['scene', SCENE_RAW, 'scene']] as const) {
    const r = runSharedPlanner(raw, mode);
    assert.ok(r.planned.some(s => /EmpireLaunch AI/i.test(s.narration)), `mode=${name} must speak the exact subject`);
    assert.ok(r.planned.some(s => /EmpireLaunch AI/i.test(s.visualPrompt ?? '')), `mode=${name} must keep the subject as imagery`);
  }
});

// ─── silent voice:none path parity (launch-gate is voiced; still must not crash) ───
test('voice:none parity: faceless/twin/scene plans build with selling points unspoken by design, visuals carry components', () => {
  for (const [name, raw, mode] of [['faceless', FACELESS_RAW, 'faceless'], ['twin', TWIN_RAW, 'faceless'], ['scene', SCENE_RAW, 'scene']] as const) {
    const r = runSharedPlanner(raw, mode, { voice: false });
    assert.ok(Array.isArray(r.planned) && r.planned.length > 0, `${name} voice:none plan must build`);
    assert.equal(Number.isInteger(r.dbSeconds), true, `${name} voice:none total_duration must stay integer-safe`);
    assert.ok(Math.abs(r.delivered - 29.8) < 0.05, `${name} voice:none delivered must stay in band (got ${r.delivered})`);
  }
});