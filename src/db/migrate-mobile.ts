import { createClient } from '@libsql/client';
import dotenv from 'dotenv';

dotenv.config();

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

async function main() {
  console.log('Running mobile infrastructure migrations...');
  
  try {
    await client.execute(`ALTER TABLE users ADD COLUMN is_review_mode INTEGER DEFAULT 0 NOT NULL`);
    console.log('Added is_review_mode to users');
  } catch (e: any) {
    console.log('is_review_mode might already exist:', e.message);
  }

  try {
    await client.execute(`ALTER TABLE users ADD COLUMN mobile_session_token TEXT`);
    console.log('Added mobile_session_token to users');
  } catch (e: any) {
    console.log('mobile_session_token might already exist:', e.message);
  }

  try {
    await client.execute(`ALTER TABLE users ADD COLUMN mobile_session_expires_at INTEGER`);
    console.log('Added mobile_session_expires_at to users');
  } catch (e: any) {
    console.log('mobile_session_expires_at might already exist:', e.message);
  }

  console.log('Mobile migrations complete.');
}

main();
