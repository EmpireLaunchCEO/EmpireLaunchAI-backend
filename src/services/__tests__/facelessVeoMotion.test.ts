/**
 * VEO MOTION INSIDE FACELESS (owner direction, Nov 10 — brief VEO-FACELESS-BRIEF.md,
 * plan rev 192): a 30-second Faceless video spends **16 seconds of Veo in two
 * 8-second calls** and the other 14 seconds on stills. Faceless is the ONE live
 * mode; Scene and Twin are parked.
 *
 * WHAT THIS FILE PINS
 *   1. The target-SUM plan exists and is exactly 16s in two calls ([8, 8]), not the
 *      scene-shaped [6, 8] = 14s. Scene's own plan is unchanged.
 *   2. A 30s Faceless plan produces exactly TWO motion windows totalling 16s, the
 *      hook (first scene) and the payoff (last scene); every other scene is a still.
 *   3. The election is deterministic from the NARRATION — a planner that types
 *      every scene "motion"/"sora" still gets exactly those two windows.
 *   4. THE BACKGROUND GATE: each Veo call is seeded with that scene's STILL, and the
 *      still was drawn from a prompt carrying the client's stated background — the
 *      motion clip shows HER background, not one the model invented. This holds for
 *      a typed sentence and for an agreed suggestion (the #152 provenance).
 *   5. FAIL SOFT: a failed Veo call still yields a finished video with the still in
 *      that window plus a STATED reason, and the project is NOT marked failed —
 *      while Scene keeps its loud failure.
 *   6. THE LEDGER: metadata.motionCost for a Faceless video is two calls, 16s,
 *      $0.48, keyed per window so a retry cannot double-count.
 *   7. THE PICTURE INVARIANT across a mixed motion/still concat, asserted on the
 *      PROBED OUTPUT (never on the ffmpeg arguments).
 *   8. The four locks that locked Faceless out are gone, and the new election is
 *      wired into the real createProject / approval path.
 *
 * ZERO PAID CALLS: renderingEngine.renderImage and veoVideoService.generateSceneVideo
 * are stubbed; every clip is generated locally with ffmpeg.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  planVeoTargetSumDurations,
  planVeoClipDurations,
  veoCostUsd,
  VEO_FACELESS_MOTION_TARGET_SECONDS,
  VEO_FACELESS_MOTION_CALLS,
  VEO_ERRORS,
  veoVideoService,
} from '../veoVideoService.js';
import {
  planFacelessVeoWindows,
  planFacelessVeoSpans,
  applyVeoSceneMotion,
  shouldRenderStillInstead,
  parseScenePlan,
  normalizePlanTimeBudget,
  extractRequestedImagery,
  applyRequestedImagery,
  stripBenefitTextFromVisualPrompts,
  buildSceneImagePrompt,
  concatClips,
  sceneVideoPipelineService,
  type SceneScript,
  type SoraSpan,
} from '../sceneVideoPipelineService.js';
import { renderingEngine } from '../renderingEngine.js';
import { userConversationText } from '../requestedVisuals.js';

const TMP = path.join(process.cwd(), 'temp', 'faceless-veo-motion-tests');
fs.mkdirSync(TMP, { recursive: true });

const DURATION = 30;
const IDEA = 'A 30 second promo for my bakery.';
/** The owner's canonical sentence, verbatim (the background she stated). */
const OWNER_PHRASE = 'a happy family spending time together';
const OWNER_SENTENCE = `The background should be ${OWNER_PHRASE}.`;
const CONVERSATION: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'I want a 30 second video for my bakery.' },
  { role: 'assistant', content: 'Love it — a 30s promo for your bakery. What should it look like?' },
  { role: 'user', content: OWNER_SENTENCE },
  { role: 'assistant', content: `Perfect — ${OWNER_PHRASE} in the background, I'll use that.` },
];

