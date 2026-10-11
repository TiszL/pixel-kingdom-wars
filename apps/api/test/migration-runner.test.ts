import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { assertMigrationsCurrent, runMigrations } from '../src/db/migrate';
import { ADMIN_DATABASE_URL } from './db-url';

async function fixture(work: (f: {
  connection: ReturnType<typeof createDb>; folder: string;
  migrations: (...statements: string[]) => void;
}) => Promise<void>) {
  const name = `migration_runner_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
  const folder = mkdtempSync(join(tmpdir(), 'shardkeep-migrations-'));
  mkdirSync(join(folder, 'meta'));
  let connection: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    connection = createDb(url.toString(), { max: 3 });
    await work({ connection, folder, migrations: (...statements) => {
      const entries = statements.map((statement, idx) => {
        const tag = `000${idx}_fixture`;
        writeFileSync(join(folder, `${tag}.sql`), statement);
        return { idx, version: '7', when: idx + 1, tag, breakpoints: true };
      });
      writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }));
    } });
  } finally {
    await connection?.sql.end();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
    finally { await admin.end(); rmSync(folder, { recursive: true, force: true }); }
  }
}

describe('serialized per-migration commits', () => {
  it('commits enum labels before use and serializes two runners before data can apply twice', async () => fixture(async ({ connection, folder, migrations }) => {
    migrations(
      "CREATE TYPE test_currency AS ENUM ('KEEP'); CREATE TABLE effect (value int NOT NULL); INSERT INTO effect VALUES (0);",
      "ALTER TYPE test_currency ADD VALUE IF NOT EXISTS 'GEMS';",
      "CREATE TABLE balance (currency test_currency NOT NULL DEFAULT 'GEMS'); UPDATE effect SET value = value + 1;",
    );
    await Promise.all([runMigrations(connection.db, { migrationsFolder: folder }), runMigrations(connection.db, { migrationsFolder: folder })]);
    expect(await connection.sql`SELECT value FROM effect`).toEqual([{ value: 1 }]);
    expect(await connection.sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`).toEqual([{ count: 3 }]);
    await connection.sql`INSERT INTO balance DEFAULT VALUES`;
    expect(await connection.sql`SELECT currency FROM balance`).toEqual([{ currency: 'GEMS' }]);
  }));

  it('rolls back a failed dependent migration and resumes without duplicating committed data', async () => fixture(async ({ connection, folder, migrations }) => {
    migrations(
      'CREATE TABLE effect (value int NOT NULL); INSERT INTO effect VALUES (0);',
      'UPDATE effect SET value = value + 1; SELECT * FROM operator_prerequisite;',
    );
    await expect(runMigrations(connection.db, { migrationsFolder: folder })).rejects.toThrow();
    expect(await connection.sql`SELECT value FROM effect`).toEqual([{ value: 0 }]);
    expect(await connection.sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`).toEqual([{ count: 1 }]);
    await connection.sql`CREATE TABLE operator_prerequisite (id int)`;
    await runMigrations(connection.db, { migrationsFolder: folder });
    expect(await connection.sql`SELECT value FROM effect`).toEqual([{ value: 1 }]);
  }));

  it('refuses rewritten applied SQL, journal gaps and duplicate timestamps before new effects', async () => fixture(async ({ connection, folder, migrations }) => {
    migrations('CREATE TABLE effect (value int NOT NULL); INSERT INTO effect VALUES (0);', 'UPDATE effect SET value = value + 1;');
    await runMigrations(connection.db, { migrationsFolder: folder });
    const file = join(folder, '0000_fixture.sql');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, `${original}\n-- rewritten applied SQL`);
    await expect(runMigrations(connection.db, { migrationsFolder: folder })).rejects.toThrow('history mismatch');
    writeFileSync(file, original);
    await connection.sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1`;
    await expect(runMigrations(connection.db, { migrationsFolder: folder })).rejects.toThrow('history mismatch');
    const journalFile = join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
    journal.entries[1].when = journal.entries[0].when;
    writeFileSync(journalFile, JSON.stringify(journal));
    await expect(runMigrations(connection.db, { migrationsFolder: folder })).rejects.toThrow('strictly increasing');
    expect(await connection.sql`SELECT value FROM effect`).toEqual([{ value: 1 }]);
  }));

  it('normal boot assertion refuses an old DB without applying any SQL', async () => fixture(async ({ connection, folder, migrations }) => {
    migrations('CREATE TABLE effect (value int NOT NULL);');
    await runMigrations(connection.db, { migrationsFolder: folder });
    await expect(assertMigrationsCurrent(connection.db)).rejects.toThrow('DATABASE IS BEHIND');
    expect(await connection.sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`).toEqual([{ count: 1 }]);
    expect(await connection.sql`SELECT to_regclass('public.accounts') AS table_name`).toEqual([{ table_name: null }]);
  }));
});
