const { Client } = require('pg');
async function main() {
  const conn = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const client = new Client({ connectionString: conn });
  await client.connect();
  
  // Check integrations columns
  const cols = await client.query(`
    SELECT column_name, data_type, is_nullable 
    FROM information_schema.columns 
    WHERE table_name = 'integrations'
    ORDER BY ordinal_position
  `);
  console.log('=== integrations table columns ===');
  cols.rows.forEach(c => console.log(`  ${c.column_name} (${c.data_type}) nullable=${c.is_nullable}`));
  
  // Check goals columns  
  const goalCols = await client.query(`
    SELECT column_name, data_type, is_nullable 
    FROM information_schema.columns 
    WHERE table_name = 'goals'
    ORDER BY ordinal_position
  `);
  console.log('=== goals table columns ===');
  goalCols.rows.forEach(c => console.log(`  ${c.column_name} (${c.data_type}) nullable=${c.is_nullable}`));
  
  await client.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });