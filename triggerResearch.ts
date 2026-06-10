import { marketResearcher } from './src/services/autonomousMarketResearcher.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log('Triggering market research for Zen Digital Planner...');
  try {
    const result = await marketResearcher.researchNiche('user_1', 'Zen Digital Planner');
    console.log('Research complete:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Research failed:', err);
  }
}

run();