/** The planner's own plan — it never contains her background (the defect). */
const PLANNER_RAW = {
  scenes: [
    { sceneNumber: 1, duration: 6, visualType: 'still', visualPrompt: 'Warm bakery counter at sunrise, fresh loaves, soft window light', narration: 'Fresh bread, baked before the sun comes up.' },
    { sceneNumber: 2, duration: 6, visualType: 'still', visualPrompt: 'Close-up of hands pulling a golden loaf from the oven', narration: 'Every loaf is made by hand, the same way every morning.' },
    { sceneNumber: 3, duration: 6, visualType: 'still', visualPrompt: 'A tidy pastry display case, morning light across the glass', narration: 'Take home something warm for the people you love.' },
    { sceneNumber: 4, duration: 6, visualType: 'still', visualPrompt: 'Coffee being poured beside a paper bakery bag', narration: 'The bread is the reason people come back.' },
    { sceneNumber: 5, duration: 6, visualType: 'still', visualPrompt: 'The bakery storefront at golden hour, open sign glowing', narration: 'Come by this weekend and try it yourself.' },
  ],
};

const SERVICE_SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'), 'utf8');
const APPROVAL_SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'controllers', 'approvalController.ts'), 'utf8');
const ROUTER_SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'aiRouter.ts'), 'utf8');

/**
 * MIRROR of createProject's Faceless planning sequence, in ITS order: parse →
 * exact time budget → the F4 benefit strip → the client-stated imagery carry
 * (AFTER the strip) → the Faceless motion election.
 */
function runFacelessPlan(raw: any = PLANNER_RAW) {
  const requestedImagery = extractRequestedImagery(`${IDEA} ${userConversationText(CONVERSATION)}`);
  const scriptBeforeFloor = parseScenePlan(raw, IDEA, DURATION, 'faceless');
  const timeExact = normalizePlanTimeBudget(scriptBeforeFloor, DURATION, { dissolveCompensate: true });
  const stripped = stripBenefitTextFromVisualPrompts(timeExact, ['50 designs a month', '76 videos a month']);
  const imageryPass = applyRequestedImagery(stripped.script, requestedImagery);
  const beforeElection: SceneScript[] = imageryPass.script.map((s) => ({ ...s }));
  const spans = planFacelessVeoSpans(beforeElection);
  const planned = applyVeoSceneMotion(beforeElection, spans);
  return { planned, spans, requestedImagery, imageryPass };
}

const totalWindows = (spans: SoraSpan[]) => spans.reduce((a, sp) => a + (sp.windows?.length ?? 0), 0);
const totalSeconds = (spans: SoraSpan[]) => spans.reduce((a, sp) => a + sp.windows.reduce((b, w) => b + w.motionSeconds, 0), 0);

// ═══ 1. THE TARGET-SUM PARAMETER (the one number that did not exist) ═════════
test('TARGET SUM: 16 seconds is expressible — and it is exactly two 8-second calls', () => {
  assert.equal(VEO_FACELESS_MOTION_TARGET_SECONDS, 16, 'the owner-approved cost model: 16s of Veo per 30s video');
  assert.equal(VEO_FACELESS_MOTION_CALLS, 2, '...in two calls');
  assert.deepEqual(planVeoTargetSumDurations(16, 2), [8, 8], 'TWO 8s CALLS: [8,8] — never [6,6,4], never the 14s [6,8]');
  assert.deepEqual(planVeoClipDurations(2, 16), [8, 8], 'the target-sum parameter reaches the clip planner');
  assert.equal(planVeoClipDurations(2, 16).reduce((a, b) => a + b, 0), 16, 'the SUM is 16s, not 14s');
  // Scene's own shape is untouched.
  assert.deepEqual(planVeoClipDurations(2), [6, 8], 'Scene keeps its [6,8] = 14s plan');
  assert.deepEqual(planVeoTargetSumDurations(12, 2), [8, 4], 'a shorter video buys less motion (never more than the video)');
});

