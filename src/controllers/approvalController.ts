import { Request, Response } from 'express';
import { approvalService } from '../services/approvalService.js';
import { db, schema } from '../db/index.js';
import { eq, sql, and } from 'drizzle-orm';
const { scheduledPosts, users, approvals } = schema;

export const getPendingApprovals = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || (req as any).userId || req.headers['x-user-id'] as string;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Fetch pending approvals for this user
    const pendingItems = await db.select()
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, userId),
          eq(approvals.status, 'pending')
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

export const respondToApproval = async (req: Request, res: Response) => {
  try {
    const { requestId, status } = req.body;
    if (!requestId || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid requestId or status' });
    }
    const result = await approvalService.respondToRequest(requestId, status);

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
