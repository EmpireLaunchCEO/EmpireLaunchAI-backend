import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
dotenv.config();

async function check() {
  const client = createClient({
    url: process.env.DATABASE_URL!,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  });
  
  const res = await client.execute("SELECT * FROM onboarding_sessions ORDER BY createdAt DESC LIMIT 5");
  console.log(JSON.stringify(res.rows, null, 2));
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
