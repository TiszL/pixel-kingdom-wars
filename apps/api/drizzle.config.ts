import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Only needed by `drizzle-kit migrate`; `generate` works offline.
    url: process.env.DATABASE_URL ?? 'postgres://shardkeep:shardkeep@localhost:5433/shardkeep',
  },
});
