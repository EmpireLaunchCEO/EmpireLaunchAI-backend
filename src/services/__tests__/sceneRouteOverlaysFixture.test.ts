/**
 * SCENE ROUTE → OVERLAYS → ASSEMBLY — the path the blinking bar had to travel
 * (owner Nov 4, launch render).
 *
 * PR #143 built a correct blinking bottom bar and shipped 635/635 green tests —
 * and the bar was still UNREACHABLE from the product, because
 * `POST /api/studio/video-project` never forwarded `onScreenOverlays` to
 * `createProject` and nothing tested the route. A green suite proved a helper, not
 * a feature.
 *
 * This fixture drives the REAL express router (a real HTTP request, real route
 * code, real `createProject`, real overlay normalisation) with only the database
 * writes captured and the render worker stubbed — ZERO paid APIs, no network, no
 * DB. It asserts the owner's cadence survives the whole path:
 *
 *   request body → route validation → createProject → persisted
 *   metadata.onScreenOverlays.bottomBarBlink → normalized overlay spec →
 *   the REAL filtergraph handed to ffmpeg.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '../../db/index.js';
import { sceneVideoPipelineService } from '../sceneVideoPipelineService.js';
import {
  normalizeAssemblyOverlays,
  validateOverlayPayload,
  applyAssemblyOverlays,
  resolveSceneVideoStarts,
} from '../assemblyOverlays.js';

const USER_ID = '5e247b01-f697-495c-aec2-5d0995642efc';

/** The owner's exact brief, in the shape the studio app posts. */
const OWNER_OVERLAYS = {
  perScene: [
    { bullets: [{ text: 'NO CREDIT BUYING', marker: '✓', at: 4.8 }] },
    {
      bullets: [
        { text: '76 Videos a month', marker: '✓', at: 0.4 },
        { text: 'Personal Video Editing – Unlimited', marker: '✓', at: 2.8 },
      ],
    },
  ],
  bottomBar: 'EmpireLaunchAI.com',
  bottomBarBlink: { onSeconds: 0.5, offSeconds: 0.4 },
  flash: { text: 'GO TO EMPIRELAUNCHAI.COM', durationSec: 1.0 },
};

const SUPPLIED_SCRIPT = {
  scenes: [
    { sceneNumber: 1, duration: 8, type: 'gpt-image', visualPrompt: 'someone hunched over a laptop at night, work everywhere', narration: 'Introducing EmpireLaunchAI. Your new go-to platform to make your life easier!', narrationRole: 'narrator' },
    { sceneNumber: 2, duration: 7, type: 'gpt-image', visualPrompt: 'happy people outdoors, phones away', narration: 'No credit buying. 76 videos a month. Personal video editing, unlimited.', narrationRole: 'narrator' },
    { sceneNumber: 3, duration: 7, type: 'gpt-image', visualPrompt: 'a calm desk with a finished video playing', narration: 'It will be impossible to get this anywhere else for our price!', narrationRole: 'narrator' },
    { sceneNumber: 4, duration: 6, type: 'gpt-image', visualPrompt: 'clock and calendar, hours saved', narration: 'You will save hundreds per month, and HOURS of time creating your videos.', narrationRole: 'narrator' },
    { sceneNumber: 5, duration: 6, type: 'gpt-image', visualPrompt: 'a bright closing shot of the app', narration: 'Go to EmpireLaunchAI.com TODAY, get ahead of the game!', narrationRole: 'narrator' },
  ],
};

interface Captured { table: unknown; values: any; }
const inserts: Captured[] = [];
let createProjectCalls = 0;
let server: import('node:http').Server;
let baseUrl = '';

const realSelect = (db as any).select;
const realInsert = (db as any).insert;
const realProcessProject = (sceneVideoPipelineService as any).processProject;

