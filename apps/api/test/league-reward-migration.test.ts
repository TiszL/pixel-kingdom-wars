import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
// 21 + 32 + 5 = 58 characters: under PostgreSQL's 63-character identifier limit, which the old
// 27-character prefix exceeded by one (the server silently truncated the name) and which
// createMigratedDatabase enforces.
const DB_PREFIX = 'shardkeep_league_mig_';

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

function assertDisposable(name: string): void {
  if (!new RegExp(`^${DB_PREFIX}[0-9a-f]{32}_test$`).test(name)) {
    throw new Error(`refusing to manage unexpected database name: ${name}`);
  }
}

describe('league SHARDS/items-only migration', () => {
  it('refuses to strand a legacy positive KEEP entitlement', async () => {
    const databaseName = `${DB_PREFIX}${randomUUID().replaceAll('-', '')}_test`;
    assertDisposable(databaseName);
    const migrationDir = await mkdtemp(path.join(tmpdir(), 'shardkeep-league-migration-'));
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    const databaseUrl = new URL(ADMIN_DATABASE_URL);
    databaseUrl.pathname = `/${databaseName}`;
    let conn: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      await cp(MIGRATIONS, migrationDir, { recursive: true });
      const journalPath = path.join(migrationDir, 'meta/_journal.json');
      const fullJournal = await readFile(journalPath, 'utf8');
      const through0094 = JSON.parse(fullJournal) as Journal;
      through0094.entries = through0094.entries.filter(({ idx }) => idx <= 94);
      expect(through0094.entries.at(-1)?.tag).toBe('0094_tutorial_guide_skip');
      await writeFile(journalPath, `${JSON.stringify(through0094, null, 2)}\n`);
      conn = createDb(databaseUrl.toString(), { max: 2 });
      await migrate(conn.db, { migrationsFolder: migrationDir });

      const wallet = `league-migration-${randomUUID()}`;
      await conn.sql`INSERT INTO players (wallet) VALUES (${wallet})`;
      const [base] = await conn.sql<{ id: string }[]>`
        INSERT INTO bases (owner_wallet) VALUES (${wallet}) RETURNING id
      `;
      await conn.sql`
        INSERT INTO base_league_entitlements
          (week, base_id, tier, trophies, keep_amount)
        VALUES ('2026-08-24', ${base!.id}, 'bronze', 1, 1)
      `;

      await writeFile(journalPath, fullJournal);
      await expect(migrate(conn.db, { migrationsFolder: migrationDir }))
        .rejects.toThrow(/require an explicit operator audit/);
    } finally {
      await conn?.sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
      await rm(migrationDir, { recursive: true, force: true });
    }
  });

  it('installs the final receipt constraints, immutable triggers, and participation index', async () => {
    const databaseName = `${DB_PREFIX}${randomUUID().replaceAll('-', '')}_test`;
    assertDisposable(databaseName);
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    const databaseUrl = new URL(ADMIN_DATABASE_URL);
    databaseUrl.pathname = `/${databaseName}`;
    let conn: ReturnType<typeof createDb> | undefined;
    try {
      // The full chain's final state, not the replay itself: a clone of the template this
      // build's chain produced (test/migratedTemplate.ts); migrate() re-verifies its journal.
      await createMigratedDatabase(admin, databaseName);
      conn = createDb(databaseUrl.toString(), { max: 2 });
      await migrate(conn.db, { migrationsFolder: MIGRATIONS });
      const [facts] = await conn.sql<{
        receiptConstraints: number;
        immutableTriggers: number;
        boundaryTriggers: number;
        participationIndexes: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM pg_constraint
           WHERE conname IN (
             'base_league_entitlements_keep_zero_ck',
             'league_week_closures_failure_reason_ck'
           )) AS "receiptConstraints",
          (SELECT count(*)::int FROM pg_trigger
           WHERE tgname IN (
             'base_league_entitlements_immutable_reward_trg',
             'base_league_entitlements_no_delete_trg',
             'league_reward_activations_immutable_trg',
             'league_week_closures_immutable_trg',
             'league_week_base_snapshots_immutable_trg',
             'league_week_base_exclusions_immutable_trg',
             'league_item_grants_immutable_trg'
           )) AS "immutableTriggers",
          (SELECT count(*)::int FROM pg_trigger
           WHERE tgname IN (
             'base_profiles_league_boundary_trg',
             'bases_league_boundary_trg'
           )) AS "boundaryTriggers",
          (SELECT count(*)::int FROM pg_indexes
           WHERE indexname = 'raids_attacker_base_resolved_idx') AS "participationIndexes"
      `;
      expect(facts).toEqual({
        receiptConstraints: 2,
        immutableTriggers: 7,
        boundaryTriggers: 2,
        participationIndexes: 1,
      });
    } finally {
      await conn?.sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  });
});
