/**
 * VEO 3.1 LITE TEST ROUTE (owner-directed test, Sep 15 2026) — GATED.
 *
 * POST /api/studio/veo-test  → mounted from src/index.ts.
 *
 * DOUBLE GATE (production is IMPOSSIBLE to hit accidentally):
 *   1. request body mode MUST be 'veo-test' (never the default; 'scene' stays Sora)
 *   2. env gate process.env.ENABLE_VEO_TEST === 'true' must be set in Railway
 * Both required; anything else → 404 (stealth, no capability leak).
 *
 * Flow (mirrors the Scene pipeline architecture — plan → per-scene video
 * generation → FFmpeg assembly → Operations draft):
 *   - Deterministic 6-scene × 5s plan from the verbatim test prompt (NO GPT
 *     planner call — test scope; Sora/GPT Image paths untouched).
 *   - Per-scene Veo predictLongRunning, EXACTLY-ONCE (operation name persisted
 *     to metadata.veoJobs[block] BEFORE polling; restart/resume re-polls the
 *     SAME operation — never re-submits a paid generation).
 *   - Each ~8s Veo clip sliced to its 5s slot (sliceSoraTake, exported helper)
 *     then concatClips → final 30s master → R2 (video-projects) → project
 *     status 'completed' + finalVideoUrl (Operations card appears like Scene
 *     videos). Provider tag 'veo-3.1-lite' in metadata — NEVER surfaced in UI.
 *
 * Cost capture: billed seconds = 6 × 8s = 48s per test video. Google published
 * rates (paid tier, per second): veo-3.1-generate-preview $0.40/s (≈ $19.20);
 * veo-3.1-lite-generate-preview $0.05/s (≈ $2.40). The owner's verbatim model
 * code is the default; the Lite code is documented + ready — decision at the
 * sign-off gate for the ONE live render.
 *
 * CREDENTIALS: uses the EXISTING Railway env var GOOGLE_API_KEY (already
 * present — the only Google/Gemini key in prod env; the codebase's
 * GOOGLE_STUDIO_API_KEY fallback also honored). No new secret created.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { r2Storage } from '../services/r2StorageService.js';
import {
  veoVideoTestService,
  planVeoTestScenes,
  VEO_TEST_MODE,
  VEO_ENV_GATE,
  VEO_PROVIDER_TAG,
  VEO_DEFAULT_IDEA,
  VEO_CALL_SECONDS,
  VEO_SCENE_SECONDS,
} from '../services/veoVideoTestService.js';
import { sliceSoraTake, concatClips, runRenderQC } from '../services/sceneVideoPipelineService.js';

const router = Router();
const trace = (...args: unknown[]) => console.log('[VEO-TEST]', ...args);

/** Same resolution as studioRoutes' resolveUserId (kept local so the two routers
 *  stay independent; mirrored deliberately). NEVER resolves to zero-UUID: a
 *  non-UUID/unverifiable raw value returns null → 401. */
const resolveUserId = async (raw: string): Promise<string | null> => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(raw)) {
    try {
      const [existing] = await db.select({ id: schema.users.id })
        .from(schema.users).where(eq(schema.users.id, raw)).limit(1);
      if (existing) return existing.id;
      await db.insert(schema.users).values({
        id: raw,
        email: `${raw.slice(0, 8)}@empirelaunch.ai`,
        accessKey: null,
      }).onConflictDoNothing();
      const [created] = await db.select({ id: schema.users.id })
        .from(schema.users).where(eq(schema.users.id, raw)).limit(1);
      return created?.id ?? null;
    } catch (err) {
      console.warn('[VEO-TEST] resolveUserId failed:', (err as Error).message);
      return null;
    }
  }
  try {
    const [byKey] = await db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.accessKey, raw)).limit(1);
    if (byKey) return byKey.id;
  } catch {}
  try {
    const [byEmail] = await db.select({ id: schema.users.id })
      .from(schema.users).where(eq(schema.users.email, `${raw}@empirelaunch.ai`)).limit(1);
    if (byEmail) return byEmail.id;
  } catch {}
  return null;
};

