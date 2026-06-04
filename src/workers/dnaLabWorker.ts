import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { dnaLabService } from '../services/dnaLabService.js';
import { webSocketService } from '../services/websocketService.js';
import { notificationService } from '../services/notificationService.js';

export const startDnaLabWorker = () => {
  const worker = new Worker(
    'dna-lab-tasks',
    async (job: Job) => {
      const { userId, platform, videoUrl } = job.data;
      console.log(`[DnaLabWorker] Processing video for user ${userId}: ${videoUrl}`);

      webSocketService.notifyUser(userId, 'dna-analysis-started', { jobId: job.id, videoUrl });

      try {
        const result = await dnaLabService.processViralContent(userId, platform, videoUrl);

        webSocketService.notifyUser(userId, 'dna-analysis-completed', { 
          jobId: job.id, 
          status: 'success',
          dnaProfile: result.dnaProfile 
        });

        await notificationService.notifyUser(userId, `Style DNA Analysis complete for ${platform}`, false);
        
        return result;
      } catch (error: any) {
        console.error(`[DnaLabWorker] Error processing job ${job.id}:`, error);
        
        webSocketService.notifyUser(userId, 'dna-analysis-failed', { 
          jobId: job.id, 
          error: error.message 
        });

        await notificationService.notifyUser(userId, `DNA Analysis failed: ${error.message}`, true);
        
        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency: 1, // High memory usage, keep concurrency low
    }
  );

  worker.on('completed', (job) => {
    console.log(`[DnaLabWorker] Job ${job.id} has completed!`);
  });

  worker.on('failed', (job, err) => {
    console.log(`[DnaLabWorker] Job ${job?.id} has failed with ${err.message}`);
  });

  return worker;
};
