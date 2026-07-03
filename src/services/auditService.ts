import { db, schema } from '../db/index.js';
import { eq, and, desc, sql, gte, lte } from 'drizzle-orm';

const { auditStatements, revenueMilestones, revenueTransactions, scheduledPosts, campaigns, integrations, subscriptionLogs, users } = schema;

export class AuditService {
  /**
   * Generates a monthly audit statement by querying real data.
   */
  async generateMonthlyStatement(userId: string, month: number, year: number) {
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59);

    // 1. Revenue from milestones
    const [milestone] = await db.select({
      totalRevenue: revenueMilestones.totalRevenue,
      lifetimeSurchargesPaid: revenueMilestones.lifetimeSurchargesPaid,
      lastMilestoneHit: revenueMilestones.lastMilestoneHit,
    })
      .from(revenueMilestones)
      .where(eq(revenueMilestones.userId, userId))
      .limit(1);

    // 2. AI-attributed revenue this month
    const [aiTx] = await db.select({
      aiRevenue: sql<number>`COALESCE(SUM(${revenueTransactions.amount}), 0)`,
    })
      .from(revenueTransactions)
      .where(
        and(
          eq(revenueTransactions.userId, userId),
          eq(revenueTransactions.isAiGenerated, true),
          gte(revenueTransactions.date, monthStart),
          lte(revenueTransactions.date, monthEnd),
        )
      )
      .limit(1);

    // 3. Content created this month
    const [content] = await db.select({
      count: sql<number>`COUNT(*)`,
    })
      .from(scheduledPosts)
      .innerJoin(campaigns, eq(scheduledPosts.campaignId, campaigns.id))
      .where(
        and(
          eq(campaigns.userId, userId),
          eq(scheduledPosts.status, 'approved'),
          gte(scheduledPosts.createdAt, monthStart),
          lte(scheduledPosts.createdAt, monthEnd),
        )
      )
      .limit(1);

    // 4. Active campaigns
    const [campaign] = await db.select({
      count: sql<number>`COUNT(*)`,
    })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.userId, userId),
          eq(campaigns.status, 'active'),
        )
      )
      .limit(1);

    const totalRevenue = milestone?.totalRevenue || 0;
    const aiAttributedRevenue = aiTx?.aiRevenue || 0;
    const successShareDue = Math.floor(aiAttributedRevenue * 0.04);
    const milestoneHit = Math.floor(totalRevenue / 100000); // In $1000 increments (cents)

    // Check if statement already exists for this month
    const [existing] = await db.select({ id: auditStatements.id })
      .from(auditStatements)
      .where(
        and(
          eq(auditStatements.userId, userId),
          eq(auditStatements.month, month),
          eq(auditStatements.year, year),
        )
      )
      .limit(1);

    if (existing) {
      // Update existing
      await db.update(auditStatements)
        .set({
          totalRevenue,
          aiAttributedRevenue,
          successShareDue,
          lifetimeSurchargesPaid: milestone?.lifetimeSurchargesPaid || 0,
          contentCreated: content?.count || 0,
          activeCampaigns: campaign?.count || 0,
          milestoneHit,
          generatedAt: new Date(),
        })
        .where(eq(auditStatements.id, existing.id));
      return this.getStatement(existing.id);
    }

    // Insert new
    const [statement] = await db.insert(auditStatements).values({
      userId,
      month,
      year,
      totalRevenue,
      aiAttributedRevenue,
      successShareDue,
      lifetimeSurchargesPaid: milestone?.lifetimeSurchargesPaid || 0,
      contentCreated: content?.count || 0,
      activeCampaigns: campaign?.count || 0,
      milestoneHit,
    }).returning();

    return statement;
  }

  /**
   * Returns the last 12 statements for a user.
   */
  async getStatements(userId: string) {
    const statements = await db.select()
      .from(auditStatements)
      .where(eq(auditStatements.userId, userId))
      .orderBy(desc(auditStatements.year), desc(auditStatements.month))
      .limit(12);

    // If no statements exist, generate current month
    if (statements.length === 0) {
      const now = new Date();
      const current = await this.generateMonthlyStatement(userId, now.getMonth() + 1, now.getFullYear());
      return [current];
    }

    return statements;
  }

  /**
   * Returns a single statement by ID.
   */
  async getStatement(statementId: string) {
    const [statement] = await db.select()
      .from(auditStatements)
      .where(eq(auditStatements.id, statementId))
      .limit(1);
    return statement || null;
  }

  /**
   * Formats a statement as downloadable text.
   */
  formatStatementText(statement: any): string {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];

    return `
╔═══════════════════════════════════════════╗
║      EMPIRELAUNCH AI - AUDIT STATEMENT    ║
║      ${monthNames[statement.month - 1]} ${statement.year}                         ║
╚═══════════════════════════════════════════╝

Generated: ${new Date(statement.generatedAt).toLocaleString()}

─── Revenue ─────────────────────────────────
Total Revenue:        $${(statement.totalRevenue / 100).toFixed(2)}
AI-Attributed Revenue: $${(statement.aiAttributedRevenue / 100).toFixed(2)}
Success-Share Due (4%): $${(statement.successShareDue / 100).toFixed(2)}
Lifetime Surcharges Paid: $${(statement.lifetimeSurchargesPaid / 100).toFixed(2)}
Last Milestone Hit:    $${(statement.milestoneHit * 1000).toFixed(2)}

─── Activity ────────────────────────────────
Content Created:      ${statement.contentCreated} posts
Active Campaigns:     ${statement.activeCampaigns}

─── Success-Share Calculation ───────────────
${statement.aiAttributedRevenue > 0
  ? `4% of $${(statement.aiAttributedRevenue / 100).toFixed(2)} = $${(statement.successShareDue / 100).toFixed(2)}`
  : 'No AI-attributed revenue this period.'}

Thank you for using EmpireLaunch AI!
`;
  }
}

export const auditService = new AuditService();