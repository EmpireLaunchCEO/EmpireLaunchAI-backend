import dotenv from 'dotenv';
import { massDnaHarvester } from './src/services/massDnaHarvestWorker.js';

dotenv.config();

async function main() {
  console.log('--- MANUAL DNA HARVEST TRIGGER ---');
  const stats = massDnaHarvester.getStats();
  if (stats.isRunning) {
    console.log('Harvester is already running.');
    console.log(`Current Strands: ${stats.totalStrandsStored}`);
    return;
  }

  console.log('Starting harvester...');
  try {
    const result = await massDnaHarvester.start();
    console.log('Harvester finished manually.');
    console.log(`Total Strands: ${result.totalStrandsStored}`);
  } catch (err: any) {
    console.error('Harvester failed:', err.message);
  }
}

main();
