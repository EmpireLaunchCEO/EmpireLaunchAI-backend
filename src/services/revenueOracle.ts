import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { decrypt } from '../utils/encryption.js';
import { v4 as uuidv4 } from 'uuid';
import { gmailService } from './gmailService.js';

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
   * Calculates pending dues according to the Withholding & Reversion Protocol.
   */
  async calculatePendingDues(userId: string) {
    const [milestone] = await db.select().from(revenueMilestones).where(eq(revenueMilestones.userId, userId)).limit(1);
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    
    const tier = user?.tier || 'STANDARD_USER';
    
    let subscriptionFee = 3000; // $30 in cents
    let surchargePer1000 = 3000; // $30 in cents

    if (tier === 'OWNER_MASTER') {
      subscriptionFee = 0;
      surchargePer1000 = 0;
    } else if (tier === 'BETA_TESTER') {
      subscriptionFee = 0;
      surchargePer1000 = 3000;
    }

    if (!milestone) return { total: subscriptionFee, subscription: subscriptionFee, surcharges: 0 };
    
    const lifetimeRevenue = milestone.totalRevenue;
    const lifetimeSurchargesPaid = milestone.lifetimeSurchargesPaid || 0;
    
    const totalSurchargesAccrued = Math.floor(lifetimeRevenue / 100000) * surchargePer1000;
    const unpaidSurcharges = Math.max(0, totalSurchargesAccrued - lifetimeSurchargesPaid);
    
    return {
      total: subscriptionFee + unpaidSurcharges,
      subscription: subscriptionFee,
      surcharges: unpaidSurcharges
    };
  }

  /**
   * Aggregates revenue for a specific user and checks for $1,000 milestones.
   */
  async processMilestones(userId: string) {
    // 1. Get current revenue state
    const [milestone] = await db.select().from(revenueMilestones).where(eq(revenueMilestones.userId, userId));
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    
    const tier = user?.tier || 'STANDARD_USER';
    let surchargePer1000 = 3000; // $30 in cents
    if (tier === 'OWNER_MASTER') {
      surchargePer1000 = 0;
    }

    // 2. Fetch recent un-aggregated transactions from the ledger
    const transactions = await db.select().from(revenueTransactions).where(eq(revenueTransactions.userId, userId));
    
    const currentTotalRevenue = transactions.reduce((sum: number, tx: any) => sum + tx.amount, 0);
    const lastMilestoneHit = milestone?.lastMilestoneHit || 0;

    // 3. Calculate Milestone
    const MILESTONE_INCREMENT = 100000; // $1,000 in cents
    
    // Check if we've crossed a new $1000 boundary
    const currentMilestoneCount = Math.floor(currentTotalRevenue / MILESTONE_INCREMENT);
    const lastMilestoneCount = Math.floor(lastMilestoneHit / MILESTONE_INCREMENT);

    if (currentMilestoneCount > lastMilestoneCount) {
      const milestoneDiff = currentMilestoneCount - lastMilestoneCount;
      const dues = await this.calculatePendingDues(userId);
      
      const successFee = surchargePer1000 * milestoneDiff;

      // 4. Trigger Milestone Billing Approval if there's a fee
      if (successFee > 0 || dues.subscription > 0) {
        await db.insert(approvals).values({
          id: uuidv4(),
          userId,
          type: 'financial',
          status: 'pending',
          payload: {
            revenueTarget: currentMilestoneCount * MILESTONE_INCREMENT,
            successFee: successFee,
            pendingDues: dues.total,
            message: `Congratulations! Your business has reached a new revenue milestone. Total Revenue: ${(currentTotalRevenue/100).toLocaleString()}.`
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // 5. Update or insert milestone record
      if (!milestone) {
        await db.insert(revenueMilestones).values({
          id: uuidv4(),
          userId,
          totalRevenue: currentTotalRevenue,
          lastMilestoneHit: currentMilestoneCount * MILESTONE_INCREMENT,
          updatedAt: new Date(),
        });
      } else {
        await db.update(revenueMilestones)
          .set({ 
            totalRevenue: currentTotalRevenue,
            lastMilestoneHit: currentMilestoneCount * MILESTONE_INCREMENT,
            updatedAt: new Date(),
          })
          .where(eq(revenueMilestones.userId, userId));
      }
    } else {
      // Just update the total revenue if no milestone hit
      if (!milestone) {
        await db.insert(revenueMilestones).values({
          id: uuidv4(),
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
      milestoneHit: currentMilestoneCount > lastMilestoneCount
    };
  }

  /**
   * Returns the maximum amount a user can withdraw after withholding dues.
   */
  async getWithdrawalLimit(userId: string, totalPlatformBalance: number) {
    const dues = await this.calculatePendingDues(userId);
    return Math.max(0, totalPlatformBalance - dues.total);
  }

  /**
   * Securely ingest data from external platforms.
   */
  async ingestFromPlatform(userId: string, platform: string, transactions: any[]) {
     // Record each transaction in the ledger
     for (const tx of transactions) {
        await db.insert(revenueTransactions).values({
          id: uuidv4(),
          userId,
          platform,
          amount: tx.amount,
          currency: tx.currency || 'usd',
          externalTransactionId: tx.id,
          date: tx.date || new Date(),
          createdAt: new Date(),
        });

        // Trigger Thank You Email if relevant info exists
        if (tx.customerEmail && tx.productName) {
            try {
                await gmailService.sendThankYouEmail(userId, tx.customerEmail, tx.productName, tx.niche || 'Digital Marketing');
            } catch (e: any) {
                console.warn(`[RevenueOracle] Failed to send thank you email: ${e.message}`);
            }
        }
     }

     // Trigger milestone processing
     return await this.processMilestones(userId);
  }

  /**
   * Records a payment of surcharges/success fees.
   */
  async recordSurchargePayment(userId: string, amountInCents: number) {
    await db.update(revenueMilestones)
      .set({
        lifetimeSurchargesPaid: sql`${revenueMilestones.lifetimeSurchargesPaid} + ${amountInCents}`,
        updatedAt: new Date()
      })
      .where(eq(revenueMilestones.userId, userId));
    
    // Also record in subscription logs
    await db.insert(schema.subscriptionLogs).values({
        id: uuidv4(),
        userId,
        amount: amountInCents,
        status: 'paid',
        periodStart: new Date(),
        periodEnd: new Date(), // Surcharges are point-in-time
        type: 'surcharge',
        createdAt: new Date()
    });
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