// ═══ 2. A 30s FACELESS VIDEO: two motion windows, 16s, the rest stills ═══════
test('FACELESS 30s: exactly TWO motion windows totalling 16s — hook + payoff, rest stills', () => {
  const { planned, spans } = runFacelessPlan();
  assert.ok(planned.length >= 3, 'fixture: a real multi-scene plan');
  assert.equal(spans.length, 1, 'one span carries the windows (the shape the worker already reads)');
  assert.equal(totalWindows(spans), 2, 'EXACTLY TWO Veo calls');
  assert.equal(totalSeconds(spans), 16, 'TOTALLING 16s of paid motion');
  assert.deepEqual(spans[0].windows.map((w) => w.motionSeconds), [8, 8], 'two 8-second calls');
  const motion = planned.filter((s) => s.visualType === 'motion').map((s) => s.sceneNumber);
  assert.deepEqual(motion, [1, planned.length], 'the HOOK (first scene) and the PAYOFF (last scene) move');
  assert.equal(planned.filter((s) => s.visualType === 'still').length, planned.length - 2, 'everything else is a still');
  for (const s of planned) {
    if (s.visualType === 'motion') assert.equal(s.soraBlock, 0, 'a motion scene carries its span block');
    else assert.equal(s.soraBlock, undefined, 'a still scene carries no block');
  }
  assert.equal(veoCostUsd(16), 0.48, '16s × $0.03/s = $0.48 — the owner-approved per-video motion cost');
});

test('FACELESS 30s: the planner does NOT choose the motion — a plan that types every scene "sora" still gets two windows', () => {
  const greedy = {
    soraContent: [{ duration: 16, prompt: 'one long take' }],
    scenes: PLANNER_RAW.scenes.map((s) => ({ ...s, visualType: 'motion', type: 'sora' })),
  };
  const { planned, spans } = runFacelessPlan(greedy);
  assert.equal(totalWindows(spans), 2, 'still exactly two — the election is deterministic, not the planner\'s taste');
  assert.equal(totalSeconds(spans), 16, 'and still 16s (never N calls of the planner\'s choosing)');
  assert.deepEqual(
    planned.filter((s) => s.visualType === 'motion').map((s) => s.sceneNumber),
    [1, planned.length],
    'hook + payoff, whatever the planner asked for',
  );
});

test('FACELESS: the windows are a deterministic function of the plan order (no randomness, no clock)', () => {
  const a = planFacelessVeoWindows(parseScenePlan(PLANNER_RAW, IDEA, DURATION, 'faceless').map((s) => ({ ...s, duration: 6 })));
  const b = planFacelessVeoWindows(parseScenePlan(PLANNER_RAW, IDEA, DURATION, 'faceless').map((s) => ({ ...s, duration: 6 })));
  assert.deepEqual(a, b, 'same narration → same windows, byte for byte');
});

