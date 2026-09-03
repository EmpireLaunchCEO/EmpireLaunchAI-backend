import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { r2Storage } from './r2StorageService.js';
import { renderClip, concatClips, runRenderQC } from './sceneVideoPipelineService.js';
import { classifyFeedback, r2KeyFromUrl, type FeedbackIntent } from './neuralFeedbackClassifier.js';

const { approvals, videoScenes, videoProjects } = schema;

/**
 * Neural Feedback → auto-fix loop (owner direction, $0 constraint):
 * When the owner submits feedback on an Operations video ("fix the audio",
 * "choppy"), the platform re-renders a CLEAN version deterministically from the
 * STORED per-scene components (video_scenes R2 clips + gpt-audio VO) — NO new
 * Sora, NO new AI audio. The result lands as a NEW draft in Operations as a
 * re-mix (source untouched, flagged with reMixOf + reMixType) so the owner can
 * compare/Save.
 *
 * TRUST-CRITICAL: this service NEVER auto-spends Sora or re-renders from
 * scratch on feedback. If components are gone, it surfaces the honest
 * "can't auto-fix — components expired" instead of silently spending.
 */

export interface FeedbackAutoFixResult {
  status: 'note_only' | 'auto_fixed' | 'components_expired' | 'not_found' | 'forbidden' | 'error';
  intent: FeedbackIntent;
  newApprovalId?: string;
  reason?: string;
  qc?: Record<string, any>;
}

/**
 * Download a stored scene component (asset or VO audio) to a temp file.
 *
 * TRUST-CRITICAL FIX (task 926fc16c): the stored `asset_url`/`audio_url` are R2
 * PRESIGNED URLs (X-Amz-Expires=3600) that die ~1h after minting. Old videos'
 * components are still in R2, but their stored URLs are dead — downloading via
 * the signed URL fails and the auto-fix wrongly returns components_expired.
 *
 * Instead: derive the R2 OBJECT KEY from the stored URL (r2KeyFromUrl) and fetch
 * the object DIRECTLY from R2 through the SDK (GetObjectCommand via
 * r2Storage.downloadBuffer) — the key is stable, not time-limited. The raw-HTTP
 * signed-URL path is only a last-resort fallback (e.g. non-R2 URLs), and any
 * failure returns null → the caller honestly reports components_expired.
 */
async function downloadToTemp(url: string, ext: string): Promise<string | null> {
  let buffer: Buffer | null = null;

  // Preferred: authoritative R2-key path (key derivation strips the bucket
  // segment from real prod path-style URLs — see r2KeyFromUrl).
  const key = r2KeyFromUrl(url);
  if (key && r2Storage.isAvailable) {
    buffer = await r2Storage.downloadBuffer(key);
  }
  if (!buffer) {
    // Last resort: raw HTTP on the stored URL (e.g. custom domain / non-R2).
    try {
      const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 });
      buffer = Buffer.from(resp.data);
    } catch {
      return null;
    }
  }
  try {
    const tmp = path.join(os.tmpdir(), `neural-feedback-${uuidv4()}.${ext}`);
    fs.writeFileSync(tmp, buffer);
    return tmp;
  } catch {
    return null;
  }
}

interface SceneComponent {
  local: string;
  audioLocal?: string;
  duration: number;
  visualType: 'motion' | 'still';
}

/**
 * Rebuild a video deterministically from stored video_scenes components.
 * $0 — only FFmpeg replay + R2 downloads; no Sora, no AI audio.
 */
