/** Fantasy assignments and cutover change global presentation. Each suite owns
 * a disposable database rather than resetting identity or legacy-test state. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapEconomyAllocations } from '../src/ledger';
import { ADMIN_DATABASE_URL, TEST_DATABASE_URL } from './db-url';

export function isolatedFantasyTestDb() {
  const name = `fantasy_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
  const conn = createDb(url.toString(), { max: 20 });
  return {
    ...conn,
    async prepare() {
      const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
      try { await admin.unsafe(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
      await runMigrations(conn.db);
      await bootstrapEconomyAllocations(conn.db);
    },
    async dispose() {
      await conn.sql.end();
      const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
      try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
    },
  };
}
