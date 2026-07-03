import { Router } from 'express';
import { db, schema } from '../db/index.js';
import { eq, and, count, sql } from 'drizzle-orm';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

const { users, revenueMilestones, revenueTransactions, scheduledPosts, campaigns, integrations, subscriptionLogs } = schema;

/**
 * GET /api/audit/success-share
 * Returns real data for the success-share audit ledger.
 */
router.get('/success-share', mobileAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 1. User info (signup date)
    const [user] = await db.select({ createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // 2. Revenue milestones (totalRevenue, lifetimeSurchargesPaid)
    const [milestone] = await db.select({
      totalRevenue: revenueMilestones.totalRevenue,
      lifetimeSurchargesPaid: revenueMilestones.lifetimeSurchargesPaid,
    })
      .from(revenueMilestones)
      .where(eq(revenueMilestones.userId, userId))
      .limit(1);

    // 3. AI-attributed revenue transactions
    const [aiTxResult] = await db.select({
      aiRevenue: sql<number>`COALESCE(SUM(${revenueTransactions.amount}), 0)`,
    })
      .from(revenueTransactions)
      .where(
        and(
          eq(revenueTransactions.userId, userId),
          eq(revenueTransactions.isAiGenerated, true)
        )
      )
      .limit(1);

    // 4. Content created (approved posts)
    const [contentResult] = await db.select({
      count: sql<number>`COUNT(*)`,
    })
      .from(scheduledPosts)
      .innerJoin(campaigns, eq(scheduledPosts.campaignId, campaigns.id))
      .where(
        and(
          eq(campaigns.userId, userId),
          eq(scheduledPosts.status, 'approved')
        )
      )
      .limit(1);

    // 5. Active campaigns
    const [campaignResult] = await db.select({
      count: sql<number>`COUNT(*)`,
    })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.userId, userId),
          eq(campaigns.status, 'active')
        )
      )
      .limit(1);

    // 6. Connected platforms (distinct)
    const platformRows = await db.selectDistinct({ platform: integrations.platform })
      .from(integrations)
      .where(
        and(
          eq(integrations.userId, userId),
          eq(integrations.isActive, true)
        )
      );
    const connectedPlatforms = platformRows.map((r: { platform: string }) => r.platform);

    // 7. Subscription check
    const [subResult] = await db.select({
      count: sql<number>`COUNT(*)`,
    })
      .from(subscriptionLogs)
      .where(
        and(
          eq(subscriptionLogs.userId, userId),
          eq(subscriptionLogs.status, 'paid')
        )
      )
      .limit(1);

    const totalRevenue = milestone?.totalRevenue || 0;
    const aiAttributedRevenue = aiTxResult?.aiRevenue || 0;
    const successShareDue = Math.floor(aiAttributedRevenue * 0.04); // 4% fee
    const subscriptionPaid = (subResult?.count || 0) > 0;

    res.json({
      userId,
      generatedAt: new Date().toISOString(),
      totalRevenue,
      aiAttributedRevenue,
      successShareDue,
      lifetimeSurchargesPaid: milestone?.lifetimeSurchargesPaid || 0,
      contentCreated: contentResult?.count || 0,
      activeCampaigns: campaignResult?.count || 0,
      connectedPlatforms,
      signupDate: user?.createdAt || null,
      subscriptionPaid,
    });
  } catch (error: any) {
    console.error('[AuditRoute] Error fetching success-share data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;