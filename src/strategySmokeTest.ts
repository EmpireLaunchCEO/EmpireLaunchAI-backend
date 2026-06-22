import dotenv from 'dotenv';
import { db, schema } from './db/index.js';
import { strategyOracle } from './services/strategyOracleService.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

async function runStrategySmokeTest() {
  console.log("Starting Strategy Queue Smoke Test...");

  const testUserId = "test-user-strategy-" + Date.now();

  try {
    // 1. Mock a user in the DB
    console.log("Creating test user...");
    await db.insert(schema.users).values({
      id: testUserId,
      email: `test-${Date.now()}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // 2. Mock historical performance data that triggers an AD_BOOST suggestion
    // latest.revenue > 30000 && latest.adSpend < 5000
    console.log("Inserting mock performance data...");
    await db.insert(schema.historicalPerformance).values({
      id: uuidv4(),
      userId: testUserId,
      date: new Date(),
      revenue: 35000,
      adSpend: 1000,
      engagement: 2000,
      sentimentScore: 80,
      conversionRate: 2.5,
      createdAt: new Date()
    });

    // 3. Trigger generation
    console.log("Triggering strategy generation...");
    const suggestions = await strategyOracle.generateSuggestions(testUserId);
    
    console.log(`Generated ${suggestions.length} suggestions.`);
    suggestions.forEach(s => console.log(` - [${s.type}] ${s.title}`));

    if (suggestions.length > 0) {
      console.log("Strategy Smoke Test Passed!");
    } else {
      console.error("Strategy Smoke Test Failed: No suggestions generated.");
    }

  } catch (error) {
    console.error("Strategy Smoke Test Failed:", error);
  }
}

runStrategySmokeTest();
