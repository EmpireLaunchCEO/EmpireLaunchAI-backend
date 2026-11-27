/**
 * COST PRE-FLIGHT + NO SPEND AFTER THE FIRST PAID FAILURE (owner, 23 Nov).
 *
 * Owner's words: "if no video gets produced or it fails up front ... it needs to be
 * stopped from ending up running Veo or gpt so there is no cost. I don't need videos
 * being half produced and then failing still using Veo cost."
 *
 * These fixtures COUNT PROVIDER CALLS, they do not just check statuses:
 *
 *   1. a request the pre-flight refuses  → ZERO planner / image / audio / Veo calls,
 *      the project failed with the pre-flight's own reason, quota untouched;
 *   2. after the first paid failure      → every later paid call is refused BEFORE
 *      its provider is touched;
 *   3. a healthy request                 → the pre-flight buys nothing and the gate
 *      passes every call straight through, exactly once.
 *
 * The three provider spies are the REAL modules the pipeline imports
 * (`aiRouter.route`, `renderingEngine.renderImage`, `veoVideoService.generateSceneVideo`)
 * with their methods replaced by counters, so the count is the pipeline's own call
 * count, not a fixture's. GPT Audio is reached through `generateSceneAudio` (a module
 * binding that cannot be replaced from outside), so it is counted at the one choke
 * point every paid call goes through — `paidCall()` — which the source audit below
 * proves audio is not able to bypass.
 *
 * ZERO SPEND: no provider is contacted, no model is called, no media is generated.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { aiRouter } from '../aiRouter.js';
import { renderingEngine } from '../renderingEngine.js';
import { veoVideoService } from '../veoVideoService.js';
import { usageService, WEEKLY_FACELESS_LIMIT } from '../usageService.js';
import { sceneVideoPipelineService, CostPreflightFailedError } from '../sceneVideoPipelineService.js';
import {
  runCostPreflight,
  FACELESS_LEGAL_LENGTHS,
  REQUIRED_FFMPEG_FILTERS,
  COST_PREFLIGHT_FAILED_CODE,
  type CostPreflightDeps,
} from '../costPreflight.js';
import {
  paidCall,
  notePaidFailure,
  paidCallAllowed,
  clearPaidFailure,
  paidFailureFor,
  PaidCallBlockedError,
  __resetPaidFailures,
  __paidCallAttempts,
  __resetPaidCallAttempts,
} from '../paidCallGate.js';

const SERVICE_SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'), 'utf8');

// ─── the provider spies ─────────────────────────────────────────────────────
const calls = { planner: 0, image: 0, audio: 0, veo: 0 };
const restore: Array<() => void> = [];

function spyOn(target: any, method: string, key: keyof typeof calls, result: any) {
  const original = target[method];
  target[method] = async (..._args: any[]) => {
    calls[key] += 1;
    return typeof result === 'function' ? result(..._args) : result;
  };
  restore.push(() => { target[method] = original; });
}

// ─── the fixture's fresh allowance ──────────────────────────────────────────
// `createProject` reads the REAL counter (`usageService.getDailyRemaining`) and
// that counter answers 0 in two different worlds: the fixture user has spent
// their week, and the database could not be reached ("Safe default on error").
// The quota check runs BEFORE the photo check, so either one turns the photo
// fixture into a `quota` refusal — a check nobody asked about masking the check
// under test. So every fixture SEEDS A FRESH ALLOWANCE, the way a new client's
// week starts, and the allowance is re-seeded for each test: no fixture can
// inherit the previous one's spend or the machine's database state. The quota
// refusal itself is still proven, with injected deps, further down.
const FRESH_ALLOWANCE = WEEKLY_FACELESS_LIMIT;
let quotaReads = 0;
let quotaAllowance: number | 'unlimited' = FRESH_ALLOWANCE;

/** A fresh week for the fixture user: full allowance, and the counter's reads are counted. */
function seedFreshAllowance() {
  quotaAllowance = FRESH_ALLOWANCE;
  quotaReads = 0;
}

function resetCounts() {
  calls.planner = 0; calls.image = 0; calls.audio = 0; calls.veo = 0;
  __resetPaidFailures();
  __resetPaidCallAttempts();
  seedFreshAllowance();
}

