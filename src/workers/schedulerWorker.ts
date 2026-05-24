import cron from 'node-cron';
import { campaignService } from '../services/campaignService.js';

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
  }
}

export const schedulerWorker = new SchedulerWorker();