// ═══ 3. THE BACKGROUND GATE: the Veo call is seeded with HER still ═══════════
/** Stub the two paid boundaries (the image model and Veo) and capture what they got. */
async function withStubbedProviders<T>(
  veoResponds: 'ok' | 'fail',
  fn: (cap: {
    renderPrompts: string[]; renderUserIds: Array<string | undefined>;
    veoCalls: any[]; costs: Array<{ key: string; seconds: number }>;
    fallbacks: Array<{ id: string; reason: string }>;
  }) => Promise<T>,
): Promise<T> {
  const svc: any = sceneVideoPipelineService;
  const engine: any = renderingEngine;
  const veo: any = veoVideoService;
  const stillPath = path.join(TMP, 'designed-still.png');
  const clipPath = path.join(TMP, 'veo-take.mp4');
  if (!fs.existsSync(stillPath)) {
    fs.writeFileSync(stillPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]));
  }
  if (!fs.existsSync(clipPath)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', clipPath], { maxBuffer: 32 * 1024 * 1024 });
  }
  const cap = {
    renderPrompts: [] as string[],
    renderUserIds: [] as Array<string | undefined>,
    veoCalls: [] as any[],
    costs: [] as Array<{ key: string; seconds: number }>,
    fallbacks: [] as Array<{ id: string; reason: string }>,
  };
  const had = new Set(Object.keys(svc));
  const own: Record<string, any> = {
    recordVeoCost: async (_p: string, key: string, seconds: number) => { cap.costs.push({ key, seconds }); },
    recordMotionFallback: async (id: string, reason: string) => { cap.fallbacks.push({ id, reason }); },
    loadVeoTakeOperation: async () => undefined,
    persistVeoTakeOperation: async () => undefined,
    markVeoJobStatus: async () => undefined,
  };
  Object.assign(svc, own);
  const origRender = engine.renderImage;
  const origVeo = veo.generateSceneVideo;
  engine.renderImage = async (prompt: string, userId?: string) => {
    cap.renderPrompts.push(String(prompt));
    cap.renderUserIds.push(userId);
    return { success: true, imageUrl: stillPath };
  };
  veo.generateSceneVideo = async (opts: any) => {
    cap.veoCalls.push(opts);
    if (veoResponds === 'fail') {
      return { success: false, error: `${VEO_ERRORS.imageRejected} (provider refused the frame)`, operationName: 'op-x' };
    }
    return { success: true, videoPath: clipPath, billedSeconds: opts.durationSeconds, operationName: 'op-1', usedImage: true };
  };
  try {
    return await fn(cap);
  } finally {
    engine.renderImage = origRender;
    veo.generateSceneVideo = origVeo;
    for (const k of Object.keys(own)) {
      if (had.has(k)) continue;
      delete svc[k];
    }
  }
}

function sceneRowsFrom(planned: SceneScript[]) {
  const rows = planned.map((s) => ({
    id: `scene-${s.sceneNumber}`,
    projectId: 'project-faceless',
    sceneNumber: s.sceneNumber,
    duration: s.duration,
    visualType: s.visualType,
    visualPrompt: s.visualPrompt,
    narration: s.narration,
    metadata: {},
  }));
  return { rows, byNumber: new Map<number, any>(rows.map((r) => [r.sceneNumber, r])) };
}

test('THE SEED: every Veo call gets the scene\'s designed STILL as its input image', async () => {
  const { planned, spans } = runFacelessPlan();
  const { rows, byNumber } = sceneRowsFrom(planned);
  await withStubbedProviders('ok', async (cap) => {
    const takes = await (sceneVideoPipelineService as any).generateVeoTakes(
      spans[0], 'project-faceless', 'user-1', undefined, byNumber, undefined, true,
    );
    assert.equal(cap.veoCalls.length, 2, 'two Veo calls — one per elected window');
    for (const call of cap.veoCalls) {
      assert.ok(call.imagePath, `NO SEED IMAGE — Veo was asked to invent the picture: ${JSON.stringify(call.prompt).slice(0, 120)}`);
      assert.ok(fs.existsSync(call.imagePath), 'the seed image is a real file the provider can read');
      assert.deepEqual(call.durationSeconds, 8, 'each call is an 8-second call');
    }
    assert.equal(takes.size, 2, 'both windows produced a take');
    // The still for a motion scene is rendered from the SAME prompt the still path
    // uses — so it carries the client's stated background.
    assert.ok(cap.renderPrompts.length >= 2, 'a designed still per window');
    for (const p of cap.renderPrompts) {
      assert.ok(p.toLowerCase().includes(OWNER_PHRASE), `THE STILL HANDED TO VEO LOST HER BACKGROUND: "${p.slice(0, 160)}"`);
    }
    assert.ok(rows.every((r) => !/studio-lit dark background/i.test(r.visualPrompt)), 'no template backdrop anywhere');
  });
});

test('THE SEED — DISCRIMINATOR: the planner\'s own plan never contained her background', () => {
  const visualText = PLANNER_RAW.scenes.map((s) => s.visualPrompt).join(' ').toLowerCase();
  assert.ok(!visualText.includes(OWNER_PHRASE), 'fixture: the planner invented its own bakery picture');
});

