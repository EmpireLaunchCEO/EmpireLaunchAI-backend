import cron from 'node-cron';
import { db } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { goals } from '../db/sqlite-schema.js';
import { getEngine } from '../services/goalExecutionEngine.js';
import { getRouter } from '../services/platformRouter.js';
import { getProductionWorker } from '../services/productionWorker.js';
import { marketResearcher } from '../services/autonomousMarketResearcher.js';
import { campaignService } from '../services/campaignService.js';
import { etsyPollingService } from '../services/etsyPollingService.js';

export class SchedulerWorker {
  start() {
    console.log('[SchedulerWorker] Starting schedulers...');
    
    // Check for approved posts every minute
    cron.schedule('* * * * *', async () => {
      try {
        await campaignService.executeApprovedPosts();
      } catch (error) {
        console.error('[SchedulerWorker] Error executing approved posts:', error);
      }
    });

    // Poll Etsy shops for new sales every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
      try {
        await etsyPollingService.pollAllShops();
      } catch (error) {
        console.error('[SchedulerWorker] Error polling Etsy shops:', error);
      }
    });

    // Autonomous Market Research — poll for trends every 3 hours
    cron.schedule('0 */3 * * *', async () => {
      console.log('[SchedulerWorker] Running Autonomous Market Research...');
      try {
        const result = await marketResearcher.runResearchCycle();
        console.log(`[SchedulerWorker] Market research complete: ${result.signalsFound} signals, ${result.highConfidenceSignals} high-confidence, ${result.approvalGatesTriggered.length} approval gates`);
        if (result.errors.length > 0) {
          console.warn(`[SchedulerWorker] Research errors:`, result.errors);
        }
      } catch (error) {
        console.error('[SchedulerWorker] Error in market research:', error);
      }
    });
    cron.schedule('0 * * * *', async () => {
      console.log('[SchedulerWorker] Running Goal-Execution Engine tick...');
      try {
        await this.tickAllActiveGoals();
      } catch (error) {
        console.error('[SchedulerWorker] Error in engine tick:', error);
      }
    });
  }

  /**
   * Tick all active goals across all users.
   * Each tick: gather state → reason → log decision → route execution.
   */
  private async tickAllActiveGoals(): Promise<void> {
    const activeGoals = await db.select()
      .from(goals)
      .where(eq(goals.status, 'active'));

    if (activeGoals.length === 0) {
      console.log('[SchedulerWorker] No active goals to tick.');
      return;
    }

    const engine = getEngine();
    const router = getRouter();

    for (const goal of activeGoals) {
      try {
        console.log(`[SchedulerWorker] Ticking goal: ${goal.id} ("${goal.title}")`);
        
        // Phase 1: REASON — Engine gathers state and decides what to do
        const tickResult = await engine.tick(goal.id);
        
        // Phase 2: ROUTE — Pass the decision to the PlatformRouter
        const routeResult = await router.route(tickResult.decision as any);
        
        // Phase 3: PRODUCE — Queue content jobs for producible decisions
        const prodWorker = getProductionWorker();
        const productionJob = prodWorker.processDecision(tickResult.decision as any, goal.userId);
        
        console.log(`[SchedulerWorker] Goal ${goal.id}: Decision=${tickResult.decision.type}, Route=${routeResult.success ? 'OK' : 'FAILED'}, ProdJob=${productionJob ? productionJob.jobId.slice(0,8) : 'none'}`);
        
        if (!routeResult.success) {
          console.error(`[SchedulerWorker] Route failed for goal ${goal.id}:`, routeResult.error);
        }
      } catch (error) {
        console.error(`[SchedulerWorker] Error ticking goal ${goal.id}:`, error);
      }
    }

    console.log(`[SchedulerWorker] Completed tick for ${activeGoals.length} goals.`);
  }
}

export const schedulerWorker = new SchedulerWorker();
