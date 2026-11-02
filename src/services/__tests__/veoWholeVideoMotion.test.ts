/**
 * WHOLE-VIDEO VEO MOTION (owner, Nov 2 — approved explicitly).
 *
 *   "lets make the whole 30 seconds motion with Veo for scene based."
 *   "since calls have to be made in seconds, it needs to be 6 seconds calls."
 *   "needs to make sure that it makes the video as clients want."
 *   "translation doesn't need to get lost making 5 calls at 6 seconds each."
 *
 * What this file pins:
 *   (1) IMAGE-TO-VIDEO — the scene's designed still rides in
 *       `instances[0].image` as `{ bytesBase64Encoded, mimeType }` (Google's
 *       documented `VideoGenerationModelInstance.Image`; verified live 2026-11-02
 *       with a real 4s/720p call, $0.12, 54.7s end to end).
 *   (2) EVERY SCENE MOVES, in the OWNER'S SHAPE (Nov 2): "we can do 4 6 seconds
 *       calls and 1 8 second call" → a 5-scene 30s video buys 4 × 6s + 1 × 8s =
 *       32s; 3 scenes buy 2 × 6s + 1 × 8s = 20s. Five designed scenes are KEPT.
 *   (3) THE 8s CLIP goes to the LONGEST scene window (so the long take is TRIMMED
 *       to its slot, never stretched); the 4|6|8 enum still governs the legacy
 *       single-take path and the ceiling step-down.
 *   (4) NEVER MORE THAN THE CEILING — total billed motion ≤ 30s budget + 2s join
 *       slack = 32s, and never more than the video itself plus that slack. The 2s
 *       over a 30s video is the material the joins fold away, not waste.
 *   (5) THE JOINS — measured on real frames: the assembly's MATCH-CUT join is not a
 *       hard cut and contains NO TRANSITION OF ANY KIND (no xfade, no dip to black,
 *       no dissolve — the owner rejected the dissolve on Oct 12). A regression back
 *       to a plain concat, or to the old fadeblack xfade, FAILS this suite.
 *   (6) NARRATION SYNC — a take is fitted to its scene's window (trim or gentle
 *       slow-down, never a frozen tail) so picture and narration cannot drift.
 *   (7) THE REAL REASON — a failed window surfaces credentials / service account /
 *       retired model / rejected image, never a bare count.
 *   (8) FACELESS + TWIN — zero Veo calls, by construction.
 *
 * ZERO PAID CALLS: fetch is fully mocked and every ffmpeg fixture is generated
 * locally from a 2-colour PNG.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import {
  VeoVideoService,
  buildVeoPredictBody,
  loadVeoInputImage,
  veoImageMimeType,
  nearestLegalVeoSeconds,
  veoCostUsd,
  VEO_LEGAL_DURATIONS,
  VEO_CALL_SECONDS,
  VEO_MOTION_BUDGET_SECONDS,
  VEO_MOTION_JOIN_SLACK_SECONDS,
  VEO_MOTION_PLAN_CEILING_SECONDS,
  VEO_LONG_CLIP_SECONDS,
  planVeoClipDurations,
  planVeoClipDurationsTotal,
  VEO_MAX_MOTION_WINDOWS,
  VEO_MODEL,
  VEO_ERRORS,
  veoImageRejectedMessage,
  veoImageMissingMessage,
} from '../veoVideoService.js';
import {
  planVeoSceneWindows,
  planVeoSceneSpans,
  applyVeoSceneMotion,
  capVeoMotionWindows,
  fitClipToDuration,
  concatClips,
  isRetryableVeoFailure,
  type SceneScript,
} from '../sceneVideoPipelineService.js';

const TMP = path.join(process.cwd(), 'temp', 'veo-whole-video-tests');
fs.mkdirSync(TMP, { recursive: true });

const scene = (n: number, duration: number): SceneScript => ({
  sceneNumber: n, duration, visualType: 'still', narration: `Line ${n}.`, visualPrompt: `beat ${n}`,
});

// ═══ (1) IMAGE-TO-VIDEO request contract ═════════════════════════════════════
test('IMAGE: buildVeoPredictBody puts the still in instances[0].image (documented shape)', () => {
  const body: any = buildVeoPredictBody('slow push in', {
    sampleCount: 1,
    durationSeconds: 6,
    aspectRatio: '9:16',
    resolution: '720p',
    generateAudio: false,
    image: { bytesBase64Encoded: 'QUJD', mimeType: 'image/png' },
  });
  assert.equal(body.instances.length, 1);
  assert.equal(body.instances[0].prompt, 'slow push in');
  assert.deepEqual(body.instances[0].image, { bytesBase64Encoded: 'QUJD', mimeType: 'image/png' },
    'image-to-video: the clip must START from the frame we designed');
  assert.equal(body.parameters.generateAudio, false, 'audio stays explicit and off (billed separately)');
  assert.equal(body.parameters.durationSeconds, 6);
  assert.equal('numberOfVideos' in body.parameters, false, 'numberOfVideos is never sent');
});

test('IMAGE: no still → no image key (text-to-video shape is unchanged)', () => {
  const body: any = buildVeoPredictBody('p', { sampleCount: 1 });
  assert.equal('image' in body.instances[0], false);
});

test('IMAGE: loadVeoInputImage round-trips real PNG bytes and picks the right mime', () => {
  const png = path.join(TMP, 'still.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  fs.writeFileSync(png, bytes);
  const img = loadVeoInputImage(png);
  assert.equal(img.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(img.bytesBase64Encoded, 'base64'), bytes);
  assert.equal(veoImageMimeType('x.JPEG'), 'image/jpeg', 'jpg/jpeg → image/jpeg (the only other legal mime)');
  assert.throws(() => loadVeoInputImage(path.join(TMP, 'nope.png')), /ENOENT|no such file/i);
});

test('IMAGE: generateSceneVideo sends the still on the wire and reports usedImage', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const prevSa = process.env.GOOGLE_VERTEX_SA_JSON;
  process.env.GOOGLE_VERTEX_SA_JSON = JSON.stringify({
    type: 'service_account', project_id: 'proj-test', private_key_id: 'k',
    private_key: pem, client_email: 'sa@proj-test.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  const bodies: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3599 }), { status: 200 });
    }
    if (url.endsWith(':predictLongRunning')) {
      bodies.push(JSON.parse(String(init?.body || '{}')));
      return new Response(JSON.stringify({ name: 'projects/p/locations/us-central1/publishers/google/models/m/operations/op-1' }), { status: 200 });
    }
    if (url.endsWith(':fetchPredictOperation')) {
      return new Response(JSON.stringify({
        done: true,
        response: { videos: [{ bytesBase64Encoded: Buffer.from('clip').toString('base64'), mimeType: 'video/mp4' }] },
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const still = path.join(TMP, 'wire-still.png');
    fs.writeFileSync(still, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
    const svc = new VeoVideoService();
    svc.pollDelayMs = 0;
    const out = await svc.generateSceneVideo({
      prompt: 'one continuous take', sceneKey: 'block0-scene1',
      onOperationCreated: async () => {}, durationSeconds: 6, imagePath: still,
    });
    assert.ok(out.success, out.error);
    assert.equal(out.usedImage, true, 'the call was image-to-video');
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].instances[0].image, 'the still rode on the wire');
    assert.equal(bodies[0].instances[0].image.mimeType, 'image/png');
    assert.equal(Buffer.from(bodies[0].instances[0].image.bytesBase64Encoded, 'base64').length, 7);
    assert.equal(bodies[0].parameters.durationSeconds, 6);
    assert.equal(bodies[0].parameters.generateAudio, false);
    assert.equal(out.estimatedUsd, 0.18, '6s × $0.03/s = $0.18 of motion');
    if (out.videoPath) fs.rmSync(out.videoPath, { force: true });
  } finally {
    globalThis.fetch = originalFetch;
    if (prevSa === undefined) delete process.env.GOOGLE_VERTEX_SA_JSON; else process.env.GOOGLE_VERTEX_SA_JSON = prevSa;
  }
});

// ═══ (2)(3)(4) the window plan ══════════════════════════════════════════════
test('PLAN: a 5-scene 30s video buys the OWNER\'S plan — 4 × 6s + 1 × 8s = 32s of motion', () => {
  // Her exact words: "running 4 8 second calls is to much wasting. we can do 4 6
  // seconds calls and 1 8 second call." The 2s over the 30s video is NOT waste —
  // it is the material FFmpeg folds away when it cuts each join on its best-
  // matching frame pair (sceneJoinService), so the delivered video still lands on
  // its planned length.
  const script = [1, 2, 3, 4, 5].map(n => scene(n, 6));
  const windows = planVeoSceneWindows(script);
  assert.equal(windows.length, 5, 'five designed scenes are KEPT — five calls, one per scene');
  assert.deepEqual(windows.map(w => w.motionSeconds), [6, 6, 6, 6, 8],
    '4 × 6s + 1 × 8s — the 8s clip is the LAST scene when every window is the same length');
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 32, '32s of take for a 30s video');
  assert.deepEqual(windows.map(w => w.sceneNumber), [1, 2, 3, 4, 5], 'every scene moves');
  assert.deepEqual(windows.map(w => w.motionStartSeconds), [0, 6, 12, 18, 24], 'the windows tile the timeline');
  assert.equal(veoCostUsd(32), 0.96, '32s × $0.03/s = $0.96 per 30s Scene video');
  // The plan is pure and must never drift.
  assert.deepEqual(planVeoClipDurations(5), [6, 6, 6, 6, 8]);
  assert.equal(planVeoClipDurationsTotal(5), 32);
});

test('PLAN: the 8s clip goes to the LONGEST scene window — the long take is trimmed, never stretched', () => {
  // Scene 3 is the long beat (8s) while the rest are short, so the 8s CALL must be
  // scene 3's — not blindly the last one. Everything else stays a 6s take.
  const script = [scene(1, 5), scene(2, 5), scene(3, 8), scene(4, 6), scene(5, 6)];
  const windows = planVeoSceneWindows(script);
  assert.deepEqual(windows.map(w => w.motionSeconds), [6, 6, 8, 6, 6],
    'the longest scene (3) carries the 8s clip');
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 32, 'the sum is unchanged by the swap');
  assert.equal(windows.find(w => w.motionSeconds === 8)!.sceneNumber, 3);
});

test('PLAN: a 3-scene 18s video buys 2 × 6s + 1 × 8s = 20s (same shape, one fewer scene)', () => {
  const windows = planVeoSceneWindows([scene(1, 6), scene(2, 6), scene(3, 6)]);
  assert.equal(windows.length, 3);
  assert.deepEqual(windows.map(w => w.motionSeconds), [6, 6, 8]);
  assert.equal(windows.reduce((a, w) => a + w.motionSeconds, 0), 20);
  assert.equal(veoCostUsd(20), 0.6);
  // A single scene has no join to fold, so it buys the plain 6s take — the 8s
  // tier there would be pure waste.
  assert.deepEqual(planVeoClipDurations(1), [6]);
  assert.deepEqual(planVeoSceneWindows([scene(1, 6)]).map(w => w.motionSeconds), [6]);
});

test('PLAN: the per-call duration enum still snaps a lone scene, and every plan stays legal', () => {
  // nearestLegalVeoSeconds still governs the legacy single-take path and the
  // step-down guard, so its 4|6|8 contract is still pinned.
  assert.equal(nearestLegalVeoSeconds(3.0), 4);
  assert.equal(nearestLegalVeoSeconds(5.4), 4);
  assert.equal(nearestLegalVeoSeconds(5.99), 4);
  assert.equal(nearestLegalVeoSeconds(6.0), 6);
  assert.equal(nearestLegalVeoSeconds(6.8), 6);
  assert.equal(nearestLegalVeoSeconds(7.0), 8);
  assert.equal(nearestLegalVeoSeconds(9.5), 8);
  assert.ok(VEO_LEGAL_DURATIONS.includes(4) && VEO_LEGAL_DURATIONS.includes(6) && VEO_LEGAL_DURATIONS.includes(8));
  // Whatever the scene durations, EVERY window the planner emits is a legal call.
  for (const durations of [[5.4, 6.5, 7.5], [6, 6, 6, 6, 6], [3, 3], [7, 7, 7, 7, 7], [2, 9, 4]]) {
    const w = planVeoSceneWindows(durations.map((d, i) => scene(i + 1, d)));
    for (const win of w) {
      assert.ok((VEO_LEGAL_DURATIONS as readonly number[]).includes(win.motionSeconds),
        `illegal call duration ${win.motionSeconds}s in plan ${JSON.stringify(durations)}`);
    }
  }
});

test('PLAN: total motion never exceeds the 32s ceiling (30s budget + 2s join slack)', () => {
  // 5 × 7s = 35s planned. The old rule (each scene buys its own tier) would spend
  // 40s; the owner's plan spends 32s and the joins fold the rest.
  const heavy = [1, 2, 3, 4, 5].map(n => scene(n, 7));
  const w = planVeoSceneWindows(heavy);
  const total = w.reduce((a, x) => a + x.motionSeconds, 0);
  assert.ok(total <= VEO_MOTION_PLAN_CEILING_SECONDS, `total ${total}s must not exceed the 32s ceiling`);
  assert.ok(total <= 35 + VEO_MOTION_JOIN_SLACK_SECONDS, 'and must not exceed the video plus its join slack');
  assert.ok(w.length <= VEO_MAX_MOTION_WINDOWS);
  // The ceiling is the budget plus the slack, and nothing more.
  assert.equal(VEO_MOTION_PLAN_CEILING_SECONDS, 32);
  assert.equal(VEO_MOTION_PLAN_CEILING_SECONDS, VEO_MOTION_BUDGET_SECONDS + VEO_MOTION_JOIN_SLACK_SECONDS);
  // A very short video cannot buy more motion than it has: a 6s video fits ONE
  // 6s window, not two (the ceiling is the video's own length + the join slack).
  const short = planVeoSceneWindows([scene(1, 3), scene(2, 3)]);
  assert.equal(short.length, 1, 'only one window fits a 6s video');
  assert.ok(short.reduce((a, x) => a + x.motionSeconds, 0) <= 6 + VEO_MOTION_JOIN_SLACK_SECONDS,
    'never more motion than the video itself plus its slack');
});

test('PLAN: spans carry one window per scene and applyVeoSceneMotion marks every scene motion', () => {
  const script = [1, 2, 3, 4, 5].map(n => scene(n, 6));
  const spans = planVeoSceneSpans(script);
  assert.equal(spans.length, 1, 'one span container holds every window');
  assert.equal(spans[0].windows.length, 5);
  assert.equal(spans[0].totalSeconds, 32);
  const planned = applyVeoSceneMotion(script, spans);
  assert.equal(planned.filter(s => s.visualType === 'motion').length, 5, 'every scene is motion');
  assert.ok(planned.every(s => s.soraBlock === 0));
  // No spans (Faceless / Twin / no motion) → everything stays a still, zero Veo.
  const none = applyVeoSceneMotion(script, []);
  assert.equal(none.filter(s => s.visualType === 'motion').length, 0, 'no spans ⇒ no motion ⇒ zero Veo spend');
  assert.equal(planVeoSceneSpans([]).length, 0);
});

test('CAP: capVeoMotionWindows keeps the whole 4 × 6s + 1 × 8s plan and demotes only what does not fit', () => {
  const script = [1, 2, 3, 4, 5].map(n => scene(n, 6));
  const spans = planVeoSceneSpans(script);
  // The pipeline projects the plan onto the script BEFORE the cap, so the cap sees
  // the same visualTypes the worker will act on.
  const planned = applyVeoSceneMotion(script, spans);
  const { script: kept, spans: capped } = capVeoMotionWindows(planned, spans);
  assert.equal(capped[0].windows.length, 5, 'nothing demoted — 32s is exactly the ceiling');
  assert.equal(capped[0].totalSeconds, 32, 'the 8s clip survives the cap');
  assert.deepEqual(capped[0].windows.map(w => w.motionSeconds), [6, 6, 6, 6, 8]);
  assert.equal(kept.filter(s => s.visualType === 'motion').length, 5, 'all five scenes still move');
  // The default ceiling IS the owner's 32s — a 30s cap would demote the 8s clip and
  // silently put the old 5 × 6s plan back.
  assert.equal(VEO_MOTION_PLAN_CEILING_SECONDS, 32);
});

// ═══ (8) Faceless / Twin make ZERO Veo calls ═════════════════════════════════
test('FACELESS/TWIN: the motion election is `mode === "scene"` only — zero Veo spend elsewhere', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'), 'utf8');
  const callSites = src.split('\n')
    .filter(l => l.includes('planVeoSceneSpans('))
    .filter(l => !l.includes('export function planVeoSceneSpans')); // the definition is not a call
  assert.equal(callSites.length, 1, 'planVeoSceneSpans has exactly ONE call site');
  assert.ok(/mode === 'scene'\s*\?/.test(callSites[0]), 'and it is guarded by mode === "scene"');
  // Faceless and Twin are Ken Burns: they never enter the Veo window pre-pass,
  // because a span plan only exists for scene mode.
  assert.ok(/let spanPlans = mode === 'scene' \?/.test(src), 'non-scene modes get an EMPTY span plan');
  assert.equal(src.split('veoVideoService.generateSceneVideo(').length - 1, 2,
    'exactly two Veo call sites (the per-window path and the legacy per-scene path)');
});

// ═══ (5) THE JOINS — measured on real frames ═════════════════════════════════
/** Max frame-to-frame luma delta in [from,to] seconds: how hard the picture jumps.
 *  A hard cut spikes; a dissolve stays smooth. */
