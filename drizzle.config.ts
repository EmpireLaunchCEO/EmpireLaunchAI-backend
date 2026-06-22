import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/sqlite-schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'bizrunner.db',
  },
});
