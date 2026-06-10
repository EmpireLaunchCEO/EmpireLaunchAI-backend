import { massDnaHarvester } from '../src/services/massDnaHarvestWorker.js';

console.log('[HarvestLauncher] Starting Mass DNA Harvest...');
console.log(`[HarvestLauncher] PID: ${process.pid}`);

massDnaHarvester.start().then(stats => {
  console.log('[HarvestLauncher] Mass DNA Harvest completed:', JSON.stringify(stats, null, 2));
  process.exit(0);
}).catch(err => {
  console.error('[HarvestLauncher] Mass DNA Harvest failed:', err.message);
  process.exit(1);
});

// Keep alive — log progress every 30 seconds
setInterval(() => {
  const stats = massDnaHarvester.getStats();
  console.log(`[HarvestLauncher] Progress: ${stats.totalStrandsStored} strands, ${stats.nichesProcessed}/${stats.nichesTotal} niches, running: ${stats.isRunning}`);
}, 30000);