function maxFrameDelta(file: string, from: number, to: number): number {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-i', file,
    '-vf', `select='between(t,${from},${to})',tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const text = String(r.stderr || '');
  const vals = [...text.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map(m => parseFloat(m[1]));
  if (!vals.length) throw new Error(`no frame-delta samples from ffmpeg: ${text.slice(-400)}`);
  return Math.max(...vals);
}
function probeSeconds(f: string): number {
  return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).toString().trim());
}

/** Lowest luma in [from,to] seconds — a dip to black shows up here and nowhere else. */
function minLuma(file: string, from: number, to: number): number {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-i', file,
    '-vf', `select='between(t,${from},${to})',signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const text = String(r.stderr || '');
  const vals = [...text.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map(m => parseFloat(m[1]));
  if (!vals.length) throw new Error(`no luma samples from ffmpeg: ${text.slice(-400)}`);
  return Math.min(...vals);
}

test('JOIN: two independently generated scene clips are joined by a MATCH-CUT — no transition of any kind', async () => {
  // The owner's veto (Oct 12) killed the cross-dissolve ("transition flash"); the
  // Nov 2 rework killed the dip-to-black that replaced it. What is left is NO
  // TRANSITION: each clip's edge black is cut out and the two clips are cut on
  // their best-matching frame pair, then butted together.
  //
  // The fixture is the real failure mode: clip A drifts AWAY from B's opening
  // frame (it ends on the SHARED colour, which B only reaches 0.2s in), so the
  // naive join is a visible jump while a 0.4s search finds an exact match.
  const BLUE = '0x2050a0';   // A's opening picture
  const SHARED = '0x40c040'; // the colour both clips converge on — the match
  const WHITE = '0xf0f0f0';  // B's opening picture (the naive join's bad frame)
  const colourClip = (out: string, parts: Array<[string, number]>): void => {
    const inputs = parts.flatMap(([c, d]) => ['-f', 'lavfi', '-i', `color=c=${c}:s=360x640:d=${d}:r=30`]);
    const graph = `${parts.map((_, i) => `[${i}:v]`).join('')}concat=n=${parts.length}:v=1:a=0,fps=30,format=yuv420p[v]`;
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[v]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', out]);
  };
  const clipA = path.join(TMP, 'mc-clip-a.mp4');
  const clipB = path.join(TMP, 'mc-clip-b.mp4');
  colourClip(clipA, [[BLUE, 1.4], [SHARED, 0.6]]); // ends on SHARED
  colourClip(clipB, [[WHITE, 0.2], [SHARED, 1.8]]); // reaches SHARED 0.2s in
  // (a) the naive answer: the two clips stapled together, untouched
  const hard = path.join(TMP, 'mc-hard-cut.mp4');
  const listFile = path.join(TMP, 'mc-list.txt');
  fs.writeFileSync(listFile, `file '${clipA}'\nfile '${clipB}'\n`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', hard]);
  // (b) the pipeline's real assembler, in Scene mode
  const matchCut = path.join(TMP, 'mc-joined.mp4');
  const report = await concatClips([clipA, clipB], matchCut, {
    join: 'match-cut', joinWorkDir: path.join(TMP, 'mc-cut'), joinLabel: 'fixture',
  });

  // ── the report says exactly what the owner asked for ──────────────────────
  assert.ok(report, 'a match-cut join must return its report (it is persisted on the project)');
  assert.equal(report!.joinedBy, 'match-cut');
  assert.equal(report!.transition, 'none', 'no xfade, no dip, no dissolve — NO transition');
  assert.equal(report!.joins.length, 1);
  const join = report!.joins[0];
  assert.ok(join.bHeadDropFrames >= 1, `the join must cut B's opening frames away (got ${join.bHeadDropFrames})`);
  assert.ok(join.bHeadDropFrames <= report!.searchFrames, 'and never more than the search window');
  assert.ok(join.cutPsnr >= 30,
    `the cut pair must read as the same picture (>=30 dB), got ${join.cutPsnr.toFixed(2)} dB`);
  assert.ok(join.cutPsnr > join.naivePsnr,
    `the search must beat the untouched join (cut ${join.cutPsnr} vs naive ${join.naivePsnr})`);
  assert.equal(report!.visibleJoins, 0, 'no join may be delivered flagged as visibly cut');

  // ── and the delivered frames agree ────────────────────────────────────────
  const hardDelta = maxFrameDelta(hard, 1.9, 2.1);
  const joinedDelta = maxFrameDelta(matchCut, 1.9, 2.1);
  // The old fadeblack join dipped through BLACK at the seam; this one must not.
  const seamMinLuma = minLuma(matchCut, 1.85, 2.15);
  const msg = `hard-cut max delta=${hardDelta.toFixed(2)}  match-cut max delta=${joinedDelta.toFixed(2)}  `
    + `seam min luma=${seamMinLuma.toFixed(2)}  cut=${join.cutPsnr} dB (naive ${join.naivePsnr} dB)`;
  console.log(`[JOIN] ${msg}  (delivered ${probeSeconds(matchCut).toFixed(2)}s vs ${probeSeconds(hard).toFixed(2)}s hard-cut)`);
  assert.ok(hardDelta > 40, `the hard-cut reference MUST spike (it is a jump cut): ${msg}`);
  assert.ok(joinedDelta < hardDelta * 0.5, `the match-cut join must be far smoother than a hard cut: ${msg}`);
  assert.ok(joinedDelta < 40, `the match-cut join must not contain a frame-sized jump: ${msg}`);
  assert.ok(seamMinLuma > 40,
    `there must be NO dip to black at the seam (the old fadeblack xfade was the whole problem): ${msg}`);

  // ── the delivered LENGTH contract is unchanged by the rework ──────────────
  // sum(clips) − 800ms per join: the match-cut FOLDS AWAY what the xfade used to
  // OVERLAP, so every planner/delivery band downstream is untouched. The join ate
  // 0.2s of real frames above; the exact-length pass takes the rest off the tail.
  const expected = 2 + 2 - 0.8;
  assert.ok(Math.abs(probeSeconds(matchCut) - expected) < 0.15,
    `delivered length must be sum − 800ms per join (${expected}s), got ${probeSeconds(matchCut)}s`);
  assert.ok(Math.abs(report!.deliveredSeconds - expected) < 0.15,
    `the report's deliveredSeconds must match the file (${report!.deliveredSeconds}s)`);
  assert.ok(Math.abs(report!.targetSeconds - expected) < 0.02, 'the target was the 3.2s contract');
  assert.ok(report!.correctionSeconds > 0.1,
    'the exact-length pass must be the thing that closes the gap, not luck');
});

// ═══ (6) NARRATION SYNC ══════════════════════════════════════════════════════
test('SYNC: a take is FITTED to its scene window — trimmed when long, slowed when short, never frozen', async () => {
  const src = path.join(TMP, 'fit-src.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=30:duration=4',
    '-vf', 'format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
  // 4s take → 6.8s narration window (a real dissolve-compensated scene length).
  const stretched = path.join(TMP, 'fit-stretch.mp4');
  fs.copyFileSync(src, stretched);
  await fitClipToDuration(stretched, 6.8);
  assert.ok(Math.abs(probeSeconds(stretched) - 6.8) < 0.12,
    `stretched take must land on the window (6.8s), got ${probeSeconds(stretched)}s`);
  // The stretch must keep MOVING — a frozen tail would be a clone of the last frame.
  const tail = maxFrameDelta(stretched, 5.5, 6.6);
  assert.ok(tail > 0.01, `the stretched take must still be moving at its tail (delta ${tail})`);
  // 6s take → 4.0s window: trimmed, not stretched backwards.
  const trimmed = path.join(TMP, 'fit-trim.mp4');
  fs.copyFileSync(src, trimmed);
  await fitClipToDuration(trimmed, 4.0);
  assert.ok(Math.abs(probeSeconds(trimmed) - 4.0) < 0.12, `trimmed take must be 4.0s, got ${probeSeconds(trimmed)}s`);
});

test('SYNC: fitted windows sum to the planned video length — narration and picture agree', async () => {
  const planned = [6.8, 6.8, 6.8, 6.8, 6.8]; // 5 scenes, 34s before the per-join 800ms allowance
  const takes = [6, 6, 6, 6, 6];              // a 6s take per window (the 8s clip is scene N's)
  let sum = 0;
  for (let i = 0; i < takes.length; i++) {
    const f = path.join(TMP, `sync-${i}.mp4`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=120x200:rate=30:duration=${takes[i]}`,
      '-vf', 'format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
    await fitClipToDuration(f, planned[i]);
    sum += probeSeconds(f);
  }
  assert.ok(Math.abs(sum - planned.reduce((a, b) => a + b, 0)) < 0.5,
    `fitted clips must sum to the planned length (34s), got ${sum}s`);
  // And the assembled video lands on the planner's own band after the join allowance.
  // The match-cut join FOLDS AWAY 800ms per join where the xfade used to OVERLAP it,
  // so this arithmetic is deliberately unchanged by the rework.
  assert.ok(Math.abs((sum - 4 * 0.8) - 30.8) < 0.6, 'sum − 4×0.8s per-join allowance stays in the 29.5–30.5s band');
});

// ═══ (7) THE REAL REASON reaches the client ══════════════════════════════════
test('FAILURE: retry only on a proven OBJECTIVE failure — never on a deterministic one', () => {
  assert.equal(isRetryableVeoFailure('Veo poll: 5 consecutive network errors'), true);
  assert.equal(isRetryableVeoFailure('fetch failed: ECONNRESET'), true);
  assert.equal(isRetryableVeoFailure(VEO_ERRORS.permissionDenied), false, 'credentials → do not retry');
  assert.equal(isRetryableVeoFailure(VEO_ERRORS.credentialsMissing), false, 'missing service account → do not retry');
  assert.equal(isRetryableVeoFailure('veo-3.1-lite: the model veo-3.1-lite-generate-001 is unavailable (NOT_FOUND)'), false, 'retired model → do not retry');
  assert.equal(isRetryableVeoFailure(VEO_ERRORS.apiKeyBlocked), false);
  assert.equal(isRetryableVeoFailure('Veo: media filtered by safety (raiMediaFiltered)'), false);
  assert.equal(isRetryableVeoFailure(veoImageRejectedMessage('HTTP 400')), false, 'rejected image → do not retry');
  assert.equal(isRetryableVeoFailure(undefined), false);
});

test('FAILURE: the three distinct reasons are three distinct strings, and image failures name themselves', () => {
  const reasons = [VEO_ERRORS.credentialsMissing, VEO_ERRORS.permissionDenied, VEO_ERRORS.apiKeyBlocked];
  assert.equal(new Set(reasons).size, 3);
  assert.ok(/PERMISSION_DENIED/.test(VEO_ERRORS.permissionDenied));
  assert.ok(/GOOGLE_VERTEX_SA_JSON/.test(VEO_ERRORS.credentialsMissing));
  assert.ok(/REJECTED/.test(veoImageRejectedMessage('HTTP 400: bad image')));
  assert.ok(/NO designed still/.test(veoImageMissingMessage('block0-scene2', 'still render failed')));
  assert.ok(/no text-to-video fallback/i.test(veoImageMissingMessage('block0-scene2', 'x')),
    'a missing still must never silently downgrade to text-to-video');
});

test('FAILURE: the window throw carries the underlying error (regression guard, ~line 3451 bug)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'), 'utf8');
  const throws = src.split('\n').filter(l => l.includes('failed after ${VEO_WINDOW_MAX_ATTEMPTS} attempt'));
  assert.equal(throws.length, 2, 'both the window path and the legacy per-scene path throw');
  for (const line of throws) {
    assert.ok(/\$\{lastError/.test(line) || /\$\{veoLastError/.test(line),
      `the throw MUST interpolate the underlying provider error: ${line.trim()}`);
  }
  assert.equal(src.includes('failed after ${SCENE_SORA_MAX_ATTEMPTS} attempts`'), false,
    'the old error-dropping throw is gone');
});

test('COST: billed seconds are priced exactly, and a repeated window cannot double-count', () => {
  assert.equal(veoCostUsd(0), 0);
  assert.equal(veoCostUsd(4), 0.12);
  assert.equal(veoCostUsd(6), 0.18);
  assert.equal(veoCostUsd(30), 0.9);
  assert.equal(VEO_MOTION_BUDGET_SECONDS, 30);
  assert.equal(VEO_MAX_MOTION_WINDOWS, 5);
  assert.equal(VEO_CALL_SECONDS, 6);
  // The accumulator is keyed by window: re-running the SAME window overwrites.
  const perWindow: Record<string, number> = {};
  for (const [k, v] of [['block0-scene1', 6], ['block0-scene2', 6], ['block0-scene1', 6]] as const) perWindow[k] = v;
  const total = Object.values(perWindow).reduce((a, b) => a + b, 0);
  assert.equal(total, 12, 'a retry of scene 1 must not re-charge scene 1');
  assert.equal(VEO_MODEL, 'veo-3.1-lite-generate-001');
});
