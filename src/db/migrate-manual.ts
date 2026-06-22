import { createClient } from '@libsql/client';
import dotenv from 'dotenv';

dotenv.config();

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const tablesWithCreationDraftId = [
  'goals',
  'app_tasks',
  'approvals',
  'subscription_logs',
  'campaigns',
  'scheduled_posts',
  'discovery_results',
  'onboarding_sessions',
  'payment_buttons',
  'task_plans',
  'execution_steps',
  'strategy_suggestions',
  'handle_verifications',
  'production_scripts',
  'infrastructure_costs',
  'email_logs',
  'creation_drafts',
  'dispatch_logs'
];

async function main() {
  console.log('Running manual migrations...');
  
  // Add creation_draft_id to all relevant tables
  for (const table of tablesWithCreationDraftId) {
    try {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN creation_draft_id TEXT`);
      console.log(`Added creation_draft_id to ${table}`);
    } catch (e: any) {
      if (e.message?.includes('duplicate column name') || e.message?.includes('already exists')) {
         console.log(`creation_draft_id already exists in ${table}`);
      } else {
         console.log(`Failed to add creation_draft_id to ${table}: ${e.message}`);
      }
    }
  }

  // Add missing columns to users
  const userColumns = ['password_hash', 'access_key', 'paypal_merchant_id', 'tier'];
  for (const col of userColumns) {
    try {
      await client.execute(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
      console.log(`Added ${col} to users`);
    } catch (e: any) {
       console.log(`${col} might already exist in users: ${e.message}`);
    }
  }

  console.log('Manual migrations complete.');
}

main();
