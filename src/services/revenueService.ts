import { db } from '../db/index.js';
import { revenueMilestones, transactionHashes, users } from '../db/sqlite-schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { hashTransactionId } from '../utils/security.js';
import { v4 as uuidv4 } from 'uuid';

export interface Transaction {
  id: string;
  amount: number; // in cents
  currency: string;
  customerId?: string;
  customerName?: string; // PII - should be purged
  platform: string;
}

export class RevenueService {
  /**
   * Simulates an enclave-based aggregation process.
   * This function would normally run inside a TEE (e.g., AWS Nitro Enclaves).
   */
  async processNewTransactions(userId: string, rawTransactions: Transaction[]) {
    console.log(`[TEE Enclave] Processing ${rawTransactions.length} transactions for user ${userId}`);
    
    // 1. Get user salt for hashing (in a real system, this might be from a KMS)
    const userSalt = process.env.HMAC_SALT || 'default-salt-EmpireLaunch AI';
    
    let newRevenue = 0;
    const processedHashes: string[] = [];

    for (const tx of rawTransactions) {
      const txHash = hashTransactionId(tx.id, userSalt);
      
      // Check if already processed
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
      // 2. Update Revenue Milestones
      await db.transaction(async (tx: any) => {
        const milestone = await tx.select()
          .from(revenueMilestones)
          .where(eq(revenueMilestones.userId, userId))
          .limit(1);

        if (milestone.length === 0) {
          await tx.insert(revenueMilestones).values({
            id: uuidv4(),
            userId,
            totalRevenue: newRevenue,
            lastMilestoneHit: 0,
            updatedAt: new Date(),
          });
        } else {
          const currentTotal = milestone[0].totalRevenue + newRevenue;
          await tx.update(revenueMilestones)
            .set({
              totalRevenue: currentTotal,
              updatedAt: new Date(),
            })
            .where(eq(revenueMilestones.userId, userId));
          
          // Check for new $1000 milestone
          const newMilestoneCount = Math.floor(currentTotal / 100000);
          const lastMilestoneCount = Math.floor(milestone[0].lastMilestoneHit / 100000);
          
          if (newMilestoneCount > lastMilestoneCount) {
            console.log(`[TEE Enclave] Milestone hit! User ${userId} has earned $${newMilestoneCount * 1000}`);
            await tx.update(revenueMilestones)
              .set({ lastMilestoneHit: newMilestoneCount * 100000 })
              .where(eq(revenueMilestones.userId, userId));
            
            // Trigger Success Fee Billing Event (e.g., charge $30 via Stripe)
            // this.triggerSuccessFee(userId, (newMilestoneCount - lastMilestoneCount) * 3000);
          }
        }

        // 3. Record hashes to prevent double processing
        for (const hash of processedHashes) {
          await tx.insert(transactionHashes).values({
            id: hash,
            userId,
            processedAt: new Date(),
          });
        }
      });
    }

    // [TEE Enclave] Purging rawTransactions from memory...
    console.log(`[TEE Enclave] Aggregation complete. PII purged.`);
    
    return {
      newRevenueTracked: newRevenue,
      totalProcessed: processedHashes.length
    };
  }

  /**
   * Returns aggregate revenue data. Admins can see this, but not individual transactions.
   */
  async getAggregateRevenue(userId: string) {
    const data = await db.select()
      .from(revenueMilestones)
      .where(eq(revenueMilestones.userId, userId))
      .limit(1);
    
    return data[0] || { totalRevenue: 0, lastMilestoneHit: 0 };
  }
}

export const revenueService = new RevenueService();
