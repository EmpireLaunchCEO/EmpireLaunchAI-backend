import { db, schema } from '../db/index.js';
const { approvals } = schema;
import { eq } from 'drizzle-orm';

export class ApprovalService {
  async createRequest(userId: string, type: string, description: string, payload: any = {}, taskId?: string) {
    console.log(`Creating approval request for user ${userId}: ${type}`);
    // @ts-ignore
    const [request] = await db.insert(approvals).values({
      userId,
      taskId,
      type,
      payload,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();
    return request;
  }

  async respondToRequest(requestId: string, status: 'approved' | 'rejected', decisionDetails?: string) {
    console.log(`Updating approval request ${requestId} to ${status}`);
    // @ts-ignore
    const [updated] = await db.update(approvals)
      .set({ status, decisionDetails, updatedAt: new Date() })
      .where(eq(approvals.id, requestId))
      .returning();
    return updated;
  }

  async getValidApproval(userId: string, type: string, taskId: string) {
    // @ts-ignore
    const results = await db.select().from(approvals).where(eq(approvals.taskId, taskId));
    return results.find((r: any) => r.userId === userId && r.type === type && r.status === 'approved');
  }
}

export const approvalService = new ApprovalService();
