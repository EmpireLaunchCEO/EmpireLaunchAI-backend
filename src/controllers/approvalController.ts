import { Request, Response } from 'express';
import { approvalService } from '../services/approvalService.js';
import { libraryService } from '../services/libraryService.js';
import { r2Storage } from '../services/r2StorageService.js';
import { db, schema } from '../db/index.js';
import { eq, sql, and, inArray } from 'drizzle-orm';
import axios from 'axios';
const { scheduledPosts, users, approvals } = schema;

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

    const approval = await approvalService.createRequest(
      userId,
      type,
      description,
      payload || {}
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

    // ── R2 Cleanup on Rejection ─────────────────────────────────────────────
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
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
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
