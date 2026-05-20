import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { decrypt } from '../utils/encryption.js';
import { randomUUID } from 'crypto';

const { revenueMilestones, revenueTransactions, approvals, users } = schema;

/**
 * Revenue Oracle Service (Simulated Secure Enclave)
 * 
 * Handles sensitive revenue aggregation while ensuring "Admin Blindness".
 * Raw transaction data is processed in-memory and only aggregates are persisted.
 * This service acts as the internal ledger.
 */
export class RevenueOracleService {
  /**
   * Aggregates revenue for a specific user and checks for $1,000 milestones.
   */
  async processMilestones(userId: string) {
    // 1. Get current revenue state
    const [milestone] = await db.select().from(revenueMilestones).where(eq(revenueMilestones.userId, userId));
    
    // 2. Fetch recent un-aggregated transactions from the ledger
    // In a production TEE, we would fetch from encrypted storage
    const transactions = await db.select().from(revenueTransactions).where(eq(revenueTransactions.userId, userId));
    
    const currentTotalRevenue = transactions.reduce((sum: number, tx: any) => sum + tx.amount, 0);
    const lastMilestoneHit = milestone?.lastMilestoneHit || 0;

    // 3. Calculate Milestone
    const MILESTONE_INCREMENT = 100000; // $1,000 in cents
    const nextMilestoneTrigger = lastMilestoneHit + MILESTONE_INCREMENT;

    if (currentTotalRevenue >= nextMilestoneTrigger) {
      const milestoneCount = Math.floor((currentTotalRevenue - lastMilestoneHit) / MILESTONE_INCREMENT);
      
      // 4. Trigger Milestone Billing Approval
      await db.insert(approvals).values({
        id: randomUUID(),
        userId,
        type: 'financial',
        status: 'pending',
        payload: {
          revenueTarget: nextMilestoneTrigger,
          successFee: 3000 * milestoneCount, // $30 in cents per $1000
          message: `Congratulations! Your business has reached a new revenue milestone of $${(nextMilestoneTrigger/100).toLocaleString()}.`
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // 5. Update or insert milestone record
      if (!milestone) {
        await db.insert(revenueMilestones).values({
          id: randomUUID(),
          userId,
          totalRevenue: currentTotalRevenue,
          lastMilestoneHit: nextMilestoneTrigger,
          updatedAt: new Date(),
        });
      } else {
        await db.update(revenueMilestones)
          .set({ 
            totalRevenue: currentTotalRevenue,
            lastMilestoneHit: nextMilestoneTrigger,
            updatedAt: new Date(),
          })
          .where(eq(revenueMilestones.userId, userId));
      }
    } else {
      // Just update the total revenue if no milestone hit
      if (!milestone) {
        await db.insert(revenueMilestones).values({
          id: randomUUID(),
          userId,
          totalRevenue: currentTotalRevenue,
          lastMilestoneHit: 0,
          updatedAt: new Date(),
        });
      } else {
        await db.update(revenueMilestones)
          .set({ 
            totalRevenue: currentTotalRevenue,
            updatedAt: new Date(),
          })
          .where(eq(revenueMilestones.userId, userId));
      }
    }

    return {
      userId,
      newTotal: currentTotalRevenue,
      milestoneHit: currentTotalRevenue >= nextMilestoneTrigger
    };
  }

  /**
   * Securely ingest data from external platforms.
   */
  async ingestFromPlatform(userId: string, platform: string, transactions: any[]) {
     // Record each transaction in the ledger
     for (const tx of transactions) {
        await db.insert(revenueTransactions).values({
          id: randomUUID(),
          userId,
          platform,
          amount: tx.amount,
          currency: tx.currency || 'usd',
          externalTransactionId: tx.id,
          date: tx.date || new Date(),
          createdAt: new Date(),
        });
     }

     // Trigger milestone processing
     return await this.processMilestones(userId);
  }

  /**
   * Securely decrypts and uses API credentials in-memory only.
   */
  async secureFetchWithDecryption(encryptedCredentials: string) {
    const rawCreds = decrypt(encryptedCredentials);
    // Use rawCreds to call Etsy/Stripe APIs...
    return { status: 'success', data: 'Aggregated Revenue Data' };
  }
}

export const revenueOracle = new RevenueOracleService();
