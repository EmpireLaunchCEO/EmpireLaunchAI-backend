import { agentWorker } from './agentWorker.js';
import { schedulerWorker } from './schedulerWorker.js';
import { onboardingWorker } from './onboardingWorker.js';
import { startNeuralBrowserWorker } from './neuralBrowserWorker.js';
import { startDistributionWorker } from './distributionWorker.js';
import { startDnaLabWorker } from './dnaLabWorker.js';
import { startAIWorker } from '../services/queueService.js';
import dotenv from 'dotenv';

dotenv.config();

console.log('[WorkerEntry] Starting standalone worker process...');
console.log('[WorkerEntry] Concurrency settings:');
console.log(`  ONBOARDING:        ${process.env.WORKER_CONCURRENCY_ONBOARDING || '100'}`);
console.log(`  NEURAL_BROWSER:    ${process.env.WORKER_CONCURRENCY_NEURAL_BROWSER || '20'}`);
console.log(`  DISTRIBUTION:      ${process.env.WORKER_CONCURRENCY_DISTRIBUTION || '50'}`);
console.log(`  DNA_LAB:           ${process.env.WORKER_CONCURRENCY_DNA_LAB || '10'}`);
console.log(`  AI_TASKS:          ${process.env.WORKER_CONCURRENCY_AI_TASKS || '50'}`);

// Start all workers (same as index.ts lines 87-92)
agentWorker.start();
schedulerWorker.start();
startAIWorker();
startNeuralBrowserWorker();
startDistributionWorker();
startDnaLabWorker();

console.log('[WorkerEntry] All workers active. Running in standalone mode (no HTTP server).');

// Keep process alive
setInterval(() => {
  console.log('[WorkerEntry] Heartbeat — all workers running');
}, 60000);