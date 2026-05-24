import { approvalService } from './approvalService.js';
import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
const { users } = schema;

export class SubscriptionGuard {
  async canExecuteFinancialAction(userId: string, type: 'subscription' | 'financial', taskId: string, expectedPayload: any): Promise<boolean> {
    console.log(`SubscriptionGuard: Checking permission for user ${userId}, task ${taskId}`);
    
    // 1. T&C Check
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.termsAcceptedVersion < 1) {
      console.warn(`SubscriptionGuard: Terms not accepted for user ${userId}`);
      return false;
    }

    // 2. Account Lock Check
    if (user.isLocked) {
      console.warn(`SubscriptionGuard: Account locked for user ${userId}`);
      return false;
    }

    const approval = await approvalService.getValidApproval(userId, type, taskId);
    
    if (!approval) {
      console.warn(`SubscriptionGuard: No approved request found for task ${taskId}`);
      return false;
    }

    // Basic payload verification (can be more complex with signatures)
    const payloadMatch = JSON.stringify(approval.payload) === JSON.stringify(expectedPayload);
    
    if (!payloadMatch) {
      console.error(`SubscriptionGuard: Payload mismatch for task ${taskId}`);
      return false;
    }

    return true;
  }

  /**
   * Checks if a user should be suspended due to unpaid dues.
   */
  async checkSuspensionStatus(userId: string): Promise<boolean> {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return false;

    const tier = user.tier || 'STANDARD_USER';
    if (tier === 'OWNER_MASTER' || tier === 'BETA_TESTER') {
      return false;
    }

    // In a real system, we'd check if the last subscription_log 'paid' is older than 30 days
    // AND if there is no revenue available to withhold from.
    // For this implementation, we'll simulate the check.
    
    if (user.isLocked) return true;

    // Logic: If account is > 30 days old and no subscription log exists for current period
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    if (user.createdAt < thirtyDaysAgo) {
        const [lastSub] = await db.select().from(schema.subscriptionLogs)
            .where(and(eq(schema.subscriptionLogs.userId, userId), eq(schema.subscriptionLogs.status, 'paid')))
            .orderBy(sql`${schema.subscriptionLogs.createdAt} DESC`)
            .limit(1);
        
        if (!lastSub || lastSub.createdAt < thirtyDaysAgo) {
            console.warn(`SubscriptionGuard: Suspending user ${userId} for unpaid subscription.`);
            await db.update(users).set({ isLocked: true }).where(eq(users.id, userId));
            return true;
        }
    }

    return false;
  }

  /**
   * Prompts the user for manual subscription payment.
   */
  async promptManualSubscription(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const tier = user?.tier || 'STANDARD_USER';
    
    if (tier === 'OWNER_MASTER' || tier === 'BETA_TESTER') {
      console.log(`SubscriptionGuard: Skipping subscription prompt for ${tier} user ${userId}`);
      return null;
    }

    const id = uuidv4();
    await db.insert(schema.approvals).values({
        id,
        userId,
        type: 'subscription',
        status: 'pending',
        payload: {
            amount: 3000,
            message: "Your monthly subscription is due. Please approve to process payment.",
            action: 'manual_payment'
        },
        createdAt: new Date(),
        updatedAt: new Date()
    });
    
    // Also send a notification
    await db.insert(schema.notifications).values({
        id: uuidv4(),
        userId,
        type: 'billing',
        title: 'Subscription Due',
        message: 'Your monthly subscription of $30.00 is due.',
        createdAt: new Date()
    });
    
    return id;
  }
}

export const subscriptionGuard = new SubscriptionGuard();