router.post('/veo-test', async (req: Request, res: Response) => {
  try {
    // GATE 1: explicit test mode — production 'scene' etc. NEVER reaches here.
    if (req.body.mode !== VEO_TEST_MODE) {
      return res.status(404).json({ status: 'error', error: 'Not found' });
    }
    // GATE 2: env harness — off by default, set to 'true' only for the gated test.
    if (process.env[VEO_ENV_GATE] !== 'true') {
      return res.status(404).json({ status: 'error', error: 'Not found' });
    }
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_STUDIO_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ status: 'error', error: 'Veo test key not configured' });
    }
    const rawUserId = typeof req.body.userId === 'string' && req.body.userId
      ? req.body.userId
      : ((req as any).userId || String(req.headers['x-user-id'] || ''));
    const resolvedUserId = await resolveUserId(typeof rawUserId === 'string' ? rawUserId : String(rawUserId || ''));
    if (!resolvedUserId) {
      return res.status(401).json({ status: 'error', error: 'Valid userId is required' });
    }
    const idea = typeof req.body.idea === 'string' && req.body.idea.trim()
      ? req.body.idea.trim() : VEO_DEFAULT_IDEA;
    const scenes = planVeoTestScenes(idea);
    const totalSeconds = scenes.reduce((acc, s) => acc + s.duration, 0);
    const projectId = uuidv4();
    const sceneRows = scenes.map((s) => ({ ...s, id: uuidv4() }));
    const title = typeof req.body.title === 'string' && req.body.title.trim()
      ? req.body.title.trim() : `Veo 3.1 Test — ${totalSeconds}s / ${scenes.length}×${VEO_SCENE_SECONDS}s`;
    const metadata = {
      mode: VEO_TEST_MODE,
      provider: VEO_PROVIDER_TAG,
      test: true,
      note: 'OWNER-DIRECTED TEST ONLY — Veo 3.1 evaluation; production Sora path untouched.',
      veoJobs: {} as Record<string, { operation: string; status: string; createdAt: string }>,
      billedSecondsPerScene: VEO_CALL_SECONDS,
      sceneSeconds: VEO_SCENE_SECONDS,
    };
    await db.insert(schema.videoProjects).values({
      id: projectId,
      userId: resolvedUserId,
      title,
      status: 'generating',
      totalDuration: totalSeconds,
      sceneCount: scenes.length,
      script: { idea, scenes, testScope: true, providerTag: VEO_PROVIDER_TAG },
      metadata,
    });
    await db.insert(schema.videoScenes).values(sceneRows.map((s) => ({
      id: s.id,
      projectId,
      sceneNumber: s.sceneNumber,
      duration: s.duration,
      visualType: 'motion',
      visualPrompt: s.prompt,
      status: 'pending',
      metadata: { provider: VEO_PROVIDER_TAG, veoCallSeconds: VEO_CALL_SECONDS },
    })));
    trace(`project_created project=${projectId} mode=${VEO_TEST_MODE} scenes=${scenes.length} total=${totalSeconds}s`);
    void runVeoTestWorker(projectId, resolvedUserId, sceneRows, apiKey).catch((e) =>
      trace(`worker_unhandled project=${projectId} error=${e?.message}`));
    return res.status(202).json({ status: 'processing', projectId, mode: VEO_TEST_MODE, sceneCount: scenes.length });
  } catch (error: any) {
    console.error('[VEO-TEST] route error:', error.message);
    return res.status(500).json({ status: 'error', error: error.message });
  }
});

/** Background worker: 6 scenes → 6 Veo calls (exactly-once) → slice to 5s →
 *  concat → R2 master → Operations-completed project row (real owner id only). */
