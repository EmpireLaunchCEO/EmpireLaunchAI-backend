/**
 * VEO 3.1 LITE — OWNER-APPROVED LIVE TEST RUN (Sep 15 2026, task f5195b48).
 * ONE-OFF direct API run. NO app code changes, NO repo commits, NO merge.
 * Model: veo-3.1-lite-generate-preview (Lite, $0.05/s).
 * Shape: 6 scenes × 5s = 30s master, 720p, 9:16, text-to-video only.
 *
 * LIVE FINDING (first attempt, 2026-09-15): the Lite model REJECTS
 * `numberOfVideos` (400 INVALID_ARGUMENT, zero cost). This scratch run builds
 * the predictLongRunning BODY ITSELF via the repo's exported builders, WITHOUT
 * numberOfVideos — zero repo changes. The class's generateSceneVideo is NOT
 * used; poll/download loops are replicated verbatim from it.
 *
 * EXACTLY-ONCE: each operation name persisted to /home/team/shared/veo_test/ops.json
 * BEFORE polling; a restart resumes the SAME operations — never re-submits a
 * paid generation. 403 (Veo not enabled) → HARD STOP, no retries.
 *
 * Run (repo root, Railway env injected):
 *   HOME=/home/agent-lead timeout 2400 /home/agent-lead/.railway/bin/railway run \
 *     -s 691e4f21-8f49-4f0c-aafb-2a35c350d77f -- bash -c 'cd /home/team/shared/EmpireLaunchAI-backend && \
 *     export PATH=/tmp/ffmpeg-static:$PATH && \
 *     TS_NODE_TRANSPILE_ONLY=1 NODE_OPTIONS="--loader ts-node/esm" node veo_live_temp.ts'
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import {
  VEO_LITE_MODEL, VEO_CALL_SECONDS, VEO_ASPECT_RATIO, VEO_RESOLUTION,
  VEO_PERSON_GENERATION, VEO_DEFAULT_IDEA, VEO_POLL_MAX_ATTEMPTS,
  VEO_POLL_BASE_DELAY_MS, VEO_POLL_MAX_DELAY_MS,
  buildVeoCreateUrl, buildVeoPredictBody, parseVeoOperationName,
  buildVeoPollUrl, parseVeoOperation, extractVeoVideoPayload, planVeoTestScenes,
} from './src/services/veoVideoTestService.js';
import { sliceSoraTake, concatClips, runRenderQC } from './src/services/sceneVideoPipelineService.js';
import { r2Storage } from './src/services/r2StorageService.js';

const { Client } = pg;
const trace = (...a: unknown[]) => console.log('[VEO-TEST]', ...a);

// ── Config ────────────────────────────────────────────────────────────────
const OWNER_ID = '11111111-2222-4333-8444-555555555555'; // her REAL id (never zero-UUID)
const OUT_DIR = '/home/team/shared/veo_test/clips';
const SHARED_OUT = '/home/team/shared/veo_test_output';
const OPS_PATH = '/home/team/shared/veo_test/ops.json';
const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_STUDIO_API_KEY || '';
if (!apiKey) { console.error('[VEO-TEST] FATAL: no GOOGLE_API_KEY in injected env'); process.exit(4); }

const idea = VEO_DEFAULT_IDEA;
const scenes = planVeoTestScenes(idea);

// ── Durable ops ledger (exactly-once) ─────────────────────────────────────
function loadOps(): Record<string, any> { try { return JSON.parse(fs.readFileSync(OPS_PATH, 'utf8')); } catch { return {}; } }
function saveOps(ops: Record<string, any>) { fs.writeFileSync(OPS_PATH, JSON.stringify(ops, null, 2)); }

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHARED_OUT, { recursive: true });

// ── Replicated poll loop (verbatim from VeoVideoTestService, setInterval-safe) ─
async function pollOperation(operationName: string, sceneKey: string): Promise<any> {
  let attempt = 0;
  let consecutiveErrors = 0;
  while (attempt < VEO_POLL_MAX_ATTEMPTS) {
    attempt++;
    const waitMs = attempt > 6 ? VEO_POLL_MAX_DELAY_MS : VEO_POLL_BASE_DELAY_MS;
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => { clearInterval(interval); resolve(); }, waitMs);
    });
    try {
      const res = await fetch(buildVeoPollUrl(operationName), {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) { trace(`veo_poll_404 scene=${sceneKey}`); return { done: false, error: 'Veo operation not found (404)' }; }
      if (!res.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) return { done: false, error: `Veo poll: ${consecutiveErrors} consecutive HTTP errors (${res.status})` };
        continue;
      }
      consecutiveErrors = 0;
      const json = await res.json().catch(() => null);
      const result = parseVeoOperation(json);
      if (result.error) { trace(`veo_poll_terminal scene=${sceneKey} error=${result.error}`); return result; }
      if (result.done) { trace(`veo_poll_done scene=${sceneKey} polls=${attempt}`); return result; }
      if (attempt % 15 === 0) trace(`polling scene=${sceneKey} attempt=${attempt}`);
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) return { done: false, error: `Veo poll: ${consecutiveErrors} consecutive network errors` };
    }
  }
  trace(`veo_poll_cap scene=${sceneKey} attempts=${VEO_POLL_MAX_ATTEMPTS}`);
  return { done: false };
}

// ── Replicated download (signed uri OR inline base64) ─────────────────────
async function downloadVideo(payload: any, sceneKey: string): Promise<string> {
  const outPath = path.join(OUT_DIR, `${sceneKey}_${uuidv4().slice(0, 8)}.mp4`);
  if (payload.data) {
    await fs.promises.writeFile(outPath, Buffer.from(payload.data, 'base64'));
    return outPath;
  }
  const uri = payload.uri!;
  if (uri.startsWith('gs://')) throw new Error('Veo returned a raw gs:// URI');
  const res = await fetch(uri, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Veo video download HTTP ${res.status}`);
  await fs.promises.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

// ── Corrected CREATE (no numberOfVideos — Lite model rejects it) ──────────
async function createScene(scene: any, sceneKey: string): Promise<string> {
  const createUrl = buildVeoCreateUrl(VEO_LITE_MODEL);
  const body = buildVeoPredictBody(scene.prompt, {
    aspectRatio: VEO_ASPECT_RATIO,
    resolution: VEO_RESOLUTION,
    durationSeconds: VEO_CALL_SECONDS,
    personGeneration: VEO_PERSON_GENERATION,
  });
  trace(`create POST scene=${sceneKey} model=${VEO_LITE_MODEL} bodyParams=${JSON.stringify(body.parameters)}`);
  const res = await fetch(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const errText = `Veo create error ${res.status} — ${errBody.slice(0, 300)}`;
    trace(`create_FAILED scene=${sceneKey} ${errText}`);
    if (res.status === 403) {
      console.error('[VEO-TEST] HARD STOP: 403 = Veo not enabled for this API key. No retries. Owner must enable Veo 3.1 in Google Cloud console for the key.');
      process.exit(3);
    }
    process.exit(2); // resume-safe (nothing persisted → clean retry with same body)
  }
  const createJson = await res.json();
  const operationName = parseVeoOperationName(createJson);
  const cur = loadOps();
  cur[sceneKey] = { operation: operationName, status: 'in_progress', createdAt: new Date().toISOString(), model: VEO_LITE_MODEL, billedSeconds: VEO_CALL_SECONDS };
  saveOps(cur); // DURABLE PERSISTENCE POINT — BEFORE any polling
  trace(`ops_persisted scene=${sceneKey} op=${operationName}`);
  return operationName;
}

async function main() {
  if (process.env.VEO_LIVE_DRYRUN === '1') { trace('dryrun imports_ok'); process.exit(0); }
  trace(`live_run_start model=${VEO_LITE_MODEL} scenes=${scenes.length} billed_seconds=${scenes.length * VEO_CALL_SECONDS} aspect=${VEO_ASPECT_RATIO} res=${VEO_RESOLUTION} person=${VEO_PERSON_GENERATION}`);
  const clipPaths: string[] = [];

  // STEP 1: 6 scene generations (exactly-once, resume-safe)
  for (const scene of scenes) {
    const sceneKey = `scene${scene.sceneNumber}`;
    const sliced = path.join(OUT_DIR, `${sceneKey}.mp4`);
    const rec = loadOps()[sceneKey];
    if (rec?.status === 'sliced' && fs.existsSync(rec.videoPath) && fs.existsSync(sliced)) {
      trace(`scene_resume_sliced ${sceneKey}`);
      clipPaths.push(sliced);
      continue;
    }
    trace(`scene_start ${sceneKey} resume_op=${rec?.operation ?? 'none'}`);
    let operationName = rec?.operation;
    if (!operationName) operationName = await createScene(scene, sceneKey);
    else trace(`scene_resume_poll ${sceneKey} op=${operationName}`);
    const poll = await pollOperation(operationName, sceneKey);
    if (poll.error) { console.error(`[VEO-TEST] scene_failed ${sceneKey} error=${poll.error}`); process.exit(2); }
    if (!poll.done) { console.error(`[VEO-TEST] scene_failed ${sceneKey} error=poll sanity cap in_progress (resume-safe)`); process.exit(2); }
    const payload = poll.video ?? extractVeoVideoPayload(poll.video ?? {});
    const videoPath = await downloadVideo(payload, sceneKey);
    trace(`scene_downloaded ${sceneKey} path=${videoPath}`);
    await sliceSoraTake(videoPath, sliced, 0, scene.duration);
    const ops = loadOps();
    ops[sceneKey] = { ...ops[sceneKey], status: 'sliced', videoPath };
    saveOps(ops);
    clipPaths.push(sliced);
    trace(`scene_sliced ${sceneKey} -> ${scene.duration}s`);
  }

  // STEP 2: assembly — concat 6 clips (production helper, ffmpeg on PATH)
  const final = path.join(OUT_DIR, 'veo_30s_final.mp4');
  trace(`assembly_start clips=${clipPaths.length}`);
  await concatClips(clipPaths, final);
  const qc = runRenderQC(final, { allowSilent: true });
  trace(`assembly_done qc=${JSON.stringify(qc)}`);
  const actualDur = qc?.duration ?? '?';
  fs.copyFileSync(final, path.join(SHARED_OUT, 'veo_lite_test_30s.mp4'));
  trace(`backup_saved ${SHARED_OUT}/veo_lite_test_30s.mp4`);

  // STEP 3: R2 upload under the video-projects key convention
  let finalUrl = final;
  let r2Key: string | undefined;
  if (r2Storage.isAvailable) {
    const uploaded = await r2Storage.uploadLocalFile(final, OWNER_ID, 'video-projects', 'video/mp4');
    if (uploaded.url && uploaded.url !== final) finalUrl = uploaded.url;
    r2Key = uploaded.r2Key;
    trace(`r2_uploaded key=${r2Key}`);
  } else {
    console.error('[VEO-TEST] R2 UNAVAILABLE — falling back to shared path delivery');
  }

  // STEP 4: minimal Operations rows via raw pg (public URL — private host unreachable from sandbox)
  const projectId = uuidv4();
  const dbUrl = fs.readFileSync('/tmp/dburl.txt', 'utf8').trim();
  const meta = {
    mode: 'veo-test', provider: 'veo-3.1-lite-test', model: VEO_LITE_MODEL, test: true,
    r2Key, billedSeconds: scenes.length * VEO_CALL_SECONDS, finalDurationSeconds: actualDur,
    costNote: '≈$2.40 expected at Lite $0.05/s (48s) — cross-check Google dashboard',
    signedOffBy: 'owner-go-lite-sep15',
  };
  const script = {
    idea, testScope: true, providerTag: 'veo-3.1-lite-test',
    scenes: scenes.map((s: any) => ({ sceneNumber: s.sceneNumber, duration: s.duration, prompt: s.prompt })),
  };
  const ops = loadOps();
  const c = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10000, query_timeout: 20000 });
  await c.connect();
  await c.query(
    `INSERT INTO video_projects (id, user_id, title, status, total_duration, scene_count, script, final_video_url, metadata, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, now())`,
    [projectId, OWNER_ID, 'Veo 3.1 Lite Test — 30s / 6×5s (owner-approved live run)', 'completed', 30, scenes.length, JSON.stringify(script), finalUrl, JSON.stringify(meta)],
  );
  for (const s of scenes) {
    await c.query(
      `INSERT INTO video_scenes (id, project_id, scene_number, duration, visual_type, narration, visual_prompt, status, asset_url, metadata, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULL, $6, 'completed', $7, $8::jsonb, now())`,
      [uuidv4(), projectId, s.sceneNumber, s.duration, 'motion', s.prompt, finalUrl, JSON.stringify({ provider: 'veo-3.1-lite-test', model: VEO_LITE_MODEL, operationName: ops[`scene${s.sceneNumber}`]?.operation, billedSeconds: VEO_CALL_SECONDS })],
    );
  }
  await c.end();
  trace(`project_row_created project=${projectId} status=completed url_head=${finalUrl.slice(0, 90)} r2Key=${r2Key}`);
  trace(`live_run_complete ${JSON.stringify({ projectId, scenes: scenes.length, billedSeconds: scenes.length * VEO_CALL_SECONDS, model: VEO_LITE_MODEL, r2Key, backup: `${SHARED_OUT}/veo_lite_test_30s.mp4` })}`);
}

main().catch((e) => { console.error('[VEO-TEST] worker error:', e?.message ?? e); process.exit(1); });