async function remixFromStoredComponents(
  projectId: string,
  userId: string,
  sourceApprovalId: string,
  intent: FeedbackIntent,
  feedbackText: string,
): Promise<{ finalUrl: string; r2Key?: string; qc: Record<string, any> } | { error: string }> {
  const scenes = await db.select()
    .from(videoScenes)
    .where(and(eq(videoScenes.projectId, projectId), eq(videoScenes.status, 'completed')))
    .orderBy(videoScenes.sceneNumber);

  if (scenes.length === 0) {
    return { error: 'components_expired' };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-feedback-remix-'));
  const components: SceneComponent[] = [];
  for (const s of scenes) {
    if (!s.assetUrl) continue;
    const isImage = s.assetType === 'image/png' || /\.(png|jpe?g|webp|gif)$/i.test(s.assetUrl || '');
    const ext = isImage ? 'png' : 'mp4';
    const local = await downloadToTemp(s.assetUrl, ext);
    if (!local) return { error: 'components_expired' };
    let audioLocal: string | undefined;
    if (s.audioUrl) {
      audioLocal = (await downloadToTemp(s.audioUrl, 'mp3')) ?? undefined;
      if (!audioLocal) return { error: 'components_expired' };
    }
    components.push({
      local,
      audioLocal,
      duration: s.duration || 3,
      visualType: s.visualType === 'still' ? 'still' : 'motion',
    });
  }
  if (components.length === 0) {
    return { error: 'components_expired' };
  }

  const clips: string[] = [];
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    const clip = path.join(dir, `clip-${i}.mp4`);
    // PR #66 renderClip: source audio NEVER mapped (VO-only when audioLocal),
    // fps=30:round=0 + setpts normalization, tpad clone pad + fades, kenburns→minterpolate.
    // For AUDIO_REMIX the VO is re-mixed; for SMOOTHNESS_REMIX the fps/loop/kenburns
    // fixes re-apply. Deterministic react of the exact merged render path.
    await renderClip(c.local, clip, c.duration, c.audioLocal, { kenburns: c.visualType === 'still' });
    clips.push(clip);
  }

  const assembled = path.join(dir, 'final.mp4');
  await concatClips(clips, assembled);

  const qc = runRenderQC(assembled);

  if (!r2Storage.isAvailable) {
    return { error: 'components_expired' };
  }
  const uploaded = await r2Storage.uploadLocalFile(assembled, userId, 'video-projects/remix', 'video/mp4');

  // Persist the feedback + result on the SOURCE approval (jsonb payload, no schema change),
  // and land the re-mix as a NEW draft approval in Operations.
  return { finalUrl: uploaded.url, r2Key: uploaded.r2Key, qc };
}

/**
 * Submit Neural Feedback on an Operations approval; when the intent is
 * auto-fixable, deterministically re-render from stored components and land a
 * NEW draft. NEVER spends Sora/AI on feedback.
 */
export async function submitNeuralFeedbackAndAutoFix(opts: {
  approvalId: string;
  userId: string;
  feedback: string;
}): Promise<FeedbackAutoFixResult> {
  const { approvalId, userId, feedback } = opts;
  if (!approvalId || !userId || !feedback?.trim()) {
    return { status: 'error', intent: 'none', reason: 'approvalId, userId and feedback are required' };
  }

  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!approval) return { status: 'not_found', intent: 'none', reason: 'approval not found' };
  if (approval.userId !== userId) return { status: 'forbidden', intent: 'none', reason: 'not your asset' };

  const intent = classifyFeedback(feedback);
  const payload: any = approval.payload || {};
  const feedbackEntry = {
    id: uuidv4(),
    text: feedback,
    intent,
    createdAt: new Date().toISOString(),
    actor: 'user',
  };
  payload.neuralFeedback = Array.isArray(payload.neuralFeedback) ? [...payload.neuralFeedback, feedbackEntry] : [feedbackEntry];

  // Always record the feedback on the source approval.
  await db.update(approvals).set({ payload, updatedAt: new Date() }).where(eq(approvals.id, approvalId));

  if (intent === 'none') {
    return { status: 'note_only', intent, reason: 'no auto-fix intent (note recorded)' };
  }

  const projectId: string | undefined = payload.projectId || approval.taskId || undefined;
  if (!projectId) {
    return { status: 'components_expired', intent, reason: "can't auto-fix — no scene project on this draft" };
  }

  const [project] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
  if (!project) {
    return { status: 'components_expired', intent, reason: "can't auto-fix — components expired (project gone)" };
  }
  if (project.userId !== userId) {
    return { status: 'forbidden', intent, reason: 'not your asset' };
  }

  const result = await remixFromStoredComponents(projectId, userId, approvalId, intent, feedback);
  if ('error' in result) {
    return { status: 'components_expired', intent, reason: "can't auto-fix — components expired", qc: undefined };
  }

  // Land as NEW draft in Operations (source untouched) — provider 'ffmpeg' re-mix.
  const newApprovalId = uuidv4();
  const newPayload = {
    ...payload,
    assetId: uuidv4(),
    videoUrl: result.finalUrl,
    r2Key: result.r2Key,
    title: `${payload.title || 'Video'} (re-mix)`,
    status: 'completed',
    aspectRatio: payload.aspectRatio || '9:16',
    ratioLabel: payload.ratioLabel || 'AI Video (9:16 · TikTok/Reels/Shorts)',
    shape: payload.shape || 'vertical',
    projectId,
    mode: payload.mode || 'scene',
    provider: 'ffmpeg',
    saved: false,
    reMixOf: approvalId,
    reMixType: intent,
    reMixFeedback: feedback,
    qc: result.qc,
  };
  await db.insert(approvals).values({
    id: newApprovalId,
    userId,
    type: 'video',
    status: 'completed',
    payload: newPayload,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { status: 'auto_fixed', intent, newApprovalId, qc: result.qc };
}