test('THE SEED — AN AGREED SUGGESTION reaches the motion still exactly like a typed one', async () => {
  // #152 (agreed-imagery) is what carries an ACCEPTED suggestion into
  // requestedImagery. When that lands, this test exercises it end to end; until
  // then it pins the seam this build owns: ANY phrase in requestedImagery — whatever
  // its provenance — reaches the still that seeds the Veo call.
  let agreed: any[] = [];
  try {
    const mod: any = await import('../agreedImagery.js');
    agreed = typeof mod.extractAgreedSuggestionImagery === 'function' ? mod.extractAgreedSuggestionImagery(CONVERSATION) : [];
  } catch { agreed = []; }
  const phrase = agreed.length ? String(agreed[0].phrase ?? agreed[0]) : OWNER_PHRASE;
  const { planned, spans } = runFacelessPlan();
  // Simulate the accepted-suggestion provenance: the planner's plan does NOT contain
  // it, and it arrives only through requestedImagery.
  const carried = applyRequestedImagery(
    planned.map((s) => ({ ...s, visualPrompt: s.visualPrompt.replace(new RegExp(OWNER_PHRASE, 'gi'), '').trim() })),
    [{ phrase, scope: 'background', source: OWNER_SENTENCE } as any],
  );
  const elected = applyVeoSceneMotion(carried.script, spans);
  const { byNumber } = sceneRowsFrom(elected);
  await withStubbedProviders('ok', async (cap) => {
    await (sceneVideoPipelineService as any).generateVeoTakes(
      spans[0], 'project-faceless', 'user-1', undefined, byNumber, undefined, true,
    );
    assert.equal(cap.veoCalls.length, 2, 'fixture: both windows called Veo');
    for (const p of cap.renderPrompts) {
      assert.ok(p.toLowerCase().includes(phrase.toLowerCase()), `AN ACCEPTED BACKGROUND DID NOT REACH THE MOTION STILL: "${p.slice(0, 160)}"`);
    }
  });
});

// ═══ 4. FAIL SOFT — the video still finishes, and it says which window ═══════
test('FAIL SOFT: a failed Veo call does not fail the video — the still renders and the reason is STATED', async () => {
  const { planned, spans } = runFacelessPlan();
  const { byNumber } = sceneRowsFrom(planned);
  await withStubbedProviders('fail', async (cap) => {
    const takes = await (sceneVideoPipelineService as any).generateVeoTakes(
      spans[0], 'project-faceless', 'user-1', undefined, byNumber, undefined, true,
    );
    assert.equal(takes.size, 0, 'no take arrived');
    assert.equal(cap.fallbacks.length, 2, 'EACH lost window is named on its own scene record');
    for (const f of cap.fallbacks) {
      assert.ok(/REJECTED|refused/i.test(f.reason), `the reason reaches the record, not a bare count: ${f.reason}`);
    }
    // The scene completes by rendering its still (processScene's decision, pure):
    for (const n of spans[0].sceneNumbers) {
      const row = byNumber.get(n)!;
      assert.equal(
        shouldRenderStillInstead(row, 'faceless', undefined),
        true,
        `faceless window ${n} must fall back to its still, not fail`,
      );
    }
  });
});

test('FAIL SOFT does not weaken Scene: a missing take still fails the scene loudly', () => {
  assert.equal(shouldRenderStillInstead({ visualType: 'motion' }, 'scene', undefined), false, 'Scene keeps its loud failure');
  assert.equal(shouldRenderStillInstead({ visualType: 'motion' }, 'faceless', undefined), true, 'Faceless falls back to the still');
  assert.equal(shouldRenderStillInstead({ visualType: 'motion' }, 'faceless', '/tmp/x.mp4', () => true), false, 'a real take is used, not the still');
  assert.equal(shouldRenderStillInstead({ visualType: 'still' }, 'scene', undefined), true, 'a still scene is a still');
});