before(() => {
  spyOn(aiRouter, 'route', 'planner', { classification: 'ai_assistant', prompt: 'not a plan' });
  spyOn(renderingEngine, 'renderImage', 'image', { success: false, error: 'the image provider must not be called' });
  spyOn(veoVideoService, 'generateSceneVideo', 'veo', { success: false, error: 'the Veo provider must not be called' });
  const originalQuota = usageService.getDailyRemaining;
  const quotaSpy = async () => { quotaReads += 1; return quotaAllowance; };
  (usageService as any).getDailyRemaining = quotaSpy;
  restore.push(() => { delete (usageService as any).getDailyRemaining; });
  assert.equal(typeof originalQuota, 'function', 'the counter this fixture seeds must exist on the real service');
  seedFreshAllowance();
});

after(() => { for (const undo of restore) undo(); });

const baseInput = (over: Record<string, any> = {}) => ({
  userId: '11111111-2222-4333-8444-555555555555',
  title: 'Cost pre-flight',
  idea: 'A 15 second promo for my candle shop.',
  durationTarget: 15,
  voice: 'female' as const,
  tone: 'auto' as const,
  mode: 'faceless' as const,
  ...over,
});

/** Every paid call the pipeline could make, counted. */
const allZero = (label: string) => {
  assert.deepEqual(calls, { planner: 0, image: 0, audio: 0, veo: 0 }, `${label}: no provider may be contacted`);
  const attempted = __paidCallAttempts();
  assert.equal(attempted.planner + attempted.image + attempted.audio + attempted.veo, 0,
    `${label}: not even an attempt may reach the gate (attempts=${JSON.stringify(attempted)})`);
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE REAL ENTRY POINT REFUSES A BAD REQUEST AT $0
// ═══════════════════════════════════════════════════════════════════════════

test('createProject: an illegal voice fails the project with its own reason — ZERO paid calls', async () => {
  resetCounts();
  const err: any = await sceneVideoPipelineService
    .createProject(baseInput({ voice: 'robot' as any }))
    .then(() => null, (e) => e);

  assert.ok(err, 'createProject must refuse');
  assert.equal(err.name, 'CostPreflightFailedError', `got ${err?.name}: ${err?.message}`);
  assert.ok(err instanceof CostPreflightFailedError);
  assert.equal(err.code, COST_PREFLIGHT_FAILED_CODE, 'the route answers 422 with this code');
  assert.equal(err.check, 'voice', 'the reason names WHICH check refused');
  assert.match(err.message, /robot/);
  // Owner (23 Nov): no client sentence mentions money, so this asserts what happened
  // to the video and that no charge/cost/refund/quota wording crept back in.
  assert.match(err.clientMessage, /(wasn't made|was not made)/i, 'the client is told the video was not made');
  assert.match(err.clientMessage, /\?/, 'a refusal the client can fix asks one question (owner, 23 Nov)');
  assert.doesNotMatch(err.clientMessage, /charg|cost|refund|quota|money/i,
    'no client-facing sentence mentions money (owner, 23 Nov)');
  // THE PROOF: the planner (the first paid call) was never reached.
  allZero('illegal voice');
});

test('createProject: a length that is not one of the three fails at $0', async () => {
  resetCounts();
  const err: any = await sceneVideoPipelineService
    .createProject(baseInput({ durationTarget: 22 }))
    .then(() => null, (e) => e);
  assert.equal(err?.check, 'duration', `got ${err?.check}: ${err?.message}`);
  assert.match(err.message, new RegExp(FACELESS_LEGAL_LENGTHS.join(', ')));
  allZero('illegal duration');
});

test('createProject: an illegal tone fails at $0', async () => {
  resetCounts();
  const err: any = await sceneVideoPipelineService
    .createProject(baseInput({ tone: 'shouty' as any }))
    .then(() => null, (e) => e);
  assert.equal(err?.check, 'tone', `got ${err?.check}: ${err?.message}`);
  allZero('illegal tone');
});

test('createProject: a photo that does not resolve fails at $0 — before the planner', async () => {
  resetCounts();
  // A real HEAD to a host that cannot answer: the check must REFUSE, not pass.
  const err: any = await sceneVideoPipelineService
    .createProject(baseInput({ sourceImages: ['https://photo.invalid/does-not-resolve.png'] }))
    .then(() => null, (e) => e);
  assert.equal(err?.check, 'photo', `got ${err?.check}: ${err?.message}`);
  assert.match(err.message, /photo you uploaded \(does-not-resolve\.png\) does not resolve/, 'the refusal names the file she uploaded');
  // The allowance was FRESH and it was read and passed — so the refusal above is
  // the photo check's, never a quota refusal standing in front of it.
  assert.equal(quotaReads, 1, 'the pre-flight must read the fresh allowance exactly once');
  assert.equal(quotaAllowance, FRESH_ALLOWANCE, 'the fixture must start with a full allowance');
  allZero('dead photo');
});

test('the photo: a STALE SIGNED LINK is refreshed and retried — the video proceeds', async () => {
  // Owner, 23 Nov: repair before refusal. A stored upload URL is a presigned link; when
  // its signature has expired the OBJECT is still there. Refusing on the first failed
  // fetch threw away a video that one free re-sign could have made.
  const stale = 'https://acct.r2.cloudflarestorage.com/bucket/brands/u1/uploads/hand-poured-candle.png?X-Amz-Signature=expired';
  const fresh = 'https://acct.r2.cloudflarestorage.com/bucket/brands/u1/uploads/hand-poured-candle.png?X-Amz-Signature=new';
  const probed: string[] = [];
  const result = await runCostPreflight(healthy(
    { sourceImages: [stale] },
    {
      ...healthyDeps,
      probeUrl: async (url: string) => {
        probed.push(url);
        return url === fresh ? { ok: true, status: 206 } : { ok: false, status: 403, detail: 'HTTP 403' };
      },
      refreshUrl: async (url: string) => (url === stale ? fresh : null),
    },
  ));

  assert.equal(result.ok, true, `a stale signature must not refuse the video: ${result.reason}`);
  assert.deepEqual(probed, [stale, fresh], 'the fresh link is probed exactly once, after the stored one');
  assert.deepEqual(result.sourceImages, [fresh], 'the render must be handed the URL that actually resolves');
  assert.equal(result.photoRepairs?.length, 1, 'and the repair is recorded so the client can be told');
  assert.equal(result.photoRepairs?.[0].from, stale);
  assert.equal(result.photoRepairs?.[0].to, fresh);
});

test('the photo: genuinely GONE after a refresh still refuses — names her file, buys nothing', async () => {
  const stale = 'https://acct.r2.cloudflarestorage.com/bucket/brands/u1/uploads/hand-poured-candle.png?X-Amz-Signature=expired';
  const fresh = 'https://acct.r2.cloudflarestorage.com/bucket/brands/u1/uploads/hand-poured-candle.png?X-Amz-Signature=new';
  let refreshed = 0;
  const result = await runCostPreflight(healthy(
    { sourceImages: [stale] },
    {
      ...healthyDeps,
      probeUrl: async () => ({ ok: false, status: 404, detail: 'HTTP 404' }),
      refreshUrl: async () => { refreshed += 1; return fresh; },
    },
  ));

  assert.equal(result.ok, false);
  assert.equal(result.check, 'photo');
  assert.equal(refreshed, 1, 'the repair is attempted before anything is refused');
  assert.match(result.reason!, /hand-poured-candle\.png/, 'the refusal names the file she uploaded');
  assert.match(result.reason!, /no longer there/, 'and says it is gone, not that the check was skipped');
  assert.match(result.reason!, /not started/);
});

test('the photo: a link we CANNOT re-sign refuses rather than inventing one', async () => {
  const result = await runCostPreflight(healthy(
    { sourceImages: ['https://cdn.example.com/uploads/photo.png'] },
    { ...healthyDeps, probeUrl: async () => ({ ok: false, status: 403 }), refreshUrl: async () => null },
  ));
  assert.equal(result.check, 'photo');
  assert.match(result.reason!, /photo\.png/);
});

test('wiring: the refreshed link is the link the render uses, and the client is told what was repaired', () => {
  // The pre-flight can only SAVE a video if the pipeline adopts the fresh URL and
  // records the repair in a sentence a client can read.
  assert.match(SERVICE_SRC, /input\.sourceImages = preflight\.sourceImages/, 'the fresh link must replace the stored one before anything reads it');
  assert.match(SERVICE_SRC, /repairs:\{photoUrlRefreshed:/, 'the repair is recorded on the project');
  assert.match(SERVICE_SRC, /The link to your uploaded photo had expired/, 'in a plain sentence, never a code');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. EVERY FREE CHECK, ONE AT A TIME (deps injected, so each check is isolated)
// ═══════════════════════════════════════════════════════════════════════════

const healthyDeps: CostPreflightDeps = {
  probeUrl: async () => ({ ok: true, status: 200 }),
  probeFfmpeg: () => ({ ok: true, missing: [] }),
  probeWorkDir: () => ({ ok: true }),
};
const healthy = (over: Record<string, any> = {}, deps: CostPreflightDeps = healthyDeps) => ({
  projectId: randomUUID(),
  mode: 'faceless' as const,
  durationTarget: 15,
  voice: 'female',
  tone: 'auto',
  sourceImages: [],
  quotaRemaining: async () => 12,
  deps,
  ...over,
});

test('a healthy request passes the pre-flight and buys NOTHING', async () => {
  resetCounts();
  const result = await runCostPreflight(healthy());
  assert.deepEqual(result, { ok: true });
  allZero('healthy pre-flight');
});

test('quota: no videos left refuses, and the counter is only READ (never written)', async () => {
  resetCounts();
  let reads = 0;
  const result = await runCostPreflight(healthy({ quotaRemaining: async () => { reads += 1; return 0; } }));
  assert.equal(result.ok, false);
  assert.equal(result.check, 'quota');
  assert.match(result.reason!, /No videos are left/);
  assert.equal(reads, 1, 'the quota counter is read exactly once — a pre-flight never spends quota');
  allZero('no quota');
});

test('quota: "unlimited" is a pass, not a refusal', async () => {
  const result = await runCostPreflight(healthy({ quotaRemaining: async () => 'unlimited' }));
  assert.deepEqual(result, { ok: true });
});

test('ffmpeg: a missing filter refuses, naming the filter the render needs', async () => {
  resetCounts();
  const result = await runCostPreflight(healthy({}, {
    ...healthyDeps,
    probeFfmpeg: () => ({ ok: false, missing: ['xfade', 'zoompan'] }),
  }));
  assert.equal(result.check, 'ffmpeg');
  assert.match(result.reason!, /xfade, zoompan/);
  allZero('missing ffmpeg filter');
});

test('ffmpeg: a machine with no ffmpeg at all refuses, naming our own tool', async () => {
  const result = await runCostPreflight(healthy({}, {
    ...healthyDeps,
    probeFfmpeg: () => ({ ok: false, missing: [...REQUIRED_FFMPEG_FILTERS], detail: 'spawn ffmpeg ENOENT' }),
  }));
  assert.equal(result.check, 'ffmpeg');
  assert.match(result.reason!, /ffmpeg on this machine cannot assemble a video \(spawn ffmpeg ENOENT\)/);
});

test('render directory: an unwritable / too-full directory refuses', async () => {
  const result = await runCostPreflight(healthy({}, {
    ...healthyDeps,
    probeWorkDir: () => ({ ok: false, detail: 'only 4 MB free in the render directory, the render needs 300 MB' }),
  }));
  assert.equal(result.check, 'workdir');
  assert.match(result.reason!, /4 MB free/);
});

test('the photo: a non-2xx answer refuses; a presigned 206 passes', async () => {
  const bad = await runCostPreflight(healthy(
    { sourceImages: ['https://r2.example/photo.png'] },
    { ...healthyDeps, probeUrl: async () => ({ ok: false, status: 403, detail: 'HTTP 403' }) },
  ));
  assert.equal(bad.check, 'photo');
  assert.match(bad.reason!, /HTTP 403/);

  const good = await runCostPreflight(healthy(
    { sourceImages: ['https://r2.example/photo.png'] },
    { ...healthyDeps, probeUrl: async () => ({ ok: true, status: 206 }) },
  ));
  assert.deepEqual(good, { ok: true });
});

test('THE REAL MACHINE: the pre-flight PASSES a good request here (it may not refuse a video for obeying the brief)', async () => {
  // No injected deps: the real ffmpeg probe, the real render directory, the real
  // quota reader shape. A gate that refused a producible video would be worse than
  // no gate, so this is asserted on the actual machine.
  const projectId = randomUUID();
  const result = await runCostPreflight({
    projectId,
    mode: 'faceless',
    durationTarget: 15,
    voice: 'female',
    tone: 'auto',
    sourceImages: [],
    quotaRemaining: async () => 15,
  });
  assert.deepEqual(result, { ok: true }, `the real machine refused a good request: ${result.reason}`);
  fs.rmSync(path.join(process.cwd(), 'temp', 'scene-projects', projectId), { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. AFTER THE FIRST PAID FAILURE, NOTHING MORE IS BOUGHT
// ═══════════════════════════════════════════════════════════════════════════

test('the gate: after a planner failure, image / audio / Veo are REFUSED before their provider is touched', async () => {
  resetCounts();
  const projectId = randomUUID();

  // The planner is the first paid call of the run — it is allowed and it fails.
  notePaidFailure(projectId, 'planner', 'planner call failed: 503 from the model provider');
  assert.equal(paidCallAllowed(projectId), false);
  assert.deepEqual(paidFailureFor(projectId), { kind: 'planner', reason: 'planner call failed: 503 from the model provider' });

  for (const kind of ['image', 'audio', 'veo', 'planner'] as const) {
    let invoked = 0;
    const err: any = await paidCall({ projectId, kind }, async () => { invoked += 1; return 'should never run'; })
      .then(() => null, (e) => e);
    assert.ok(err instanceof PaidCallBlockedError, `${kind}: must be refused`);
    assert.equal(err.code, 'PAID_CALL_BLOCKED');
    assert.equal(err.kind, kind);
    assert.match(err.reason, /503 from the model provider/, 'the FIRST failure is the reason the client is told');
    assert.equal(invoked, 0, `${kind}: the provider function must NOT be invoked`);
  }
  // The gate WAS reached four times — and every one was refused. No provider ran.
  assert.deepEqual(__paidCallAttempts(), { planner: 1, image: 1, audio: 1, veo: 1, scene: 0 },
    'each paid step was attempted and refused at the gate');
  assert.deepEqual(calls, { planner: 0, image: 0, audio: 0, veo: 0 }, 'no provider was contacted');
});

test('the gate: the FIRST failure wins — a later one never rewrites the reason', () => {
  resetCounts();
  const projectId = randomUUID();
  notePaidFailure(projectId, 'veo', 'Veo window block0-scene2 failed: quota exceeded on the project');
  notePaidFailure(projectId, 'image', 'a different later error');
  assert.equal(paidFailureFor(projectId)?.reason, 'Veo window block0-scene2 failed: quota exceeded on the project');
});

test('the gate: one project failing does not stop another from spending', async () => {
  resetCounts();
  const failed = randomUUID();
  const other = randomUUID();
  notePaidFailure(failed, 'image', 'gpt-image-2 refused the prompt');
  assert.equal(paidCallAllowed(failed), false);
  assert.equal(paidCallAllowed(other), true);
  const value = await paidCall({ projectId: other, kind: 'image' }, async () => 'rendered');
  assert.equal(value, 'rendered');
  assert.equal(calls.image, 0, 'the spy is not what ran here — the gate ran the fixture function');
});

test('the gate: a retry is a NEW run — clearing the failure lets the same project spend again', async () => {
  resetCounts();
  const projectId = randomUUID();
  notePaidFailure(projectId, 'planner', 'planner returned no plan');
  assert.equal(paidCallAllowed(projectId), false);
  clearPaidFailure(projectId);
  assert.equal(paidCallAllowed(projectId), true);
  const value = await paidCall({ projectId, kind: 'planner' }, async () => 'planned');
  assert.equal(value, 'planned');
});

test('the gate: a healthy project passes every call straight through, exactly once each', async () => {
  resetCounts();
  const projectId = randomUUID();
  let ran = 0;
  for (const kind of ['planner', 'image', 'audio', 'veo'] as const) {
    await paidCall({ projectId, kind }, async () => { ran += 1; });
  }
  assert.equal(ran, 4, 'one call per paid step — no extra calls, none swallowed');
  assert.deepEqual(__paidCallAttempts(), { planner: 1, image: 1, audio: 1, veo: 1, scene: 0 });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE WIRING: no paid call in the pipeline can bypass the gate
//    (a source audit, the same way the repo already proves structural rules —
//     facelessVeoWindowFit.test.ts reads this same file)
// ═══════════════════════════════════════════════════════════════════════════

test('wiring: every paid provider call site in the pipeline is wrapped in paidCall()', () => {
  const paidCalls = ['aiRouter.route(', 'renderingEngine.renderImage(', 'veoVideoService.generateSceneVideo(', 'this.generateAudio('];
  const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);
  for (const name of paidCalls) {
    const sites = SERVICE_SRC.split('\n').filter((line) => line.includes(name) && !isComment(line));
    assert.ok(sites.length > 0, `${name}: no call site found — the audit would prove nothing`);
    const ungated = sites.filter((line) => !line.includes('paidCall('));
    assert.deepEqual(ungated, [],
      `${name}: ${ungated.length} call site(s) are NOT inside paidCall() and would be bought after a failure: ${ungated.map((l) => l.trim()).join(' | ')}`);
  }
});

test('wiring: the pre-flight runs BEFORE the planner\'s first paid call', () => {
  const preflight = SERVICE_SRC.indexOf('await runCostPreflight(');
  const planner = SERVICE_SRC.indexOf('gpt52_script_start');
  const plannerCall = SERVICE_SRC.indexOf('runPlanningAttempts({');
  assert.ok(preflight > 0 && planner > 0 && plannerCall > 0, 'all three stages must exist');
  assert.ok(preflight < planner, 'the pre-flight must run before the planner stage');
  assert.ok(preflight < plannerCall, 'the pre-flight must run before the planner is CALLED');
  // …and before every media call site.
  for (const media of ['renderingEngine.renderImage(', 'this.generateAudio(', 'veoVideoService.generateSceneVideo(']) {
    // lastIndexOf: the real call site, not a doc comment that names it earlier in the file.
    assert.ok(preflight < SERVICE_SRC.lastIndexOf(media), `the pre-flight must run before ${media}`);
  }
});

test('wiring: every failure that abandons the render RECORDS it, and the Faceless fail-soft does not', () => {
  // The planner: both the throw and an unusable plan.
  assert.match(SERVICE_SRC, /notePaidFailure\(projectId, 'planner'/, 'a failed planner call must arm the gate');
  assert.match(SERVICE_SRC, /if \(!plannerOutcome\.planned\) \{\s*notePaidFailure\(projectId, 'planner'/, 'an unusable plan must arm the gate before the paid repair call');
  // A scene that fails (its still, its narration, its motion) abandons the project.
  assert.match(SERVICE_SRC, /notePaidFailure\(scene\.projectId, error instanceof PaidCallBlockedError \? error\.kind : 'scene'/, 'a failed scene must arm the gate');
  // A failed narration abandons the render (assembly refuses a silent video).
  assert.match(SERVICE_SRC, /notePaidFailure\(scene\.projectId, 'audio'/, 'a failed audio call must arm the gate');
  // A Scene-mode lost Veo window abandons the render …
  assert.match(SERVICE_SRC, /notePaidFailure\(projectId, 'veo'/, 'a lost Scene-mode window must arm the gate');
  // … while the Faceless fail-soft path must still NOT arm it (owner, Nov 10).
  const softFail = SERVICE_SRC.indexOf("if (mode === 'faceless') {");
  const armVeo = SERVICE_SRC.indexOf("notePaidFailure(projectId, 'veo'");
  assert.ok(softFail > 0 && armVeo > softFail, 'the Scene-mode arm must come AFTER the Faceless fail-soft branch, so fail-soft is untouched');
});

test('wiring: the scene loop stops buying after a failure instead of rendering the rest', () => {
  assert.match(SERVICE_SRC, /if \(!paidCallAllowed\(projectId\)\) \{[\s\S]{0,400}scene_blocked_after_paid_failure/,
    'a scene that has not started must be failed, not bought');
});
