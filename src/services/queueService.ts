import { Queue, Worker, Job } from 'bullmq';
import { redisConnection, isRedisDisabled } from '../config/redis.js';
import { orchestrator } from '../agents/orchestrator.js';
import { HumanMessage } from '@langchain/core/messages';
import { webSocketService } from './websocketService.js';
import { notificationService } from './notificationService.js';
import { fraudSentinel } from './fraudSentinel.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

const { users } = schema;

const createQueueMock = (name: string) => ({
  add: async (jobName: string, data: any) => {
    console.log(`[Queue Mock] Added job to ${name}: ${jobName}`, data);
    return { id: `mock-${Date.now()}` };
  },
  process: () => {},
  on: () => {},
} as any);

export const aiTaskQueue = isRedisDisabled 
  ? createQueueMock('ai-tasks') 
  : new Queue('ai-tasks', { connection: redisConnection });

export const onboardingQueue = isRedisDisabled
  ? createQueueMock('onboarding-tasks')
  : new Queue('onboarding-tasks', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
      }
    });

export const neuralBrowserQueue = isRedisDisabled
  ? createQueueMock('neural-browser-tasks')
  : new Queue('neural-browser-tasks', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 2,
        removeOnComplete: true,
      }
    });

export const distributionQueue = isRedisDisabled
  ? createQueueMock('distribution-tasks')
  : new Queue('distribution-tasks', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 10000,
        },
        removeOnComplete: true,
      }
    });

export const dnaLabQueue = isRedisDisabled
  ? createQueueMock('dna-lab-tasks')
  : new Queue('dna-lab-tasks', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
      }
    });

export const startAIWorker = () => {
  if (isRedisDisabled) {
    console.log('[Queue Service] Redis disabled, AI worker will not start.');
    return null;
  }
  const worker = new Worker(
    'ai-tasks',
    async (job: Job) => {
      console.log(`Processing job ${job.id}: ${job.name}`);
      const { goal, userId, context } = job.data;

      console.log('DEBUG: users table is:', users ? 'DEFINED' : 'UNDEFINED');
      if (!users) {
        console.log('DEBUG: schema keys are:', Object.keys(schema));
      }
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (user?.isLocked) {
        throw new Error('Account is locked. Cannot process AI tasks.');
      }

      const isSuspicious = await fraudSentinel.scanForAbuse(userId, { goal, context });
      if (isSuspicious) {
        throw new Error('Suspicious activity detected. Account locked.');
      }

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
      concurrency: parseInt(process.env.WORKER_CONCURRENCY_AI_TASKS || '50', 10),
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
