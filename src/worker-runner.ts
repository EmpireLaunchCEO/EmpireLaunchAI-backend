import { schedulerWorker } from './workers/schedulerWorker.js';
import { agentWorker } from './workers/agentWorker.js';
import { startAIWorker } from './services/queueService.js';
import { startNeuralBrowserWorker } from './workers/neuralBrowserWorker.js';
import { startDistributionWorker } from './workers/distributionWorker.js';
import { startDnaLabWorker } from './workers/dnaLabWorker.js';
import dotenv from 'dotenv';

dotenv.config();

console.log('[WorkerRunner] Starting all Phase 6 background workers...');

agentWorker.start();
schedulerWorker.start();
startAIWorker();
startNeuralBrowserWorker();
startDistributionWorker();
startDnaLabWorker();

console.log('[WorkerRunner] All workers active and ticking.');
