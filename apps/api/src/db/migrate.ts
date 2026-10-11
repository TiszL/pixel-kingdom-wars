import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Db } from './client';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Commit each migration before the next one uses any new enum labels. The
 * journal and SQL share a transaction; competing runners recheck the committed
 * prefix under the same advisory lock before applying anything.
 */
export async function runMigrations(
  db: Db,
  { migrationsFolder = MIGRATIONS_FOLDER }: { migrationsFolder?: string } = {},
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  for (const [index, migration] of migrations.entries()) {
    if (!Number.isSafeInteger(migration.folderMillis)
      || (index > 0 && migration.folderMillis <= migrations[index - 1]!.folderMillis)) {
      throw new Error('migration journal timestamps must be unique and strictly increasing');
    }
  }
  if (migrations.length === 0) throw new Error('migration journal is empty');

  // Creating the journal is itself serialized, including on a brand-new DB.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('shardkeep.schema-migrations', 0))`);
    await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`);
  });

  for (const [index, migration] of migrations.entries()) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('shardkeep.schema-migrations', 0))`);
      const applied = await tx.execute<{ hash: string; created_at: string | number | null }>(
        sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id`,
      );
      // Refuse gaps, duplicates and rewritten applied SQL. In particular, a DB
      // with the experimental old 0134 must not silently accept its new history.
      for (const [position, row] of applied.entries()) {
        const expected = migrations[position];
        if (!expected || Number(row.created_at) !== expected.folderMillis || row.hash !== expected.hash) {
          throw new Error(`applied migration history mismatch at position ${position}; operator review required`);
        }
      }
      if (applied.length > index) return;
      if (applied.length !== index) throw new Error('migration predecessor is missing');
      for (const statement of migration.sql) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
      await tx.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})`);
    });
  }
}

/** The newest migration THIS BUILD carries, read from drizzle's own journal. */
export function latestMigrationInBuild(): { tag: string; when: number } {
  const journal = JSON.parse(
    readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8'),
  ) as { entries: Array<{ tag: string; when: number }> };
  const last = journal.entries[journal.entries.length - 1];
  if (!last) throw new Error('drizzle journal is empty — this build carries no migrations');
  return last;
}

/**
 * Refuse to serve against a database older than this build expects.
 *
 * Applying migrations at BOOT is wrong the moment there can be more than one API
 * container. drizzle's postgres-js migrator takes NO advisory lock: it reads the
 * last applied migration outside any transaction, then opens one and applies
 * everything newer. N containers booting together all read the same value and
 * all enter the apply loop. For DDL the losers fail on "column already exists"
 * and, under `restart: unless-stopped`, crash-loop. Worse, a PURE DATA migration
 * double-applies with NO error at all: 0018_recenter_bases.sql is three UPDATEs
 * shaped `SET tx = tx + (6 - expansions)`, and under READ COMMITTED the loser
 * re-evaluates against the winner's committed rows and shifts every base a
 * second time. Nothing anywhere reports it.
 *
 * So migration is a deploy STEP — infra/deploy.sh already runs it as its own
 * single-shot `run --rm` before starting any container — and boot only ASSERTS.
 * That preserves what the boot call was actually protecting (code must never run
 * against a schema it predates) without any serving process writing DDL.
 */
export async function assertMigrationsCurrent(db: Db): Promise<void> {
  const expected = latestMigrationInBuild();
  const rows = (await db.execute(
    sql`select coalesce(max(created_at), 0) as created_at from drizzle.__drizzle_migrations`,
  )) as unknown as Array<{ created_at: string | number | null }>;
  const applied = Number(rows[0]?.created_at ?? 0);

  if (applied >= expected.when) return;

  throw new Error(
    'DATABASE IS BEHIND THIS BUILD.\n'
    + `  build expects: ${expected.tag} (${expected.when})\n`
    + `  database has:  ${applied || 'no migrations at all'}\n`
    + 'Run the migration step before starting the API — infra/deploy.sh does this:\n'
    + "  docker compose --env-file infra/.env.prod -f infra/docker-compose.prod.yml run --rm --entrypoint sh api -c 'cd /app/apps/api && pnpm db:migrate'",
  );
}
