import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
const { users, auditLogs } = schema;

export class FraudSentinelService {
  /**
   * Scans for common fraudulent patterns.
   * In a real system, this would use ML models or complex rule sets.
   */
  async scanForAbuse(userId: string, activityDetails: any) {
    console.log(`FraudSentinel: Scanning activity for user ${userId}`);

    const isSuspicious = this.runHeuristics(activityDetails);

    if (isSuspicious) {
      await this.deactivateAccount(userId, 'SCAM_PATTERN_DETECTED');
      return true;
    }

    return false;
  }

  private runHeuristics(details: any): boolean {
    // Example rules:
    // 1. Rapid creation of similar products
    // 2. High-risk keywords in descriptions
    // 3. Known scammer IP ranges (mocked)

    const scamKeywords = ['get rich quick', 'guaranteed returns', 'wire transfer only', 'free money'];
    const text = JSON.stringify(details).toLowerCase();

    for (const keyword of scamKeywords) {
      if (text.includes(keyword)) {
        console.warn(`FraudSentinel: Scam keyword detected: ${keyword}`);
        return true;
      }
    }

    return false;
  }

  async deactivateAccount(userId: string, reason: string) {
    console.error(`FraudSentinel: DEACTIVATING ACCOUNT ${userId}. Reason: ${reason}`);

    // 1. Lock the account
    await db.update(users)
      .set({ isLocked: true, updatedAt: new Date() })
      .where(eq(users.id, userId));

    // 2. Log the action
    // @ts-ignore
    await db.insert(auditLogs).values({
      actorId: 'SYSTEM_FRAUD_SENTINEL',
      action: 'ACCOUNT_DEACTIVATION',
      targetId: userId,
      details: { reason, timestamp: new Date().toISOString() },
      createdAt: new Date()
    });

    // In a real system, we would also:
    // - Cancel all active Stripe subscriptions
    // - Invalid tokens
    // - Notify support
  }
}

export const fraudSentinel = new FraudSentinelService();