test('FAIL SOFT: the project is not marked failed by a lost motion window', () => {
  // The pre-pass catch must record + continue for Faceless, and only Scene may write
  // status:'failed'. Assert the wiring, because that write is what kills the project.
  const start = SERVICE_SRC.indexOf('if (mode === \'faceless\') {', SERVICE_SRC.indexOf('veo_window_takes_failed'));
  assert.ok(start > 0, 'the pre-pass has a Faceless branch');
  const branch = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf('const ids = span.sceneNumbers', start));
  assert.ok(/recordMotionFallback/.test(branch), 'it records the reason on the scene');
  assert.ok(/continue;/.test(branch), 'and skips the failure marking entirely');
  assert.ok(!/status: 'failed'/.test(branch), 'a lost Faceless window NEVER marks the scene failed');
  assert.ok(/if \(mode === 'faceless'\) await this\.recordMotionFallbacks\(projectId\)/.test(SERVICE_SRC),
    'and the lost windows are rolled up onto the project so the client is told');
});

// ═══ 5. THE COST LEDGER ═════════════════════════════════════════════════════
test('LEDGER: a Faceless video records two calls / 16s / $0.48, keyed per window', async () => {
  const { planned, spans } = runFacelessPlan();
  const { byNumber } = sceneRowsFrom(planned);
  await withStubbedProviders('ok', async (cap) => {
    await (sceneVideoPipelineService as any).generateVeoTakes(
      spans[0], 'project-faceless', 'user-1', undefined, byNumber, undefined, true,
    );
    assert.equal(cap.costs.length, 2, 'one ledger entry per window');
    const keys = cap.costs.map((c) => c.key);
    assert.equal(new Set(keys).size, 2, 'DISTINCT keys — a retry of one window can never double-count the other');
    assert.deepEqual(cap.costs.map((c) => c.seconds).sort((a, b) => a - b), [8, 8], 'two 8-second calls');
    const billed = cap.costs.reduce((a, c) => a + c.seconds, 0);
    assert.equal(billed, 16, 'metadata.motionCost.billedSeconds would be 16');
    assert.equal(veoCostUsd(billed), 0.48, 'metadata.motionCost.usd would be $0.48');
  });
});

// ═══ 6. THE PICTURE INVARIANT ON A MIXED MOTION/STILL CONCAT ════════════════
test('PICTURE INVARIANT: a motion clip and a still clip concat to one clean 9:16 stream (probed OUTPUT)', async () => {
  const motion = path.join(TMP, 'mix-motion.mp4');
  const still = path.join(TMP, 'mix-still.mp4');
  const out = path.join(TMP, 'mix-out.mp4');
  // The motion window: a real moving picture (the Veo take's shape).
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', motion], { maxBuffer: 64 * 1024 * 1024 });
  // The still window: the SAME frame held (Ken Burns' output shape).
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x203040:size=1080x1920:rate=30:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', still], { maxBuffer: 64 * 1024 * 1024 });
  await concatClips([motion, still], out, { joins: 'match-cut' } as any);
  const probe = (args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args], { maxBuffer: 4 * 1024 * 1024 }).toString().trim();
  const streams = probe(['-show_entries', 'stream=codec_type,width,height,pix_fmt,avg_frame_rate', '-of', 'default=noprint_wrappers=1', out]);
  assert.ok(/codec_type=video/.test(streams), 'the output has a video stream');
  assert.ok(/width=1080/.test(streams) && /height=1920/.test(streams), `the picture invariant holds across the mixed concat: ${streams}`);
  assert.ok(/pix_fmt=yuv420p/.test(streams), 'yuv420p, as every downstream reader expects');
  const duration = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
  assert.ok(duration > 2.5, `the motion AND the still are both in the delivered file (got ${duration}s)`);
  const frames = parseInt(probe(['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1:nokey=1', out]), 10);
  assert.ok(frames > 60, `frames decoded from the output (got ${frames}) — a -map that disagrees with its input fails HERE, not in the arguments`);
});

