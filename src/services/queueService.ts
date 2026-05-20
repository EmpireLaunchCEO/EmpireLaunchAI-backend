import { Queue, Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { orchestrator } from '../agents/orchestrator.js';
import { HumanMessage } from '@langchain/core/messages';
import { webSocketService } from './websocketService.js';
import { notificationService } from './notificationService.js';

export const aiTaskQueue = new Queue('ai-tasks', {
  connection: redisConnection,
});

export const startAIWorker = () => {
  const worker = new Worker(
    'ai-tasks',
    async (job: Job) => {
      console.log(`Processing job ${job.id}: ${job.name}`);
      const { goal, userId, context } = job.data;

      // Notify user that processing has started
      webSocketService.notifyUser(userId, 'job-started', { jobId: job.id, goal });

      try {
        const result: any = await orchestrator.invoke({
          messages: [new HumanMessage(goal)],
          userId,
          context: {
            ...context,
            jobId: job.id,
          },
        });

        // Notify user via WebSocket that processing is complete
        webSocketService.notifyUser(userId, 'job-completed', { 
          jobId: job.id, 
          status: 'success',
          resultSummary: result.summary || 'Task completed successfully' 
        });
        
        // Trigger push notification for mobile clients
        await notificationService.notifyUser(userId, `Task completed: ${job.name}`, false);
        
        console.log(`Job ${job.id} completed successfully.`);
        
        return result;
      } catch (error: any) {
        console.error(`Error processing job ${job.id}:`, error);
        
        // Notify user of failure
        webSocketService.notifyUser(userId, 'job-failed', { 
          jobId: job.id, 
          error: error.message 
        });

        // Trigger push notification for mobile clients
        await notificationService.notifyUser(userId, `Task failed: ${job.name}. Error: ${error.message}`, false);
        
        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency: 5, // Process up to 5 AI tasks concurrently per worker node
    }
  );

  worker.on('completed', (job) => {
    if (job) {
      console.log(`Job ${job.id} has completed!`);
    }
  });

  worker.on('failed', (job, err) => {
    if (job) {
      console.log(`Job ${job.id} has failed with ${err.message}`);
    } else {
      console.log(`A job failed with ${err.message}`);
    }
  });

  return worker;
};