async function runVeoTestWorker(
  projectId: string,
  userId: string,
  scenes: Array<{ id: string; sceneNumber: number; duration: number; prompt: string }>,
  apiKey: string,
): Promise<void> {
  try {
    const dir = path.join(process.cwd(), 'temp', `veo-${projectId}`);
    await fs.promises.mkdir(dir, { recursive: true });
    const clipPaths: string[] = [];
    for (const scene of scenes) {
      const sceneKey = `scene${scene.sceneNumber}`;
      await db.update(schema.videoScenes).set({ status: 'generating', updatedAt: new Date() })
        .where(eq(schema.videoScenes.id, scene.id));
      // Resume-safe exactly-once: read the persisted operation for THIS scene.
      const [proj] = await db.select({ metadata: schema.videoProjects.metadata })
        .from(schema.videoProjects).where(eq(schema.videoProjects.id, projectId)).limit(1);
      const jobs = ((proj?.metadata as any)?.veoJobs ?? {}) as Record<string, { operation?: string; status?: string }>;
      const persist = async (operation: string) => {
        const jobsNow = { ...(((await db.select({ metadata: schema.videoProjects.metadata })
          .from(schema.videoProjects).where(eq(schema.videoProjects.id, projectId)).limit(1))[0]?.metadata as any)?.veoJobs ?? {}), [sceneKey]: { operation, status: 'in_progress', createdAt: new Date().toISOString() } };
        await db.update(schema.videoProjects)
          .set({ metadata: { ...((proj?.metadata as any) ?? {}), veoJobs: jobsNow }, updatedAt: new Date() })
          .where(eq(schema.videoProjects.id, projectId));
      };
      trace(`scene_start project=${projectId} ${sceneKey} prompt_len=${scene.prompt.length}`);
      const result = await veoVideoTestService.generateSceneVideo({
        prompt: scene.prompt,
        apiKey,
        sceneKey,
        existingOperationName: jobs[sceneKey]?.operation,
        onOperationCreated: persist,
      });
      if (!result.success || !result.videoPath) {
        await db.update(schema.videoScenes).set({ status: 'failed', updatedAt: new Date() })
          .where(eq(schema.videoScenes.id, scene.id));
        await failProject(projectId, result?.error ?? 'Veo scene generation failed', scenes.length, scene.sceneNumber);
        return;
      }
      // Slice the ~8s Veo clip down to its 5s timeline slot (same idea as the
      // Sora tpad tail-fill idea: Veo 3.1 lite caps at 8s — we take the opening
      // window, no extra paid seconds).
      const sliced = path.join(dir, `${sceneKey}.mp4`);
      await sliceSoraTake(result.videoPath, sliced, 0, scene.duration);
      clipPaths.push(sliced);
      await db.update(schema.videoScenes).set({
        status: 'completed',
        assetUrl: result.videoPath,
        assetType: 'video/mp4',
        updatedAt: new Date(),
        metadata: { provider: VEO_PROVIDER_TAG, operationName: result.operationName, billedSeconds: result.billedSeconds, veoCallSeconds: VEO_CALL_SECONDS },
      }).where(eq(schema.videoScenes.id, scene.id));
      trace(`scene_done project=${projectId} ${sceneKey} billed=${result.billedSeconds}s`);
    }
    // ASSEMBLY: concat 6 clips → final 30s master (9:16, 720p).
    await db.update(schema.videoProjects).set({ status: 'assembling', updatedAt: new Date() })
      .where(eq(schema.videoProjects.id, projectId));
    const assembled = path.join(dir, 'final.mp4');
    trace(`ffmpeg_assembly_start project=${projectId} clips=${clipPaths.length}`);
    await concatClips(clipPaths, assembled);
    trace(`ffmpeg_assembly_end project=${projectId}`);
    const qc = runRenderQC(assembled, { allowSilent: true }); // Veo has native audio; QC is informational only
    trace(`render_qc project=${projectId} duration=${qc?.duration}`);
    // UPLOAD master to R2 (video-projects path — Operations card like Scene).
    let finalUrl = assembled;
    let primaryR2Key: string | undefined;
    if (r2Storage.isAvailable) {
      const uploaded = await r2Storage.uploadLocalFile(assembled, userId, 'video-projects', 'video/mp4');
      if (uploaded.url && uploaded.url !== assembled) finalUrl = uploaded.url;
      primaryR2Key = uploaded.r2Key;
    }
    const [proj2] = await db.select({ metadata: schema.videoProjects.metadata })
      .from(schema.videoProjects).where(eq(schema.videoProjects.id, projectId)).limit(1);
    const completeMeta = {
      ...((proj2?.metadata as any) ?? {}),
      provider: VEO_PROVIDER_TAG,
      test: true,
      assembledFrom: `${clipPaths.length} scenes × ${VEO_SCENE_SECONDS}s = ${clipPaths.length * VEO_SCENE_SECONDS}s`,
      billedSeconds: scenes.length * VEO_CALL_SECONDS,
      r2Key: primaryR2Key,
      costNote: 'Google published rates per second — see pricing page (Standard $0.40/s, Lite $0.05/s); cross-check dashboard after live render.',
    };
    await db.update(schema.videoProjects).set({
      status: 'completed',
      finalVideoUrl: finalUrl,
      metadata: completeMeta,
      updatedAt: new Date(),
    }).where(eq(schema.videoProjects.id, projectId));
    trace(`project_complete project=${projectId} url=${finalUrl} billed=${completeMeta.billedSeconds}s`);
  } catch (error: any) {
    console.error(`[VEO-TEST] worker failed project=${projectId}:`, error.message);
    await failProject(projectId, error.message, scenes.length, 0).catch(() => {});
  }
}

async function failProject(projectId: string, error: string, sceneCount: number, firstFailedScene: number): Promise<void> {
  const [proj] = await db.select({ metadata: schema.videoProjects.metadata })
    .from(schema.videoProjects).where(eq(schema.videoProjects.id, projectId)).limit(1);
  await db.update(schema.videoProjects).set({
    status: 'failed',
    metadata: { ...((proj?.metadata as any) ?? {}), error, sceneCount, firstFailedScene },
    updatedAt: new Date(),
  }).where(eq(schema.videoProjects.id, projectId));
  trace(`project_failed project=${projectId} error=${error}`);
}

export default router;