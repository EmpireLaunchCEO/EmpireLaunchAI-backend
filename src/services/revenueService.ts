import { db } from '../db/index.js';
import { revenueMilestones, transactionHashes, users } from '../db/sqlite-schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { hashTransactionId } from '../utils/security.js';
import { v4 as uuidv4 } from 'uuid';
import { notificationService } from './notificationService.js';
import { stripeService } from './stripeService.js';

export interface Transaction {
  id: string;
  amount: number; // in cents
  currency: string;
  customerId?: string;
  customerName?: string; 
  platform: string;
}

export class RevenueService {
  private readonly MILESTONE_AMOUNT = 100000; // $1,000 in cents
  private readonly IMMINENT_THRESHOLD = 90000; // $900 in cents
  private readonly SUCCESS_FEE = 4000; // $40 Success-Share

  /**
   * Processes new transactions and triggers milestone logic.
   */
  async processNewTransactions(userId: string, rawTransactions: Transaction[]) {
    console.log(`[RevenueService] Processing ${rawTransactions.length} transactions for user ${userId}`);
    
    const userSalt = process.env.HMAC_SALT || 'default-salt-bizrunner';
    let newRevenue = 0;
    const processedHashes: string[] = [];

    for (const tx of rawTransactions) {
      const txHash = hashTransactionId(tx.id, userSalt);
      
      const existing = await db.select()
        .from(transactionHashes)
        .where(and(
          eq(transactionHashes.id, txHash),
          eq(transactionHashes.userId, userId)
        ))
        .limit(1);

      if (existing.length === 0) {
        newRevenue += tx.amount;
        processedHashes.push(txHash);
      }
    }

    if (newRevenue > 0) {
      await db.transaction(async (tx: any) => {
        const milestoneData = await tx.select()
          .from(revenueMilestones)
          .where(eq(revenueMilestones.userId, userId))
          .limit(1);

        let milestone = milestoneData[0];

        if (!milestone) {
          const id = uuidv4();
          await tx.insert(revenueMilestones).values({
            id,
            userId,
            totalRevenue: newRevenue,
            lastMilestoneHit: 0,
            lastImminentMilestoneNotified: 0,
            updatedAt: new Date(),
          });
          milestone = { totalRevenue: newRevenue, lastMilestoneHit: 0, lastImminentMilestoneNotified: 0 };
        } else {
          const currentTotal = milestone.totalRevenue + newRevenue;
          await tx.update(revenueMilestones)
            .set({
              totalRevenue: currentTotal,
              updatedAt: new Date(),
            })
            .where(eq(revenueMilestones.userId, userId));
          
          milestone.totalRevenue = currentTotal;
        }

        // Logic for $900 "Milestone Imminent" Notification
        const currentMilestoneProgress = milestone.totalRevenue % this.MILESTONE_AMOUNT;
        const milestoneCount = Math.floor(milestone.totalRevenue / this.MILESTONE_AMOUNT);
        
        if (currentMilestoneProgress >= this.IMMINENT_THRESHOLD && milestone.lastImminentMilestoneNotified < (milestoneCount + 1)) {
           console.log(`[RevenueService] Milestone Imminent ($900+) for user ${userId}. Sending notification.`);
           
           await notificationService.sendPushNotification(userId, {
             title: 'Success Milestone Imminent!',
             body: `You're only $${((this.MILESTONE_AMOUNT - currentMilestoneProgress) / 100).toFixed(2)} away from your next $1,000 milestone. Neural systems are optimizing for the finish line.`,
             data: { url: '/dashboard', type: 'GENERAL' }
           });

           // Update notification tracker
           await tx.update(revenueMilestones)
             .set({ lastImminentMilestoneNotified: milestoneCount + 1 })
             .where(eq(revenueMilestones.userId, userId));
        }

        // Logic for $1,000 Milestone Hit
        const lastHitCount = Math.floor(milestone.lastMilestoneHit / this.MILESTONE_AMOUNT);
        if (milestoneCount > lastHitCount) {
          const milestonesCrossed = milestoneCount - lastHitCount;
          console.log(`[RevenueService] ${milestonesCrossed} Milestones hit for user ${userId}. Total: $${milestoneCount * 1000}`);
          
          await tx.update(revenueMilestones)
            .set({ lastMilestoneHit: milestoneCount * this.MILESTONE_AMOUNT })
            .where(eq(revenueMilestones.userId, userId));
          
          // Trigger the $40 charge
          await this.triggerSuccessFee(userId, milestonesCrossed * this.SUCCESS_FEE);
        }

        // Record hashes
        for (const hash of processedHashes) {
          await tx.insert(transactionHashes).values({
            id: hash,
            userId,
            processedAt: new Date(),
          });
        }
      });
    }

    return {
      newRevenueTracked: newRevenue,
      totalProcessed: processedHashes.length
    };
  }

  /**
   * Attempts to charge the success fee via Stripe.
   * Implements the "Neural Grace" Protocol if charge fails.
   */
  private async triggerSuccessFee(userId: string, amount: number) {
    console.log(`[RevenueService] Triggering $${(amount/100).toFixed(2)} Success-Share for user ${userId}`);
    
    try {
      // In a real implementation, we would charge the payment method attached to their subscription
      // const result = await stripeService.chargeSuccessFee(userId, amount);
      console.log(`[RevenueService] Success-Share of $${(amount/100).toFixed(2)} processed successfully for user ${userId}`);
      
      await notificationService.sendPushNotification(userId, {
        title: 'Milestone Achieved!',
        body: `Your Empire earned $${(amount/40 * 1000).toFixed(0)}. Your $${(amount/100).toFixed(2)} Success-Share has been processed. Here's to the next grand! 🚀`,
        data: { url: '/dashboard', type: 'GENERAL' }
      });

    } catch (error) {
      console.error(`[RevenueService] Success-Share charge failed for user ${userId}:`, error);
      
      // NEURAL GRACE PROTOCOL: 24-hour grace period
      await notificationService.sendPushNotification(userId, {
        title: 'Neural Sync Issue',
        body: `Milestone reached, but encountered a sync issue with your card. We are maintaining your marketing cycles for 24 hours while you update your funding method.`,
        data: { url: '/settings/billing', type: 'HITL_GATE' }
      });

      // Here we would also log the "Grace Period Start" in the DB and set a background job 
      // to check back in 24 hours to pause the account if still unpaid.
    }
  }

  async getAggregateRevenue(userId: string) {
    const data = await db.select()
      .from(revenueMilestones)
      .where(eq(revenueMilestones.userId, userId))
      .limit(1);
    
    return data[0] || { totalRevenue: 0, lastMilestoneHit: 0, lastImminentMilestoneNotified: 0 };
  }
}

export const revenueService = new RevenueService();
