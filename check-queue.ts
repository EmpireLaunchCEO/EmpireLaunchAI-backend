import { Queue } from 'bullmq';
import { redisConnection } from './src/config/redis.js';

async function checkQueue() {
  const queue = new Queue('ai-tasks', { connection: redisConnection });
  const count = await queue.count();
  const waiting = await queue.getWaitingCount();
  const active = await queue.getActiveCount();
  const completed = await queue.getCompletedCount();
  const failed = await queue.getFailedCount();

  console.log(`Queue: ai-tasks`);
  console.log(`Total: ${count}`);
  console.log(`Waiting: ${waiting}`);
  console.log(`Active: ${active}`);
  console.log(`Completed: ${completed}`);
  console.log(`Failed: ${failed}`);

  const jobs = await queue.getJobs(['waiting', 'active', 'failed']);
  for (const job of jobs) {
    console.log(`Job ${job.id}: ${job.name} (Status: ${await job.getState()})`);
    if (job.failedReason) {
      console.log(`  Failed Reason: ${job.failedReason}`);
    }
  }

  process.exit(0);
}

checkQueue();
