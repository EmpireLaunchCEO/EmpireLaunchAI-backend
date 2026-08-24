import { Request, Response } from 'express';
import { approvalService } from '../services/approvalService.js';
import { libraryService } from '../services/libraryService.js';
import { r2Storage } from '../services/r2StorageService.js';
import { usageService } from '../services/usageService.js';
import { sceneVideoPipelineService } from '../services/sceneVideoPipelineService.js';
import {
  FACELESS_MOODS,
  FACELESS_DURATIONS,
  DEFAULT_FACELESS_DURATION,
} from '../services/voiceOptions.js';
import { db, schema } from '../db/index.js';
import { eq, sql, and, inArray } from 'drizzle-orm';
import axios from 'axios';
const { scheduledPosts, users, approvals, creations } = schema;

export const getPendingApprovals = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || (req as any).userId || req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Fetch all non-failed approvals for this user (pending + completed)
    const pendingItems = await db.select()
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, userId),
          inArray(approvals.status, ['pending', 'completed'])
        )
      )
      .orderBy(approvals.createdAt)
      .limit(50);

    res.json({ status: 'success', approvals: pendingItems });
  } catch (error: any) {
    console.error('Error fetching pending approvals:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
};

export const createApproval = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || (req as any).userId || req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type, description, payload } = req.body;
    if (!type || !description) {
      return res.status(400).json({ error: 'Missing required fields: type, description' });
    }
    // Enforce the 7/week Faceless quota at the submission gate (owner stays
    // unlimited). Throws "Usage limit reached..." when over the cap.
    if (type === 'faceless') {
      try {
        await usageService.enforceLimit(userId, 'faceless');
      } catch (limitError: any) {
        return res.status(403).json({ error: limitError?.message || 'Faceless usage limit reached' });
      }
    }

    // Shared voiceover controls + screenshot source images (Faceless box).
    // Merged into payload so downstream consumers read them; only present if sent.
    const enrichedPayload: any = {
      ...(payload || {}),
      ...(req.body.voice === 'female' || req.body.voice === 'male' ? { voice: req.body.voice } : {}),
      ...(['enthusiastic', 'calm', 'serious', 'warm', 'auto'].includes(req.body.tone) ? { tone: req.body.tone } : {}),
      ...(Array.isArray(req.body.sourceImages) && req.body.sourceImages.length ? { sourceImages: req.body.sourceImages } : {}),
    };

    // ── Faceless: validate + persist mood/duration, then render via scene
    //    composition (NOT a Sora `duration` param — the endpoint rejects it).
    //    The scene pipeline gives a beginning→middle→CTA arc with smooth xfade
    //    transitions and targets ~10–15s by splitting duration across scenes.
    let facelessProjectId: string | undefined;
    if (type === 'faceless') {
      const moodRaw = req.body.mood !== undefined ? req.body.mood : (payload as any)?.mood;
      const durationRaw = req.body.duration !== undefined ? req.body.duration : (payload as any)?.duration;
      const mood = moodRaw !== undefined && moodRaw !== null && String(moodRaw).trim() !== '' && String(moodRaw).toLowerCase() !== 'auto'
        ? String(moodRaw).toLowerCase()
        : undefined;
      if (mood && !(FACELESS_MOODS as readonly string[]).includes(mood)) {
        return res.status(400).json({ error: `Invalid faceless mood "${mood}". Allowed: ${FACELESS_MOODS.join(', ')}` });
      }
      const durationNum = durationRaw !== undefined && durationRaw !== null && String(durationRaw).trim() !== ''
        ? Number(durationRaw)
        : DEFAULT_FACELESS_DURATION;
      const duration: number = Number.isFinite(durationNum) ? durationNum : DEFAULT_FACELESS_DURATION;
      if (!(FACELESS_DURATIONS as readonly number[]).includes(duration)) {
        return res.status(400).json({ error: `Invalid faceless duration "${durationRaw}". Allowed: ${FACELESS_DURATIONS.join(', ')} seconds` });
      }
      enrichedPayload.mood = mood;
      enrichedPayload.duration = duration;
      // Feed mood into the per-scene prompt so the video's tone reflects it.
      const moodHint = mood ? ` Use a ${mood} mood across every scene and the narration.` : '';
      const facelessIdea = `${description.trim()}${moodHint}`;
      try {
        facelessProjectId = await sceneVideoPipelineService.createProject({
          userId,
          title: description.trim().slice(0, 80),
          idea: facelessIdea,
          durationTarget: duration,
          style: mood ?? '',
          platforms: [],
          voice: enrichedPayload.voice,
          tone: enrichedPayload.tone,
          sourceImages: enrichedPayload.sourceImages,
        });
        if (facelessProjectId) enrichedPayload.projectId = facelessProjectId;
      } catch (renderErr: any) {
        // Render init must not fail the submission receipt / quota; log and
        // continue so the user still gets a faceless approval row.
        console.error('[Approval] Faceless render init failed:', renderErr?.message);
      }
    }

    // Persist the approval. Faceless rows are the 7/week quota record + a
    // submission receipt (the actual delivered video surfaces from the scene
    // pipeline as a completed `video` creation/approval). Use a terminal status
    // (approved = auto-launched, no manual gate) so this receipt does NOT show
    // as a dangling 'pending' or a broken asset-less 'completed' card in the
    // Operations feed, while still being counted for the 7/week quota.
    const approval = type === 'faceless'
      ? (await db.insert(approvals).values({
          userId,
          type,
          payload: { ...enrichedPayload, category: enrichedPayload.category || 'faceless-video', status: 'processing', projectId: facelessProjectId },
          status: 'approved',
          createdAt: new Date(),
          updatedAt: new Date(),
        }).returning())[0]
      : await approvalService.createRequest(
          userId,
          type,
          description,
      enrichedPayload
    );

    console.log(`Approval created: ${type} for user ${userId}`);
    res.status(201).json({ status: 'success', approval });
  } catch (error: any) {
    console.error('Error creating approval:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
};

export const clearApprovals = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || (req as any).userId || req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await db.delete(approvals)
      .where(eq(approvals.userId, userId));

    console.log(`Cleared all approvals for user ${userId}`);
    res.json({ status: 'success', message: 'All approvals cleared' });
  } catch (error: any) {
    console.error('Error clearing approvals:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
};

export const respondToApproval = async (req: Request, res: Response) => {
  try {
    const { requestId, status } = req.body;
    if (!requestId || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid requestId or status' });
    }
    const result = await approvalService.respondToRequest(requestId, status);

    // ── Full Delete on Rejection (R2 files + DB record) ────────────────────
    if (status === 'rejected' && result.payload) {
      const payload = result.payload as any;
      // Delete the video file from R2 if it's stored there
      if (payload.videoUrl && typeof payload.videoUrl === 'string' && payload.videoUrl.startsWith('brands/')) {
        await r2Storage.deleteFile(payload.videoUrl).then(() =>
          console.log(`[Approval] Deleted R2 file for rejected approval ${requestId}: ${payload.videoUrl}`)
        ).catch(err =>
          console.warn(`[Approval] Failed to delete R2 file for ${requestId}:`, err.message)
        );
      }
      // Also clean up imageUrl if present
      if (payload.imageUrl && typeof payload.imageUrl === 'string' && payload.imageUrl.startsWith('brands/')) {
        await r2Storage.deleteFile(payload.imageUrl).then(() =>
          console.log(`[Approval] Deleted R2 image for rejected approval ${requestId}: ${payload.imageUrl}`)
        ).catch(err =>
          console.warn(`[Approval] Failed to delete R2 image for ${requestId}:`, err.message)
        );
      }
      // Delete the approval record entirely — no trace left
      await db.delete(approvals).where(eq(approvals.id, requestId));
      console.log(`[Approval] Deleted approval record ${requestId}`);
    }

    // 1. Handle Content Approvals
    if (result.type === 'content' && result.payload?.postId) {
      await db.update(scheduledPosts)
        .set({ status: status === 'approved' ? 'approved' : 'rejected' })
        .where(eq(scheduledPosts.id, result.payload.postId));
      
      console.log(`Updated scheduled post ${result.payload.postId} to ${status}`);
    }

    // 2. Handle Financial/Monetization logic
    if (status === 'approved' && result.type === 'financial') {
      const payload = result.payload as any;
      
      // Slot Purchase Logic
      if (payload.type === 'SLOT_PURCHASE') {
        await db.update(users)
          .set({ businessSlots: sql`${users.businessSlots} + 1` })
          .where(eq(users.id, result.userId));
        
        console.log(`Incremented business slots for user ${result.userId}`);
      }

      // Success Fee logic could also be handled here (triggering actual Stripe charge)
    }

    res.json({ status: 'success', result });
  } catch (error) {
    console.error('Error responding to approval:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /api/approval/save-to-library
 * Copies an approval's generated asset to the Client Asset Library.
 * Handles both R2 keys and external URLs.
 */
export const saveToLibrary = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || (req as any).userId || req.headers['x-user-id'] as string;
    const { approvalId } = req.body;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!approvalId) return res.status(400).json({ error: 'approvalId required' });

    // Fetch the approval
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    if (!approval) {
      // Fallback: check if this ID matches a creation record (Operations page uses creation IDs)
      const [creation] = await db.select().from(creations).where(eq(creations.id, approvalId)).limit(1);
      if (!creation) return res.status(404).json({ error: 'Approval not found' });
      if (creation.userId !== userId) return res.status(403).json({ error: 'Not your asset' });

      const videoUrl: string | undefined = creation.fileUrl || undefined;
      const title: string = creation.title || 'Generated Video';
      const assetType = creation.type === 'enhanced_video' ? 'video' :
        creation.type === 'design' ? 'design' : 'video';
      const brandId = userId;

      let asset: any;

      if (videoUrl && (videoUrl.startsWith('http://') || videoUrl.startsWith('https://'))) {
        if (videoUrl.includes('r2.cloudflarestorage.com')) {
          // R2 URL — extract key and copy to library
          try {
            const url = new URL(videoUrl);
            const pathParts = url.pathname.split('/');
            const key = pathParts.slice(2).join('/'); // skip bucket prefix
            const ext = key.split('.').pop() || 'mp4';
            const destKey = r2Storage.buildKey(brandId, `library/${assetType}`, ext);
            const copyResult = await r2Storage.copyObject(key, destKey);
            if (copyResult.success && copyResult.key) {
              asset = await libraryService.create({
                userId, brandId, type: assetType as any,
                name: title.slice(0, 60), filePath: copyResult.key,
                mimeType: `video/${ext}`,
                metadata: { source: 'creation', creationId: approvalId },
              });
            }
          } catch { /* fall through to download */ }
        }

        if (!asset) {
          // External URL — download and re-upload
          try {
            const response = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 30000 });
            const contentType = response.headers['content-type'] || 'video/mp4';
            const buffer = Buffer.from(response.data);
            asset = await libraryService.uploadAndCreate(
              buffer, contentType, brandId, userId, assetType as any,
              title.slice(0, 60),
              { source: 'creation', creationId: approvalId, originalUrl: videoUrl },
            );
          } catch (downloadErr: any) {
            return res.status(500).json({ error: 'Download failed', detail: downloadErr.message });
          }
        }
      } else if (videoUrl && videoUrl.startsWith('brands/')) {
        // Direct R2 key
        const ext = videoUrl.split('.').pop() || 'mp4';
        const destKey = r2Storage.buildKey(brandId, `library/${assetType}`, ext);
        const copyResult = await r2Storage.copyObject(videoUrl, destKey);
        if (copyResult.success && copyResult.key) {
          asset = await libraryService.create({
            userId, brandId, type: assetType as any,
            name: title.slice(0, 60), filePath: copyResult.key,
            mimeType: `video/${ext}`,
            metadata: { source: 'creation', creationId: approvalId },
          });
        } else {
          return res.status(500).json({ error: 'R2 copy failed', detail: copyResult.error });
        }
      } else {
        return res.status(400).json({ error: 'No fileUrl found in creation record' });
      }

      if (!asset) return res.status(500).json({ error: 'Failed to create library asset' });
      return res.json({ status: 'success', asset });
    }
    if (approval.userId !== userId) return res.status(403).json({ error: 'Not your approval' });

    const payload = approval.payload as any;
    const videoUrl: string | undefined = payload?.videoUrl;
    const imageUrl: string | undefined = payload?.imageUrl;
    const title: string = payload?.title || 'Untitled Asset';
    const assetType = approval.type === 'video' ? 'video' :
      approval.type === 'edit' ? 'edit' :
      approval.type === 'design' ? 'design' : 'video';
    const brandId = userId; // Use userId as fallback brand

    let asset: any;

    if (videoUrl && videoUrl.startsWith('brands/')) {
      // R2 key — copy to library path
      const ext = videoUrl.split('.').pop() || 'mp4';
      const destKey = r2Storage.buildKey(brandId, `library/${assetType}`, ext);
      const copyResult = await r2Storage.copyObject(videoUrl, destKey);

      if (copyResult.success && copyResult.key) {
        // Create library record
        asset = await libraryService.create({
          userId,
          brandId,
          type: assetType as any,
          name: title.slice(0, 60),
          filePath: copyResult.key,
          mimeType: `video/${ext}`,
          metadata: { source: 'approval', approvalId },
        });
      } else {
        return res.status(500).json({ error: 'R2 copy failed', detail: copyResult.error });
      }
    } else if (videoUrl && (videoUrl.startsWith('http://') || videoUrl.startsWith('https://'))) {
      // External URL — download and re-upload
      try {
        const response = await axios.get(videoUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        const contentType = response.headers['content-type'] || 'video/mp4';
        const ext = contentType.split('/')[1] || 'mp4';
        const buffer = Buffer.from(response.data);

        asset = await libraryService.uploadAndCreate(
          buffer,
          contentType,
          brandId,
          userId,
          assetType as any,
          title.slice(0, 60),
          { source: 'approval', approvalId, originalUrl: videoUrl },
        );
      } catch (downloadErr: any) {
        return res.status(500).json({ error: 'Download failed', detail: downloadErr.message });
      }
    } else if (imageUrl) {
      // Handle image assets
      if (imageUrl.startsWith('brands/')) {
        const ext = imageUrl.split('.').pop() || 'png';
        const destKey = r2Storage.buildKey(brandId, `library/design`, ext);
        const copyResult = await r2Storage.copyObject(imageUrl, destKey);

        if (copyResult.success && copyResult.key) {
          asset = await libraryService.create({
            userId,
            brandId,
            type: 'design',
            name: title.slice(0, 60),
            filePath: copyResult.key,
            mimeType: `image/${ext}`,
            metadata: { source: 'approval', approvalId },
          });
        } else {
          return res.status(500).json({ error: 'R2 copy failed', detail: copyResult.error });
        }
      } else if (imageUrl.startsWith('http')) {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const contentType = response.headers['content-type'] || 'image/png';
        const buffer = Buffer.from(response.data);

        asset = await libraryService.uploadAndCreate(
          buffer,
          contentType,
          brandId,
          userId,
          'design',
          title.slice(0, 60),
          { source: 'approval', approvalId, originalUrl: imageUrl },
        );
      }
    } else {
      return res.status(400).json({ error: 'No videoUrl or imageUrl found in approval payload' });
    }

    if (!asset) return res.status(500).json({ error: 'Failed to create library asset' });

    res.json({ status: 'success', asset });
  } catch (error: any) {
    console.error('[saveToLibrary] Error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};
