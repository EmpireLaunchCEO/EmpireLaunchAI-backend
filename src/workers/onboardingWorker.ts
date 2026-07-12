import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { onboardingOrchestrator } from '../services/onboardingOrchestrator.js';

export const onboardingWorker = new Worker(
  'onboarding-tasks',
  async (job: Job) => {
    console.log(`[OnboardingWorker] Processing job ${job.id} (Type: ${job.name})`);
    
    try {
      if (job.name === 'onboarding-task') {
        const { sessionId, userId, platform } = job.data;
        await onboardingOrchestrator.processOnboarding(sessionId, userId, platform);
      } else if (job.name === 'initialize-agent') {
        const { userId, name, niche, angle, automationMode, goalId } = job.data;
        await onboardingOrchestrator.initializeEmpire(userId, name, niche, angle, automationMode, goalId);
      } else {
        throw new Error(`Unknown job type: ${job.name}`);
      }
      console.log(`[OnboardingWorker] Job ${job.id} completed successfully`);
    } catch (error) {
      console.error(`[OnboardingWorker] Job ${job.id} failed:`, error);
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY_ONBOARDING || '100', 10),
  }
);

onboardingWorker.on('completed', (job) => {
  console.log(`[OnboardingWorker] Job ${job.id} completed`);
});

onboardingWorker.on('failed', (job, err) => {
  console.error(`[OnboardingWorker] Job ${job?.id} failed: ${err.message}`);
});
