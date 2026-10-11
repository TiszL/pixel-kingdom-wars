/** Drops + recreates the dedicated test db, applies all migrations, then seeds
 * the finite play pool and activates the retired quest-bucket fence. Its freshly
 * migrated state also seeds the fresh-database fixtures' template
 * (test/migratedTemplate.ts); this run's templates are dropped before and after. */
import postgres from 'postgres';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapEconomyAllocations } from '../src/ledger';
import { ADMIN_DATABASE_URL, TEST_DATABASE_URL, testDbName } from './db-url';
import { dropMigratedTemplates, prepareMigratedTemplate } from './migratedTemplate';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const name = testDbName();
  // A template left by an earlier run may predate this build or this cluster's roles.
  await dropMigratedTemplates();
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const migrated = createDb(TEST_DATABASE_URL, { max: 1 });
  try {
    await runMigrations(migrated.db);
  } finally {
    await migrated.sql.end();
  }
  // Exactly a fresh replay at this point (nothing seeded yet): copy it as the template
  // instead of replaying the chain a second time.
  await prepareMigratedTemplate(name);

  const { db, sql } = createDb(TEST_DATABASE_URL, { max: 1 });
  try {
    // Seed the single 500M emission pool; fresh DB retirement is a zero-value no-op.
    await bootstrapEconomyAllocations(db);
  } finally {
    await sql.end();
  }
  // Templates hold GRANTs to runtime groups that existed when they were migrated.
  return dropMigratedTemplates;
}
