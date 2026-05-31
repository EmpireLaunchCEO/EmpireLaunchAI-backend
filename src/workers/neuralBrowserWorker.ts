import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { neuralBrowserService } from '../services/neuralBrowserService.js';
import { webSocketService } from '../services/websocketService.js';
import { notificationService } from '../services/notificationService.js';

export const startNeuralBrowserWorker = () => {
  const worker = new Worker(
    'neural-browser-tasks',
    async (job: Job) => {
      const { userId, steps, taskTitle } = job.data;
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
