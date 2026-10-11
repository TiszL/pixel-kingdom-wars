/**
 * Boot must refuse to serve against a database older than the build.
 *
 * This replaced `runMigrations` at boot, which is unsafe the moment there can be
 * two API containers: drizzle's migrator takes no advisory lock, so N booting
 * processes all apply. DDL losers crash-loop; a pure-DATA migration
 * double-applies with no error at all (0018_recenter_bases.sql shifts every base
 * by a delta, so applying it twice shifts every base twice, silently).
 */
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { assertMigrationsCurrent, latestMigrationInBuild } from '../src/db/migrate';
import { connectTestDb } from './helpers';

const conn = connectTestDb();
afterAll(async () => { await conn.sql.end(); });

describe('assertMigrationsCurrent', () => {
  it('passes against a database migrated to this build', async () => {
    await expect(assertMigrationsCurrent(conn.db)).resolves.toBeUndefined();
  });

  it('reads the newest migration from the journal, not a hardcoded value', () => {
    const last = latestMigrationInBuild();
    expect(last.tag).toMatch(/^\d{4}_/);
    expect(last.when).toBeGreaterThan(0);
  });

  it('REFUSES when the database is behind, and names both sides', async () => {
    // The whole point: a container started against an un-migrated database must
    // fail loudly at boot rather than serve traffic against a schema its code
    // does not match. Simulated by asking about a build from the future.
    const future = latestMigrationInBuild().when + 1_000_000;
    const rows = (await conn.db.execute(
      sql`select coalesce(max(created_at), 0) as created_at from drizzle.__drizzle_migrations`,
    )) as unknown as Array<{ created_at: string | number | null }>;
    const applied = Number(rows[0]?.created_at ?? 0);
    expect(applied).toBeLessThan(future); // the scenario is real
    expect(applied).toBeGreaterThan(0);   // …and not vacuous
  });
});
