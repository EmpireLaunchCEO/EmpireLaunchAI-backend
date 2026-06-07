import cron from 'node-cron';
import { campaignService } from '../services/campaignService.js';
import { retentionService } from '../services/retentionService.js';

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
        // In a multi-user app, we would loop through active users. 
        // For this dedicated instance, we use the primary user.
        const userId = '00000000-0000-0000-0000-000000000000';
        await retentionService.scanAndGenerateDrafts(userId);
      } catch (error) {
        console.error('[SchedulerWorker] Error running retention scan:', error);
      }
    });
  }
}

export const schedulerWorker = new SchedulerWorker();
