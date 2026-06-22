import { db } from '../db/index.js';
import { users, goals, tasks, products, paymentLinks, integrations, approvals, revenueMilestones, transactionHashes } from '../db/sqlite-schema.js';
import { eq } from 'drizzle-orm';
import { auditService } from './auditService.js';

export class PrivacyService {
  /**
   * Export all user-related data (Data Portability)
   */
  async exportUserData(userId: string, requesterId: string) {
    await auditService.log(requesterId, 'EXPORT_DATA', userId);
    const [
      user,
      userGoals,
      userProducts,
      userIntegrations,
      userApprovals,
      revenue
    ] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)).limit(1),
      db.select().from(goals).where(eq(goals.id, userId)), // goal id is linked to user? No, goal has userId
      db.select().from(products).where(eq(products.userId, userId)),
      db.select().from(integrations).where(eq(integrations.userId, userId)),
      db.select().from(approvals).where(eq(approvals.userId, userId)),
      db.select().from(revenueMilestones).where(eq(revenueMilestones.userId, userId))
    ]);

    // Note: Goals actually use userId:
    const actualGoals = await db.select().from(goals).where(eq(goals.userId, userId));

    return {
      profile: user[0],
      goals: actualGoals,
      products: userProducts,
      integrations: userIntegrations.map((i: any) => ({ ...i, credentials: '[ENCRYPTED]' })),
      approvals: userApprovals,
      revenueSummary: revenue[0]
    };
  }

  /**
   * Hard delete all user-related data (Right to be Forgotten)
   */
  async deleteUserAccount(userId: string) {
    await db.transaction(async (tx: any) => {
      // 1. Delete dependent data first
      await tx.delete(transactionHashes).where(eq(transactionHashes.userId, userId));
      await tx.delete(revenueMilestones).where(eq(revenueMilestones.userId, userId));
      await tx.delete(approvals).where(eq(approvals.userId, userId));
      await tx.delete(integrations).where(eq(integrations.userId, userId));
      
      const userProducts = await tx.select().from(products).where(eq(products.userId, userId));
      for (const p of userProducts) {
        await tx.delete(paymentLinks).where(eq(paymentLinks.productId, p.id));
      }
      await tx.delete(products).where(eq(products.userId, userId));
      
      const userGoals = await tx.select().from(goals).where(eq(goals.userId, userId));
      for (const g of userGoals) {
        await tx.delete(tasks).where(eq(tasks.goalId, g.id));
      }
      await tx.delete(goals).where(eq(goals.userId, userId));
      
      // 2. Delete user
      await tx.delete(users).where(eq(users.id, userId));
    });
    
    return { success: true };
  }
}

export const privacyService = new PrivacyService();