// ═══ 7. THE FOUR LOCKS ARE GONE, AND THE ELECTION IS WIRED ══════════════════
test('WIRING: the four locks that kept Faceless still are removed', () => {
  assert.ok(!/mode === 'faceless'\) \{ for \(const s of scriptBeforeFloor\) \{ s\.visualType = 'still'; \} \}/.test(SERVICE_SRC),
    'lock 2 gone: createProject no longer forces every Faceless scene to a still');
  assert.ok(!/visualType: 'still' as const, soraBlock: undefined \}\)\);/.test(SERVICE_SRC),
    'lock 1 gone: parseScenePlan no longer forces stills for Faceless');
  assert.ok(!/let spanPlans = mode === 'scene' \? capVeoMotionWindows\(planned, planVeoSceneSpans\(planned\)\)\.spans : \[\];/.test(SERVICE_SRC),
    'lock 3 gone: Faceless is not given an empty span plan');
  assert.ok(/let spanPlans = mode === 'scene'\s*\n\s*\? capVeoMotionWindows\(planned, planVeoSceneSpans\(planned\)\)\.spans\s*\n\s*: planFacelessVeoSpans\(planned\);/.test(SERVICE_SRC),
    'Faceless elects its own windows');
  assert.ok(!/isMotion && mode === 'scene' \? \{ veoWindowReady: true \}/.test(SERVICE_SRC),
    'lock 4 gone: veoWindowReady is written for Faceless motion scenes too');
  assert.ok(/\.\.\.\(isMotion \? \{ veoWindowReady: true \} : \{\}\),/.test(SERVICE_SRC), 'and it is written for every motion scene');
  // The election runs for BOTH modes, so the planner can never leave a stray motion scene.
  assert.ok(/planned\.splice\(0, planned\.length, \.\.\.applyVeoSceneMotion\(planned, spanPlans\)\);/.test(SERVICE_SRC),
    'the elected windows are projected onto the plan for both modes');
});

test('WIRING: a failed Faceless render is no longer reported as a success', () => {
  const catchAt = APPROVAL_SRC.indexOf('[Approval] Faceless render init failed:');
  assert.ok(catchAt > 0, 'the catch still exists (it must log)');
  const body = APPROVAL_SRC.slice(catchAt, catchAt + 1200);
  assert.ok(/return res\.status\(422\)/.test(body), 'it ANSWERS the client instead of returning a 201 receipt for a dead project');
  assert.ok(/clientMessage/.test(body), 'with the pipeline\'s own client-facing reason');
  assert.ok(/RENDER_INIT_FAILED/.test(body), 'and a machine-readable code');
});

test('WIRING: the consultant stops offering invented stock defaults and asks instead', () => {
  assert.ok(!/background: I'd suggest a cozy home-studio scene/.test(ROUTER_SRC), 'the stock background default is gone');
  assert.ok(!/confidently pick trending options/.test(ROUTER_SRC), '"you decide" no longer means "pick something generic"');
  assert.ok(/NEVER INVENT A SUBJECT OR BACKGROUND/.test(ROUTER_SRC), 'the consultant is told to ask');
  assert.ok(/DECIDE FROM THEIR MESSAGE/.test(ROUTER_SRC), '"you decide" is grounded in the client\'s own words');
  assert.ok(/gold tower/.test(ROUTER_SRC) && /skyscraper/.test(ROUTER_SRC) && /handshake/.test(ROUTER_SRC),
    'and the owner\'s banned clichés are named');
});

test('WIRING: the motion still is uploaded like every other still (it used to pass no userId)', () => {
  const at = SERVICE_SRC.indexOf('private async renderSceneStillForMotion');
  assert.ok(at > 0);
  const fn = SERVICE_SRC.slice(at, at + 2600);
  assert.ok(/renderImage\(\s*\n\s*withSourceSubject\(visualPrompt, usableSource\),\s*\n\s*userId,/.test(fn),
    'the motion still passes the userId, so the frame Veo started from is retrievable from R2');
});
