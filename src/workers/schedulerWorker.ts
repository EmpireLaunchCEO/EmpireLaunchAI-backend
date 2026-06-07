import cron from 'node-cron';
import { campaignService } from '../services/campaignService.js';
import { retentionService } from '../services/retentionService.js';
import { growthIngestionOrchestrator } from '../services/growthIngestionOrchestrator.js';

export class SchedulerWorker {
  start() {
    console.log('[SchedulerWorker] Starting post execution scheduler...');
    
    // Check for approved posts every minute
    cron.schedule('* * * * *', async () => {
      try {
        await campaignService.executeApprovedPosts();
      } catch (error) {
        console.error('[SchedulerWorker] Error executing approved posts:', error);
      }
    });

    // Run retention scan every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
      try {
        const userId = '00000000-0000-0000-0000-000000000000';
        await retentionService.scanAndGenerateDrafts(userId);
      } catch (error) {
        console.error('[SchedulerWorker] Error running retention scan:', error);
      }
    });

    // ─── GROWTH INGESTION ───────────────────────────────────────
    // Poll Etsy + TikTok for new sales/engagement data every 30 minutes.
    // Feeds into RevenueOracle for milestone tracking + thank-you emails.
    console.log('[SchedulerWorker] Growth Ingestion scheduled: every 30 minutes');
    cron.schedule('*/30 * * * *', async () => {
      try {
        const result = await growthIngestionOrchestrator.runIngestionCycle();
        if (result.errors.length > 0) {
          console.warn('[SchedulerWorker] Growth ingestion had errors:', result.errors);
        }
        console.log(`[SchedulerWorker] Growth ingestion: ${result.usersProcessed} users, ${result.etsySalesFound} Etsy sales, ${result.tiktokVideosFound} TikTok videos`);
      } catch (error) {
        console.error('[SchedulerWorker] Error running growth ingestion:', error);
      }
    });
  }
}

export const schedulerWorker = new SchedulerWorker();
