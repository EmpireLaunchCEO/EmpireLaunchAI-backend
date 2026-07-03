import { Router } from 'express';
import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { auditService } from '../services/auditService.js';

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

    const [user] = await db.select({ createdAt: users.createdAt })
      .from(users).where(eq(users.id, userId)).limit(1);

    const [milestone] = await db.select({
      totalRevenue: revenueMilestones.totalRevenue,
      lifetimeSurchargesPaid: revenueMilestones.lifetimeSurchargesPaid,
    }).from(revenueMilestones).where(eq(revenueMilestones.userId, userId)).limit(1);

    const [aiTxResult] = await db.select({
      aiRevenue: sql<number>`COALESCE(SUM(${revenueTransactions.amount}), 0)`,
    }).from(revenueTransactions).where(
      and(eq(revenueTransactions.userId, userId), eq(revenueTransactions.isAiGenerated, true))
    ).limit(1);

    const [contentResult] = await db.select({
      count: sql<number>`COUNT(*)`,
    }).from(scheduledPosts).innerJoin(campaigns, eq(scheduledPosts.campaignId, campaigns.id))
      .where(and(eq(campaigns.userId, userId), eq(scheduledPosts.status, 'approved'))).limit(1);

    const [campaignResult] = await db.select({
      count: sql<number>`COUNT(*)`,
    }).from(campaigns).where(
      and(eq(campaigns.userId, userId), eq(campaigns.status, 'active'))
    ).limit(1);

    const platformRows = await db.selectDistinct({ platform: integrations.platform })
      .from(integrations)
      .where(and(eq(integrations.userId, userId), eq(integrations.isActive, true)));
    const connectedPlatforms = platformRows.map((r: { platform: string }) => r.platform);

    const [subResult] = await db.select({ count: sql<number>`COUNT(*)` })
      .from(subscriptionLogs)
      .where(and(eq(subscriptionLogs.userId, userId), eq(subscriptionLogs.status, 'paid')))
      .limit(1);

    const totalRevenue = milestone?.totalRevenue || 0;
    const aiAttributedRevenue = aiTxResult?.aiRevenue || 0;
    const successShareDue = Math.floor(aiAttributedRevenue * 0.04);
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

/**
 * GET /api/audit/statements
 * Returns the last 12 monthly audit statements.
 */
router.get('/statements', mobileAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const statements = await auditService.getStatements(userId);
    res.json({ userId, statements });
  } catch (error: any) {
    console.error('[AuditRoute] Error fetching statements:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/audit/statement/download
 * Returns a text-format audit statement for download.
 */
router.get('/statement/download', mobileAuth, async (req: any, res: any) => {
  try {
    const statementId = req.query.statementId as string;
    if (!statementId) return res.status(400).json({ error: 'statementId is required' });

    const statement = await auditService.getStatement(statementId);
    if (!statement) return res.status(404).json({ error: 'Statement not found' });

    const text = auditService.formatStatementText(statement);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${statement.month}-${statement.year}.txt"`);
    res.send(text);
  } catch (error: any) {
    console.error('[AuditRoute] Error downloading statement:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;