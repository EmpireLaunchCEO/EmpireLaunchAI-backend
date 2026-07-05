const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('No DATABASE_URL found');
    process.exit(1);
  }
  
  const client = new Client({ connectionString });
  await client.connect();
  
  try {
    // Check if goal_id column exists in integrations
    const checkResult = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'integrations' AND column_name = 'goal_id'
    `);
    
    if (checkResult.rows.length === 0) {
      console.log('goal_id column NOT found in integrations table — adding it now...');
      await client.query(`
        ALTER TABLE integrations ADD COLUMN goal_id UUID REFERENCES goals(id)
      `);
      console.log('✓ Added goal_id column to integrations table');
    } else {
      console.log('✓ goal_id column already exists in integrations table');
    }
    
    // Also check archetype and approval_required on goals table
    const goalCols = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'goals' AND column_name IN ('archetype', 'approval_required')
    `);
    const existingGoalCols = goalCols.rows.map(r => r.column_name);
    
    if (!existingGoalCols.includes('archetype')) {
      await client.query(`ALTER TABLE goals ADD COLUMN archetype text DEFAULT 'CREATOR' NOT NULL`);
      console.log('✓ Added archetype column to goals table');
    }
    if (!existingGoalCols.includes('approval_required')) {
      await client.query(`ALTER TABLE goals ADD COLUMN approval_required boolean DEFAULT true NOT NULL`);
      console.log('✓ Added approval_required column to goals table');
    }
    
    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    await client.end();
  }
}

main();