before(async () => {
  // ── DB: capture writes, answer the user lookup. Nothing else is touched. ─────
  (db as any).select = () => ({
    from: () => ({
      where: () => ({
        // Scene-Based is parked for clients (owner Nov 9), so this fixture — which
        // drives the REAL Scene route — must act as the OWNER, exactly as she would.
        // A client here gets a 403 by design; sceneParked.test.ts proves that.
        limit: async () => [{ id: USER_ID, email: 'stacipeabody@gmail.com', tier: 'OWNER_MASTER' }],
      }),
    }),
  });
  (db as any).insert = (table: unknown) => ({
    values: async (values: any) => { inserts.push({ table, values }); },
  });
  // The render worker is a separate concern (and would spend money) — stub it.
  (sceneVideoPipelineService as any).processProject = async () => { /* no render in a fixture */ };
  const realCreate = sceneVideoPipelineService.createProject.bind(sceneVideoPipelineService);
  (sceneVideoPipelineService as any).createProject = async (input: any) => { createProjectCalls++; return realCreate(input); };

  const { default: studioRoutes } = await import('../../routes/studioRoutes.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/studio', studioRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  (db as any).select = realSelect;
  (db as any).insert = realInsert;
  (sceneVideoPipelineService as any).processProject = realProcessProject;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

async function postVideoProject(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/studio/video-project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('ROUTE: bottomBarBlink survives the request body → persisted metadata', { timeout: 120_000 }, async () => {
  inserts.length = 0;
  const before = createProjectCalls;
  const { status, json } = await postVideoProject({
    userId: USER_ID,
    idea: 'A launch video for EmpireLaunchAI.',
    durationTarget: 30,
    voice: 'female',
    tone: 'enthusiastic',
    script: SUPPLIED_SCRIPT,
    onScreenOverlays: OWNER_OVERLAYS,
  });
  assert.equal(status, 202, `route rejected a valid overlay payload: ${JSON.stringify(json)}`);
  assert.equal(createProjectCalls, before + 1, 'the route did not reach createProject');

  const projectRow = inserts.find((i) => Array.isArray((i.values as any)?.metadata?.plan?.scenes) || (i.values as any)?.metadata?.onScreenOverlays !== undefined);
  assert.ok(projectRow, 'createProject persisted no project row');
  const meta = (projectRow!.values as any).metadata;
  // THE ASSERTION THIS FIXTURE EXISTS FOR.
  assert.deepEqual(
    meta.onScreenOverlays?.bottomBarBlink,
    { onSeconds: 0.5, offSeconds: 0.4 },
    'the blinking cadence did not survive from the request body into metadata.onScreenOverlays',
  );
  assert.equal(meta.onScreenOverlays?.bottomBar, 'EmpireLaunchAI.com', 'the bottom bar text was lost');
  assert.equal(meta.onScreenOverlays?.flash?.text, 'GO TO EMPIRELAUNCHAI.COM', 'the end flash text was lost');
  assert.equal(meta.onScreenOverlays?.flash?.durationSec, 1.0, 'the stated 1.0s end flash must not be re-derived from chat');
  // The caller's three bullets, and only three — chat parsing may not merge in more.
  const bullets = (meta.onScreenOverlays?.perScene || []).flatMap((g: any) => g.bullets || []);
  assert.deepEqual(bullets.map((b: any) => b.text), ['NO CREDIT BUYING', '76 Videos a month', 'Personal Video Editing – Unlimited']);
  // And the supplied script is recorded as authoritative narration.
  assert.equal(meta.narrationOverride?.authoritative, true, 'a supplied script must be recorded as authoritative narration');
  assert.deepEqual(meta.narrationOverride?.script, SUPPLIED_SCRIPT.scenes.map((s) => s.narration), 'the supplied script narration must be the recorded override, verbatim');
});

test('ROUTE: a malformed overlay payload is a readable 400 and persists nothing', { timeout: 60_000 }, async () => {
  inserts.length = 0;
  const before = createProjectCalls;
  const cases: Array<[string, unknown, RegExp]> = [
    ['bottomBarBlink is a string', { ...OWNER_OVERLAYS, bottomBarBlink: 'fast' }, /bottomBarBlink/],
    ['onSeconds is zero', { bottomBar: 'EmpireLaunchAI.com', bottomBarBlink: { onSeconds: 0, offSeconds: 0.4 } }, /onSeconds/],
    ['blink without a bar', { bottomBarBlink: { onSeconds: 0.5, offSeconds: 0.4 } }, /bottomBar/],
    ['perScene is not an array', { ...OWNER_OVERLAYS, perScene: { bullets: [] } }, /perScene/],
    ['a bullet with no text', { perScene: [{ bullets: [{ marker: '✓' }] }] }, /bullets\[0\]\.text/],
  ];
  for (const [label, overlays, expected] of cases) {
    const { status, json } = await postVideoProject({
      userId: USER_ID,
      idea: 'A launch video for EmpireLaunchAI.',
      durationTarget: 30,
      script: SUPPLIED_SCRIPT,
      onScreenOverlays: overlays,
    });
    assert.equal(status, 400, `${label}: expected 400, got ${status} ${JSON.stringify(json)}`);
    assert.match(String(json.error || ''), expected, `${label}: the 400 must name what is wrong`);
  }
  assert.equal(createProjectCalls, before, 'a malformed overlay payload must not start a project');
  assert.equal(inserts.length, 0, 'a malformed overlay payload must persist nothing');
});

test('OVERLAYS → FILTERGRAPH: the 0.5s/0.4s cadence reaches the real ffmpeg command', { timeout: 120_000 }, async () => {
  // Exactly the chain the assembly pass runs: the request payload, validated, then
  // normalized for 5 scenes, then handed to the REAL overlay pass.
  const validated = validateOverlayPayload(OWNER_OVERLAYS);
  assert.equal(validated.ok, true);
  const spec = normalizeAssemblyOverlays((validated as any).value, 5);
  assert.ok(spec, 'the owner overlay spec normalized to nothing');
  assert.deepEqual(spec!.bottomBarBlink, { onSeconds: 0.5, offSeconds: 0.4 });

  const dir = mkdtempSync(path.join(tmpdir(), 'scene-overlay-graph-'));
  try {
    const input = path.join(dir, 'in.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1080x1920:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-t', '3', input], { maxBuffer: 64 * 1024 * 1024 });
    const sceneSeconds = [3];
    let graph = '';
    await applyAssemblyOverlays(input, path.join(dir, 'out.mp4'), spec!, resolveSceneVideoStarts(sceneSeconds, 0), sceneSeconds, {
      onFilter: (g) => { graph = g; },
    });
    assert.ok(graph.length > 0, 'the overlay pass reported no filtergraph');
    // The cadence, as ffmpeg is actually given it: ON at 0, OFF at 0.5, ON again at
    // 0.9 (0.5 on + 0.4 off), i.e. a 0.9s period with a 0.5s duty cycle.
    assert.ok(
      graph.includes(`enable='between(t,0.000,0.500)+between(t,0.900,1.400)`),
      `the requested 0.5s/0.4s cadence is not in the real filtergraph: ${graph}`,
    );
    // The BAR's own enable expression (the black@0.72 band at y=1752) — not the
    // end flash's window, which is a different overlay on the same file.
    // NB: the graph's filters are comma-joined and each `enable='...'` contains
    // commas of its own, so the band is located by its own unique prefix rather
    // than by splitting the string.
    const band = graph.match(/color=black@0\.72:t=fill:enable='([^']*)'/);
    assert.ok(band, `the bottom bar band is missing from the graph: ${graph}`);
    const barWindows = [...band![1].matchAll(/between\(t,([\d.]+),([\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.ok(barWindows.length >= 4, `expected the bar to blink several times over 3s, got ${JSON.stringify(barWindows)}`);
    // ON windows are 0.5s long and the LAST one must end on the final frame — a bar
    // that blinks itself off at the end would leave the owner's domain missing.
    for (const [start, end] of barWindows) {
      assert.ok(end - start <= 0.501, `an ON window is longer than the 0.5s cadence: ${start}-${end}`);
    }
    assert.ok(
      barWindows.some(([, end]) => Math.abs(end - 3) < 0.01),
      `no ON window covers the final frame: ${JSON.stringify(barWindows)}`,
    );
    // The per-scene bullets travel with it (text is written to a textfile, never
    // inlined, so the graph must reference a textfile for the bullet panel).
    assert.ok(graph.includes('textfile='), 'no text is drawn at all');
    assert.match(graph, /enable='between\(t,2\.000,3\.000\)'/, 'the 1.0s end flash window is missing from the graph');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
