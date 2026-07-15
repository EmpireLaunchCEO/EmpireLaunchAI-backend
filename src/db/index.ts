import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { Pool } from 'pg';
import * as pgSchema from './schema.js';
import * as sqliteSchema from './sqlite-schema.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

console.log('DATABASE_URL is:', process.env.DATABASE_URL ? (process.env.DATABASE_URL.substring(0, 15) + '...') : 'UNDEFINED');
const isSqlite = process.env.DATABASE_URL?.startsWith('file:') || process.env.DATABASE_URL?.startsWith('libsql:');

function createDb() {
  if (isSqlite) {
    console.log('Using LibSQL/SQLite database');
    const client = createClient({
      url: process.env.DATABASE_URL!,
      authToken: process.env.DATABASE_AUTH_TOKEN,
      syncUrl: process.env.DATABASE_SYNC_URL,
    });
    return drizzleLibsql(client, { schema: sqliteSchema });
  } else {
    console.log('Using PostgreSQL database');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Run pending migrations on startup (non-blocking)
    runMigrations(pool).catch(err => console.error('Migration error:', err));

    return drizzlePg(pool, { schema: pgSchema });
  }
}

async function runMigrations(pool: Pool) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return;

    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    if (files.length === 0) return;

    // Create migrations tracking table if needed
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        run_at TIMESTAMP DEFAULT NOW()
      )
    `);

    for (const file of files) {
      const { rows } = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (rows.length > 0) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      console.log(`Migration ${file} applied successfully`);
    }
  } catch (err) {
    console.error('Migration runner error:', err);
  }
}

export const schema: any = isSqlite ? sqliteSchema : pgSchema;
export const db: any = createDb();
