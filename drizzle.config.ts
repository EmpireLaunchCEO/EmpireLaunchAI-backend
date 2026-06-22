import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

dotenv.config();

const isSqlite = process.env.DATABASE_URL?.startsWith('file:') || process.env.DATABASE_URL?.startsWith('libsql:');

export default defineConfig({
  schema: isSqlite ? './src/db/sqlite-schema.ts' : './src/db/schema.ts',
  out: './drizzle',
  dialect: isSqlite ? 'sqlite' : 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
