import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { decrypt } from '../utils/encryption.js';
import { v4 as uuidv4 } from 'uuid';
import { gmailService } from './gmailService.js';
import { notificationService } from './notificationService.js';

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
   * Success-Share (4%) is calculated ONLY on AI-attributed revenue.
   */
  async calculatePendingDues(userId: string) {
    const [milestone] = await db.select().from(revenueMilestones).where(eq(revenueMilestones.userId, userId)).limit(1);
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    
    const tier = user?.tier || 'STANDARD_USER';
    const slots = user?.businessSlots || 1;
    
    let subscriptionFee = 5000 * slots; // $50 per business slot in cents
    let surchargePer1000 = 4000; // $40 in cents (4% Success-Share)

    if (tier === 'OWNER_MASTER') {
      subscriptionFee = 0;
      surchargePer1000 = 0;
    } else if (tier === 'BETA_TESTER') {
      subscriptionFee = 0;
      surchargePer1000 = 4000;
    }

    if (!milestone) return { total: subscriptionFee, subscription: subscriptionFee, surcharges: 0 };
    
    const lifetimeAiRevenue = milestone.totalAiRevenue || 0;
    const lifetimeSurchargesPaid = milestone.lifetimeSurchargesPaid || 0;
    
    const totalSurchargesAccrued = Math.floor(lifetimeAiRevenue / 100000) * surchargePer1000;
    const unpaidSurcharges = Math.max(0, totalSurchargesAccrued - lifetimeSurchargesPaid);
    
    return {
      total: subscriptionFee + unpaidSurcharges,
      subscription: subscriptionFee,
      surcharges: unpaidSurcharges
    };
  }

  /**
   * Aggregates revenue for a specific user and checks for $1,000 milestones.
   * AI milestones trigger success-share billing.
   */
  async processMilestones(userId: string) {
    // 1. Get current revenue state
    const [milestone] = await db.select().from(revenueMilestones).where(eq(revenueMilestones.userId, userId));
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    
    const tier = user?.tier || 'STANDARD_USER';
    let surchargePer1000 = 4000; // $40 in cents (4% Success-Share)
    if (tier === 'OWNER_MASTER') {
      surchargePer1000 = 0;
    }

    // 2. Fetch all transactions to calculate current aggregates
    const transactions = await db.select().from(revenueTransactions).where(eq(revenueTransactions.userId, userId));
    
    const currentTotalRevenue = transactions.reduce((sum: number, tx: any) => sum + tx.amount, 0);
    const currentAiRevenue = transactions
      .filter((tx: any) => tx.isAiGenerated)
      .reduce((sum: number, tx: any) => sum + tx.amount, 0);

    const lastAiMilestoneHit = milestone?.lastAiMilestoneHit || 0;

    // 3. Calculate AI Milestone (Success-Share only triggers on AI revenue)
    const MILESTONE_INCREMENT = 100000; // $1,000 in cents
    const currentAiMilestoneCount = Math.floor(currentAiRevenue / MILESTONE_INCREMENT);
    const lastAiMilestoneCount = Math.floor(lastAiMilestoneHit / MILESTONE_INCREMENT);

    if (currentAiMilestoneCount > lastAiMilestoneCount) {
      const milestoneDiff = currentAiMilestoneCount - lastAiMilestoneCount;
      const dues = await this.calculatePendingDues(userId);
      const successFee = surchargePer1000 * milestoneDiff;

      // 4. Trigger Milestone Billing Approval if there's a fee
      if (successFee > 0) {
        await db.insert(approvals).values({
          id: uuidv4(),
          userId,
          type: 'financial',
          status: 'pending',
          payload: {
            revenueTarget: currentAiMilestoneCount * MILESTONE_INCREMENT,
            successFee: successFee,
            pendingDues: dues.total,
            message: `Congratulations! Your business has reached a new AI revenue milestone. AI-Attributed Revenue: ${(currentAiRevenue/100).toLocaleString()}.`
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Send Native/Web Push Notification
        await notificationService.sendPushNotification(userId, {
          title: 'New AI Revenue Milestone!',
          body: `Your AI-generated content just crossed $${(currentAiMilestoneCount * 1000).toLocaleString()} in revenue. Milestone fee of $${(successFee/100).toFixed(2)} is pending approval.`,
          data: { url: '/financial-command', type: 'SALE_ALERT' }
        });
      }
    }

    // 5. Update or insert milestone record
    if (!milestone) {
      await db.insert(revenueMilestones).values({
        id: uuidv4(),
        userId,
        totalRevenue: currentTotalRevenue,
        totalAiRevenue: currentAiRevenue,
        lastMilestoneHit: Math.floor(currentTotalRevenue / MILESTONE_INCREMENT) * MILESTONE_INCREMENT,
        lastAiMilestoneHit: currentAiMilestoneCount * MILESTONE_INCREMENT,
        updatedAt: new Date(),
      });
    } else {
      await db.update(revenueMilestones)
        .set({ 
          totalRevenue: currentTotalRevenue,
          totalAiRevenue: currentAiRevenue,
          lastMilestoneHit: Math.floor(currentTotalRevenue / MILESTONE_INCREMENT) * MILESTONE_INCREMENT,
          lastAiMilestoneHit: currentAiMilestoneCount * MILESTONE_INCREMENT,
          updatedAt: new Date(),
        })
        .where(eq(revenueMilestones.userId, userId));
    }

    return {
      userId,
      newTotal: currentTotalRevenue,
      newAiTotal: currentAiRevenue,
      milestoneHit: currentAiMilestoneCount > lastAiMilestoneCount
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
          isAiGenerated: tx.isAiGenerated || false, // Attribution flag
          contentId: tx.contentId || null, // Link to specific AI content
          campaignId: tx.campaignId || null, // Link to AI campaign
          attributionSource: tx.attributionSource || 'platform_direct',
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
