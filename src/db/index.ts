import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { Pool } from 'pg';
import * as pgSchema from './schema.js';
import * as sqliteSchema from './sqlite-schema.js';
import dotenv from 'dotenv';

dotenv.config();

console.log('DATABASE_URL is:', process.env.DATABASE_URL ? (process.env.DATABASE_URL.substring(0, 15) + '...') : 'UNDEFINED');
const isSqlite = process.env.DATABASE_URL?.startsWith('file:') || process.env.DATABASE_URL?.startsWith('libsql:');

function createDb() {
  if (isSqlite) {
    console.log('Using LibSQL/SQLite database');
    // For Turso scaling: use SYNC_URL for embedded replicas or edge points
    const client = createClient({
      url: process.env.DATABASE_URL!,
      authToken: process.env.DATABASE_AUTH_TOKEN,
      // @ts-ignore - Some versions might use different property names
      syncUrl: process.env.DATABASE_SYNC_URL,
    });
    return drizzleLibsql(client, { schema: sqliteSchema });
  } else {
    console.log('Using PostgreSQL database');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // For high scale: increase pool size
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    return drizzlePg(pool, { schema: pgSchema });
  }
}

export const schema: any = isSqlite ? sqliteSchema : pgSchema;
export const db: any = createDb();
