import { Request, Response } from 'express';
import { approvalService } from '../services/approvalService.js';
import { db, schema } from '../db/index.js';
import { eq, sql } from 'drizzle-orm';
const { scheduledPosts, users } = schema;

export const getPendingApprovals = async (req: Request, res: Response) => {
  // Logic to fetch pending approvals for a user
  res.json({ status: 'success', approvals: [] });
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
