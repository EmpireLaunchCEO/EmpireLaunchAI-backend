import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
dotenv.config();

async function check() {
  const client = createClient({
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  });
  
  const res = await client.execute("PRAGMA table_info(onboarding_sessions)");
  console.log(JSON.stringify(res.rows, null, 2));
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
