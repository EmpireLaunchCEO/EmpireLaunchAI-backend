import { db, schema } from '../db/index.js';
const { goals, tasks, approvals, integrations, marketSignals, executionDecisions, historicalPerformance, engagementMetrics, revenueTransactions, strategySuggestions } = schema;
import { eq, and, desc, lte, gte, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

// ─── Types ──────────────────────────────────────────────────────────────────

export type DecisionType =
  | 'RESEARCH'
  | 'CREATE_CONTENT'
  | 'DRAFT_LISTING'
  | 'SCHEDULE_POST'
  | 'MONITOR_PERFORMANCE'
  | 'OPTIMIZE_STRATEGY'
  | 'WAIT_FOR_APPROVAL'
  | 'SELF_CORRECT'
  | 'NOTIFY_USER'
  | 'NO_ACTION';

export type ExecutionDecision =
  | { type: 'RESEARCH'; niche: string; platforms: string[] }
  | { type: 'CREATE_CONTENT'; taskId: string; platform: string }
  | { type: 'DRAFT_LISTING'; productName: string; platform: string }
  | { type: 'SCHEDULE_POST'; assetId: string; platforms: string[] }
  | { type: 'MONITOR_PERFORMANCE'; assetIds: string[] }
  | { type: 'OPTIMIZE_STRATEGY'; reason: string }
  | { type: 'WAIT_FOR_APPROVAL'; approvalId: string }
  | { type: 'SELF_CORRECT'; taskId: string; diagnosis: string }
  | { type: 'NOTIFY_USER'; message: string; severity: 'info' | 'success' | 'warning' }
  | { type: 'NO_ACTION'; reason: string };

export interface ReasonWeight {
  dimension: string;
  score: number;       // 0-100 how strong this dimension's signal is
  reasoning: string;   // why this score was assigned
  priority: 'high' | 'medium' | 'low';
}

export interface ReasoningContext {
  goal: typeof goals.$inferSelect;
  completedTasks: (typeof tasks.$inferSelect)[];
  pendingApprovals: (typeof approvals.$inferSelect)[];
  failedTasks: (typeof tasks.$inferSelect)[];
  recentMarketSignals: (typeof marketSignals.$inferSelect)[];
  performanceData: {
    recentRevenue: number;
    recentEngagement: number;
    revenueVelocity: number; // trend direction
  };
  connectedPlatforms: string[];
  recentDecisions: (typeof executionDecisions.$inferSelect)[];
}

export interface CorrectionPlan {
  action: 'NOTIFY_USER' | 'RETRY' | 'REGENERATE';
  severity?: 'info' | 'warning' | 'error';
  message: string;
  delayMinutes?: number;
  pivotStrategy?: string;
  platformsToReconnect?: string[];
}

export interface TickResult {
  decision: ExecutionDecision;
  decisionId: string;
  weights: ReasonWeight[];
  logged: boolean;
}

// ─── Self-Correction Engine ─────────────────────────────────────────────────

export class SelfCorrectionEngine {
  private attemptCounts: Map<string, number> = new Map();

  async analyzeFailure(taskId: string, error: Error): Promise<CorrectionPlan> {
    const errMsg = error.message.toLowerCase();

    // Auth failures — notify user to reconnect
    if (errMsg.includes('401') || errMsg.includes('unauthorized') || errMsg.includes('token expired')) {
      // Extract platform name from error context if available
      const platformMatch = error.message.match(/platform[:\s]+(\w+)/i);
      const platforms = platformMatch ? [platformMatch[1]] : ['etsy'];

      return {
        action: 'NOTIFY_USER',
        severity: 'warning',
        message: `API token expired for ${platforms[0]}. Please re-connect your ${platforms[0]} account to resume automation.`,
        platformsToReconnect: platforms,
      };
    }

    // Rate limits — retry with backoff
    if (errMsg.includes('rate_limit') || errMsg.includes('rate limit') || errMsg.includes('429')) {
      const attempts = this.incrementAttempt(taskId);
      const delayMinutes = Math.min(Math.pow(2, attempts) * 5, 120); // 5min, 10min, 20min, ... 120min max

      return {
        action: 'RETRY',
        delayMinutes,
        message: `Rate limited. Will retry automatically in ${delayMinutes} minute(s).`,
      };
    }

    // Anti-copycat / similarity rejection — regenerate
    if (errMsg.includes('similarity') || errMsg.includes('too similar') || errMsg.includes('copycat')) {
      return {
        action: 'REGENERATE',
        pivotStrategy: 'color_invert',
        message: 'Design was too similar to existing content. Regenerating with shifted palette and layout.',
      };
    }

    // Network / timeout — retry quickly
    if (errMsg.includes('timeout') || errMsg.includes('econnrefused') || errMsg.includes('econnreset') || errMsg.includes('network')) {
      return {
        action: 'RETRY',
        delayMinutes: 2,
        message: 'Network error encountered. Will retry in 2 minutes.',
      };
    }

    // Unknown — escalate to user
    return {
      action: 'NOTIFY_USER',
      severity: 'error',
      message: `Task "${taskId}" encountered an unexpected error: ${error.message}. Manual review may be needed.`,
    };
  }

  private incrementAttempt(taskId: string): number {
    const current = this.attemptCounts.get(taskId) || 0;
    const next = current + 1;
    this.attemptCounts.set(taskId, next);
    return next;
  }

  resetAttempts(taskId: string): void {
    this.attemptCounts.delete(taskId);
  }
}

// ─── Goal Execution Engine ──────────────────────────────────────────────────

export class GoalExecutionEngine {
  private correctionEngine: SelfCorrectionEngine;

  constructor() {
    this.correctionEngine = new SelfCorrectionEngine();
  }

  /**
   * The main loop tick. Called periodically (every hour / on trigger).
   * Gathers all state, runs the Reasoner, logs the decision, and returns it.
   */
  async tick(goalId: string): Promise<TickResult> {
    // 1. Gather current state
    const context = await this.gatherContext(goalId);

    // 2. Run the Strategic Reasoner
    const decision = await this.reason(context);
    const weights = this.evaluateDimensions(context);

    // 3. Log the decision to the database
    const decisionId = await this.logDecision(goalId, decision, weights);

    return {
      decision,
      decisionId,
      weights,
      logged: true,
    };
  }

  /**
   * Gather all context needed for reasoning.
   */
  private async gatherContext(goalId: string): Promise<ReasoningContext> {
    const [goal] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    if (!goal) {
      throw new Error(`Goal "${goalId}" not found`);
    }

    const completedTasks = await db.select()
      .from(tasks)
      .where(and(eq(tasks.goalId, goalId), eq(tasks.status, 'completed')));

    const pendingApprovals = await db.select()
      .from(approvals)
      .where(and(
        eq(approvals.userId, goal.userId),
        eq(approvals.status, 'pending')
      ));

    const failedTasks = await db.select()
      .from(tasks)
      .where(and(eq(tasks.goalId, goalId), eq(tasks.status, 'failed')));

    const recentMarketSignals = await db.select()
      .from(marketSignals)
      .where(eq(marketSignals.actionable, true))
      .orderBy(desc(marketSignals.createdAt))
      .limit(20);

    // Performance data — last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentRevenue = await db.select({
      total: sql<number>`COALESCE(SUM(${revenueTransactions.amount}), 0)`,
    })
      .from(revenueTransactions)
      .where(and(
        eq(revenueTransactions.userId, goal.userId),
        gte(revenueTransactions.date, thirtyDaysAgo)
      ));

    const recentEngagement = await db.select({
      total: sql<number>`COALESCE(SUM(${engagementMetrics.viewCount}), 0)`,
    })
      .from(engagementMetrics)
      .where(and(
        eq(engagementMetrics.userId, goal.userId),
        gte(engagementMetrics.date, thirtyDaysAgo)
      ));

    // Revenue velocity — compare last 7 days to previous 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const last7 = await db.select({
      total: sql<number>`COALESCE(SUM(${revenueTransactions.amount}), 0)`,
    })
      .from(revenueTransactions)
      .where(and(
        eq(revenueTransactions.userId, goal.userId),
        gte(revenueTransactions.date, sevenDaysAgo)
      ));

    const prev7 = await db.select({
      total: sql<number>`COALESCE(SUM(${revenueTransactions.amount}), 0)`,
    })
      .from(revenueTransactions)
      .where(and(
        eq(revenueTransactions.userId, goal.userId),
        gte(revenueTransactions.date, fourteenDaysAgo),
        lte(revenueTransactions.date, sevenDaysAgo)
      ));

    const revenueVelocity = prev7[0].total > 0
      ? ((last7[0].total - prev7[0].total) / prev7[0].total) * 100
      : 0;

    // Connected platforms
    const integrationRows = await db.select({ platform: integrations.platform })
      .from(integrations)
      .where(and(eq(integrations.userId, goal.userId), eq(integrations.isActive, true)));
    const connectedPlatforms = [...new Set(integrationRows.map((r: any) => r.platform))] as string[];

    // Recent decisions
    const recentDecisions = await db.select()
      .from(executionDecisions)
      .where(eq(executionDecisions.goalId, goalId))
      .orderBy(desc(executionDecisions.createdAt))
      .limit(10);

    return {
      goal,
      completedTasks,
      pendingApprovals,
      failedTasks,
      recentMarketSignals,
      performanceData: {
        recentRevenue: recentRevenue[0]?.total || 0,
        recentEngagement: recentEngagement[0]?.total || 0,
        revenueVelocity,
      },
      connectedPlatforms,
      recentDecisions,
    };
  }

  /**
   * THE REASONER — The AI thinks about what to do next.
   * Evaluates 6 dimensions and returns the best decision.
   */
  private async reason(context: ReasoningContext): Promise<ExecutionDecision> {
    const weights = this.evaluateDimensions(context);

    // ── Dimension 1: Pending Approvals → WAIT ──
    if (context.pendingApprovals.length > 0) {
      const highPriority = context.pendingApprovals.find(a => a.type === 'financial' || a.type === 'subscription');
      const target = highPriority || context.pendingApprovals[0];
      return {
        type: 'WAIT_FOR_APPROVAL',
        approvalId: target.id,
      };
    }

    // ── Dimension 2: Failed Tasks → SELF_CORRECT ──
    if (context.failedTasks.length > 0) {
      // Self-correct the most recent failed task
      const mostRecentFailed = context.failedTasks.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )[0];
      return {
        type: 'SELF_CORRECT',
        taskId: mostRecentFailed.id,
        diagnosis: `Task "${mostRecentFailed.title}" failed. Attempting self-correction based on error pattern.`,
      };
    }

    // ── Dimension 3: Market Opportunity → RESEARCH ──
    const hasActionableSignals = context.recentMarketSignals.length > 0;
    const hasHighConfidenceSignals = context.recentMarketSignals.some(s => (s.confidence || 0) >= 0.7);

    if (hasActionableSignals && hasHighConfidenceSignals && context.completedTasks.length < 3) {
      // Early stage — research is high priority
      const topSignal = context.recentMarketSignals.sort(
        (a, b) => (b.confidence || 0) - (a.confidence || 0)
      )[0];
      return {
        type: 'RESEARCH',
        niche: topSignal.niche,
        platforms: context.connectedPlatforms.length > 0
          ? context.connectedPlatforms.slice(0, 3)
          : ['etsy', 'tiktok'],
      };
    }

    // ── Dimension 4: Low Engagement → MONITOR_PERFORMANCE ──
    if (context.completedTasks.length >= 3 && context.performanceData.recentEngagement === 0) {
      return {
        type: 'MONITOR_PERFORMANCE',
        assetIds: context.completedTasks
          .filter(t => t.result && typeof t.result === 'object')
          .map(t => t.id),
      };
    }

    // ── Dimension 5: Revenue Optimization ──
    if (context.performanceData.recentRevenue > 0 && context.performanceData.revenueVelocity < -10) {
      // Revenue is declining — optimize
      return {
        type: 'OPTIMIZE_STRATEGY',
        reason: `Revenue velocity is ${context.performanceData.revenueVelocity.toFixed(1)}% (declining). ` +
          `Current 30-day revenue: $${(context.performanceData.recentRevenue / 100).toFixed(2)}. ` +
          `Adjusting strategy to recover momentum.`,
      };
    }

    // ── Dimension 6: Productive State — CREATE_CONTENT or SCHEDULE_POST ──
    const archetype = (context.goal as any).archetype || 'creator';

    if (context.completedTasks.length >= 1) {
      // If we have a completed task, create content for the next step
      const lastTask = context.completedTasks[context.completedTasks.length - 1];
      const availablePlatforms = context.connectedPlatforms.filter(
        p => ['tiktok', 'instagram', 'facebook', 'youtube'].includes(p)
      );

      // Catalysts prioritize social content distribution
      if (archetype === 'catalyst' && availablePlatforms.length > 0) {
        return {
          type: 'CREATE_CONTENT',
          taskId: lastTask.id,
          platform: availablePlatforms[0],
        };
      }

      // Creators follow the normal pipeline (Listing then Promotion)
      if (archetype === 'creator') {
        if (context.connectedPlatforms.some(p => ['etsy', 'shopify', 'etsy_shop'].includes(p))) {
          return {
            type: 'DRAFT_LISTING',
            productName: context.goal.title || 'New Product',
            platform: context.connectedPlatforms.find(p => ['etsy', 'shopify'].includes(p)) || 'etsy',
          };
        }
      }

      if (availablePlatforms.length > 0) {
        return {
          type: 'CREATE_CONTENT',
          taskId: lastTask.id,
          platform: availablePlatforms[0],
        };
      }
    }

    // ── No strong signal → NO_ACTION ──
    const topWeight = weights.sort((a, b) => b.score - a.score)[0];
    return {
      type: 'NO_ACTION',
      reason: topWeight
        ? `All dimensions evaluated. Strongest signal: ${topWeight.dimension} (${topWeight.score}/100). No urgent action required.`
        : 'No significant signals detected across any dimension. Waiting for new data.',
    };
  }

  /**
   * Evaluate all 6 reasoning dimensions and return scored weights.
   */
  private evaluateDimensions(context: ReasoningContext): ReasonWeight[] {
    const weights: ReasonWeight[] = [];

    // 1. Goal Progress
    const progressScore = context.completedTasks.length > 0
      ? Math.min(context.completedTasks.length * 15, 100)
      : 0;
    weights.push({
      dimension: 'Goal Progress',
      score: progressScore,
      reasoning: `${context.completedTasks.length} tasks completed${context.performanceData.recentRevenue > 0 ? `, $${(context.performanceData.recentRevenue / 100).toFixed(2)} revenue in 30 days` : ''}`,
      priority: progressScore > 50 ? 'high' : progressScore > 20 ? 'medium' : 'low',
    });

    // 2. Platform Health
    const healthScore = Math.min(context.connectedPlatforms.length * 10, 100);
    weights.push({
      dimension: 'Platform Health',
      score: healthScore,
      reasoning: `${context.connectedPlatforms.length} platform(s) connected and active`,
      priority: healthScore < 30 ? 'high' : 'medium',
    });

    // 3. Market Opportunity
    const hasSignals = context.recentMarketSignals.length > 0;
    const avgConfidence = hasSignals
      ? context.recentMarketSignals.reduce((sum, s) => sum + (s.confidence || 0), 0) / context.recentMarketSignals.length
      : 0;
    const marketScore = hasSignals ? Math.min(avgConfidence * 100, 100) : 0;
    weights.push({
      dimension: 'Market Opportunity',
      score: marketScore,
      reasoning: hasSignals
        ? `${context.recentMarketSignals.length} actionable signals, avg confidence ${(avgConfidence * 100).toFixed(0)}%`
        : 'No actionable market signals detected',
      priority: marketScore > 60 ? 'high' : marketScore > 30 ? 'medium' : 'low',
    });

    // 4. Execution Status
    const pendingCount = context.pendingApprovals.length;
    const failedCount = context.failedTasks.length;
    const executionScore = Math.min((pendingCount * 25) + (failedCount * 35), 100);
    weights.push({
      dimension: 'Execution Status',
      score: executionScore,
      reasoning: `${pendingCount} pending approval(s), ${failedCount} failed task(s)`,
      priority: executionScore > 50 ? 'high' : executionScore > 0 ? 'medium' : 'low',
    });

    // 5. Performance Feedback
    const perfScore = context.performanceData.recentRevenue > 0
      ? Math.min(Math.abs(context.performanceData.revenueVelocity), 100)
      : 10;
    weights.push({
      dimension: 'Performance Feedback',
      score: perfScore,
      reasoning: `Revenue velocity: ${context.performanceData.revenueVelocity.toFixed(1)}%` +
        (context.performanceData.recentEngagement > 0 ? `, ${context.performanceData.recentEngagement} total views` : ''),
      priority: Math.abs(context.performanceData.revenueVelocity) > 20 ? 'high' : 'medium',
    });

    // 6. User Alignment
    const hasRecentDecisions = context.recentDecisions.length > 0;
    const alignmentScore = hasRecentDecisions ? 50 : 100; // No decisions = no alignment yet = more open
    weights.push({
      dimension: 'User Alignment',
      score: alignmentScore,
      reasoning: hasRecentDecisions
        ? `${context.recentDecisions.length} recent decisions, engine is in active loop`
        : 'No recent decisions logged — open for first direction',
      priority: alignmentScore > 70 ? 'low' : 'medium',
    });

    return weights;
  }

  /**
   * Log the decision to execution_decisions table.
   */
  private async logDecision(
    goalId: string,
    decision: ExecutionDecision,
    weights: ReasonWeight[],
  ): Promise<string> {
    const id = uuidv4();
    const now = new Date();

    await db.insert(executionDecisions).values({
      id,
      goalId,
      decisionType: decision.type,
      decisionPayload: JSON.parse(JSON.stringify(decision)),
      reasoning: weights.map(w => `[${w.priority.toUpperCase()}] ${w.dimension}: ${w.reasoning}`).join('\n'),
      wasExecuted: false,
      outcome: null,
      error: null,
      performanceImpact: null,
      createdAt: now,
      executedAt: null,
      completedAt: null,
    });

    return id;
  }
}

// ─── Convenience Factory ─────────────────────────────────────────────────────

let _instance: GoalExecutionEngine | null = null;

export function getEngine(): GoalExecutionEngine {
  if (!_instance) {
    _instance = new GoalExecutionEngine();
  }
  return _instance;
}