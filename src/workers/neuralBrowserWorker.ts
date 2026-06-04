import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { neuralBrowserService } from '../services/neuralBrowserService.js';
import { dnaHuntOrchestrator } from '../services/dnaHuntOrchestrator.js';
import { webSocketService } from '../services/websocketService.js';
import { notificationService } from '../services/notificationService.js';

export const startNeuralBrowserWorker = () => {
  const worker = new Worker(
    'neural-browser-tasks',
    async (job: Job) => {
      const { userId, steps, taskTitle, jobType } = job.data;

      // Handle DNA Hunt jobs (bridging onboarding → DNA Lab → Universal Vault)
      if (job.data.jobType === 'dna-hunt-auto') {
        const { huntId, platform, niche } = job.data;
        console.log(`[NeuralBrowserWorker] 🧬 Processing DNA Hunt ${huntId} for user ${userId} on ${platform}`);

        webSocketService.notifyUser(userId, 'automation-started', {
          jobId: job.id,
          taskTitle: `Automated DNA Hunt on ${platform}`,
        });

        try {
          const result = await dnaHuntOrchestrator.executeHunt(huntId, userId, platform, niche);

          webSocketService.notifyUser(userId, 'automation-completed', {
            jobId: job.id,
            status: 'success',
            strandsStored: result.strandsStored,
          });

          await notificationService.notifyUser(
            userId,
            `🧬 DNA Hunt complete! ${result.strandsStored} new Style DNA strands from ${platform} are now in the Universal Vault.`,
            false
          );

          return { status: 'success', result };
        } catch (error: any) {
          console.error(`[NeuralBrowserWorker] DNA Hunt ${huntId} failed:`, error);
          webSocketService.notifyUser(userId, 'automation-failed', {
            jobId: job.id,
            error: error.message,
          });
          throw error;
        }
      }

      // Standard browser automation handling
      console.log(`[NeuralBrowserWorker] Processing job ${job.id} for user ${userId}: ${taskTitle}`);

      // Notify user via WebSocket
      webSocketService.notifyUser(userId, 'automation-started', { jobId: job.id, taskTitle });

      try {
        const results = await neuralBrowserService.executeAutomation(userId, steps);

        webSocketService.notifyUser(userId, 'automation-completed', { 
          jobId: job.id, 
          status: 'success',
          results
        });

        await notificationService.notifyUser(userId, `Automation completed: ${taskTitle}`, false);
        
        return { status: 'success', results };
      } catch (error: any) {
        if (error.message === 'HUMAN_APPROVAL_REQUIRED') {
          console.log(`[NeuralBrowserWorker] Job ${job.id} paused for human approval.`);
          return { status: 'paused', reason: 'human_approval_required' };
        }

        console.error(`[NeuralBrowserWorker] Error processing job ${job.id}:`, error);
        
        webSocketService.notifyUser(userId, 'automation-failed', { 
          jobId: job.id, 
          error: error.message 
        });

        await notificationService.notifyUser(userId, `Automation failed: ${taskTitle}. Error: ${error.message}`, true);
        
        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency: 2, // Limit concurrency to save memory
    }
  );

  worker.on('completed', (job) => {
    console.log(`[NeuralBrowserWorker] Job ${job.id} has completed!`);
  });

  worker.on('failed', (job, err) => {
    console.log(`[NeuralBrowserWorker] Job ${job?.id} has failed with ${err.message}`);
  });

  return worker;
};
