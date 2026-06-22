import { analyticsAggregator } from '../services/analyticsAggregatorService.js';
import { strategyOracle } from '../services/strategyOracleService.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

async function demo() {
  const userId = '00000000-0000-0000-0000-000000000000';

  console.log('--- Empire Intelligence Analytics Demo ---');

  // 1. Aggregate metrics for today
  console.log('Aggregating daily metrics...');
  const metrics = await analyticsAggregator.aggregateDailyMetrics(userId);
  console.log('Daily Metrics:', JSON.stringify(metrics, null, 2));

  // 2. Aggregate metrics for a few past days to build history
  console.log('Building historical data...');
  for (let i = 1; i <= 3; i++) {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - i);
    await analyticsAggregator.aggregateDailyMetrics(userId, pastDate);
  }

  // 3. Run Strategy Oracle
  console.log('Running Strategy Oracle...');
  const suggestions = await strategyOracle.generateSuggestions(userId);
  console.log('Oracle Suggestions:', JSON.stringify(suggestions, null, 2));

  // 4. Verify data in DB
  const history = await db.select().from(schema.historicalPerformance).where(eq(schema.historicalPerformance.userId, userId));
  console.log(`Verified History: ${history.length} entries in DB`);

  const savedSuggestions = await db.select().from(schema.strategySuggestions).where(eq(schema.strategySuggestions.userId, userId));
  console.log(`Verified Suggestions: ${savedSuggestions.length} entries in DB`);

  console.log('--- Demo Completed Successfully ---');
  process.exit(0);
}

demo().catch(console.error);
