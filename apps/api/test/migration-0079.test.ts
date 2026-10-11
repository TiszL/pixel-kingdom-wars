/**
 * Migration 0079 runs after the one-way deed-economy fence is already `ready` in
 * production. This test replays that exact boundary in its own disposable DB:
 * first migrate only through 0078, activate the fence, then let an UNMARKED
 * connection apply 0079. The migration's SET LOCAL marker must authorize only
 * its audited plot cleanup, and deed evidence must keep a parcel occupied.
 */
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

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const DB_PREFIX = 'shardkeep_migration_0079_';

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

function assertDisposableDbName(name: string): void {
  if (!new RegExp(`^${DB_PREFIX}[0-9a-f]{32}_test$`).test(name)) {
    throw new Error(`refusing to manage unexpected database name: ${name}`);
  }
}

describe('migration 0079 on the live deed-economy boundary', () => {
  it('applies after ready and deletes only identifier-free unpaid plot ghosts', async () => {
    const databaseName = `${DB_PREFIX}${randomUUID().replaceAll('-', '')}_test`;
    assertDisposableDbName(databaseName);
    const migrationDir = await mkdtemp(path.join(tmpdir(), 'shardkeep-0079-'));
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    const databaseUrl = new URL(ADMIN_DATABASE_URL);
    databaseUrl.pathname = `/${databaseName}`;
    let marked: ReturnType<typeof createDb> | undefined;
    let unmarked: ReturnType<typeof createDb> | undefined;

    try {
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      await cp(MIGRATIONS, migrationDir, { recursive: true });

      const journalPath = path.join(migrationDir, 'meta/_journal.json');
      const fullJournalText = await readFile(journalPath, 'utf8');
      const through0078 = JSON.parse(fullJournalText) as Journal;
      // Newer candidate migrations may follow 0079. Reconstruct the exact live
      // pre-avatar boundary by journal index, not by removing one historical tag.
      through0078.entries = through0078.entries.filter(({ idx }) => idx <= 78);
      expect(through0078.entries.at(-1)?.tag).toBe('0078_league_entitlement_snapshot');
      await writeFile(journalPath, `${JSON.stringify(through0078, null, 2)}\n`);

      marked = createDb(databaseUrl.toString(), { max: 1 });
      await migrate(marked.db, { migrationsFolder: migrationDir });
      await marked.sql`
        INSERT INTO players (wallet) VALUES
          ('ghost-wallet'), ('asset-wallet'), ('mint-wallet'), ('paid-wallet')
      `;
      const [valley] = await marked.sql`
        INSERT INTO valleys (name, site_id, planet_id)
        VALUES ('Migration 0079', 119, 0)
        RETURNING id
      `;
      await marked.sql`
        INSERT INTO bases (id, owner_wallet, deed_asset_id, deed_mint_asset_id, status, land_paid_at)
        VALUES
          ('00000000-0000-0000-0000-000000000791', 'ghost-wallet', NULL, NULL, 'active', NULL),
          ('00000000-0000-0000-0000-000000000792', 'asset-wallet', 'deed-asset-792', NULL, 'inactive', NULL),
          ('00000000-0000-0000-0000-000000000793', 'mint-wallet', NULL, 'deed-mint-793', 'active', NULL),
          ('00000000-0000-0000-0000-000000000794', 'paid-wallet', NULL, NULL, 'inactive', '2026-08-13T00:00:00Z')
      `;
      await marked.sql`
        INSERT INTO plots (base_id, valley_id, x, y, player_wallet, earth_cell, country_a3)
        VALUES
          ('00000000-0000-0000-0000-000000000791', ${valley!.id}, 0, 0, 'ghost-wallet', 7901, 'GEO'),
          ('00000000-0000-0000-0000-000000000792', ${valley!.id}, 1, 0, 'asset-wallet', 7902, 'GEO'),
          ('00000000-0000-0000-0000-000000000793', ${valley!.id}, 2, 0, 'mint-wallet', 7903, 'GEO'),
          ('00000000-0000-0000-0000-000000000794', ${valley!.id}, 3, 0, 'paid-wallet', 7904, 'GEO')
      `;
      await marked.sql`
        UPDATE deed_economy_cutover_state
        SET phase = 'ready', ready_at = now()
        WHERE id = true
      `;
      await marked.sql.end();
      marked = undefined;

      // Restore the candidate journal, then migrate without the startup writer
      // GUC. If 0079 loses its transaction-local marker, the ready-state plots
      // trigger rejects its DELETE and this call fails.
      await writeFile(journalPath, fullJournalText);
      unmarked = createDb(databaseUrl.toString(), { max: 1, deedEconomyWriter: false });
      await migrate(unmarked.db, { migrationsFolder: migrationDir });

      const rows = await unmarked.sql<{ base_id: string }[]>`
        SELECT base_id::text
        FROM plots
        ORDER BY base_id
      `;
      expect(rows.map(({ base_id }) => base_id)).toEqual([
        '00000000-0000-0000-0000-000000000792',
        '00000000-0000-0000-0000-000000000793',
        '00000000-0000-0000-0000-000000000794',
      ]);
      const [state] = await unmarked.sql<{ phase: string }[]>`
        SELECT phase FROM deed_economy_cutover_state WHERE id = true
      `;
      expect(state?.phase).toBe('ready');
      const [avatarColumns] = await unmarked.sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'players'
          AND column_name IN ('avatar_hash', 'avatar_generation', 'avatar_updated_at')
      `;
      expect(avatarColumns?.count).toBe(3);
      const [retirementClock] = await unmarked.sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'outbox'
          AND column_name = 'next_attempt_at'
      `;
      expect(retirementClock?.count).toBe(1);
      const [retirementIndex] = await unmarked.sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'outbox'
          AND indexname = 'outbox_avatar_due_idx'
      `;
      expect(retirementIndex?.count).toBe(1);
    } finally {
      await unmarked?.sql.end();
      await marked?.sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
      await rm(migrationDir, { recursive: true, force: true });
    }
  }, 120_000);
});
