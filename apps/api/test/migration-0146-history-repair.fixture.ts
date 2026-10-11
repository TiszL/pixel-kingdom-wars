/** Isolated canonical-upgrade proof, explicitly selected by vitest.migration0146-history.config.ts.
 * Never imported by a default-discovered test. All DB execution needs Cedar3 admission. */
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';

const MIGRATIONS = fileURLToPath(new URL('../drizzle/', import.meta.url));
const ORIGINAL_TAG = '0146_starter_common_access';
const ORIGINAL_SHA = 'b1aec76ffa99064fba9c360674f5dd2be600b540292ad8a7ce7174fb629d6fcb';
const EDITED_SHA = '19060892465b69208b5da649fec9a6e1379743651aa0c5617e7c9571cd3e2629';
const PAID_MARKER = 'phase-e:starter-expedition-guard:paid-access-v1';
type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: Entry[] };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const migration = (tag: string) => readFileSync(join(MIGRATIONS, `${tag}.sql`));
const originalFixture = () => readFileSync(new URL('./fixtures/migration-0146-original.sql', import.meta.url));

function plan() {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as Journal;
  const originalIndex = journal.entries.findIndex(entry => entry.tag === ORIGINAL_TAG);
  const paidIndex = journal.entries.findIndex(entry => entry.tag === '0185_starter_paid_access');
  expect(originalIndex).toBe(148);
  expect(paidIndex).toBeGreaterThan(originalIndex);
  expect(digest(originalFixture())).toBe(ORIGINAL_SHA);
  // The dedicated proof also checks the actual candidate, independently of the pure suite.
  expect(migration(ORIGINAL_TAG)).toEqual(originalFixture());
  expect(journal.entries[originalIndex]!.when).toBe(1790007000000);
  expect(journal.entries.map(entry => entry.idx)).toEqual(journal.entries.map((_, index) => index));
  for (let index = 1; index < journal.entries.length; index++) {
    expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when);
  }
  return { journal, originalIndex };
}

/** Historical negative specimen only: reconstruct exactly blob714c609e, never a new migration. */
function editedHistoricalSql(): Buffer {
  const declaration = 'CREATE OR REPLACE FUNCTION public.shardkeep_starter_expedition_insert_guard()';
  const revoke = '\nREVOKE ALL ON FUNCTION public.shardkeep_starter_expedition_insert_guard() FROM PUBLIC;';
  const wrapper = [
    '-- Preserve the later paid-access guard when operators replay this older file.',
    'DO $migration$',
    'BEGIN',
    " IF pg_catalog.obj_description(pg_catalog.to_regprocedure('public.shardkeep_starter_expedition_insert_guard()'),'pg_proc') IS DISTINCT FROM 'phase-e:starter-expedition-guard:paid-access-v1' THEN",
    declaration,
  ].join('\n');
  const result = Buffer.from(originalFixture().toString('utf8').replace(declaration, wrapper)
    .replace(revoke, `\n END IF;\nEND $migration$;${revoke}`));
  expect(digest(result)).toBe(EDITED_SHA);
  return result;
}

function paidBody(): string {
  const source = migration('0185_starter_paid_access').toString('utf8');
  const start = source.indexOf('AS $$');
  const end = source.indexOf('$$;', start + 5);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start + 5, end);
}

async function withHistoricalDatabase(initial0146: Buffer, work: (fixture: {
  connection: ReturnType<typeof createDb>; folder: string; journal: Journal; originalIndex: number;
  stage: (entries: Entry[]) => void; originalPath: string;
}) => Promise<void>) {
  const { journal, originalIndex } = plan();
  const adminInput = process.env.PKW_MIGRATION_0146_TEST_ADMIN_URL;
  if (!adminInput) throw new Error('Cedar3 must admit and supply a dedicated migration0146 test PostgreSQL endpoint');
  const adminUrl = new URL(adminInput);
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol)
      || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(adminUrl.hostname)
      || !adminUrl.port || ['5433', '55492'].includes(adminUrl.port)
      || adminUrl.pathname !== '/postgres') {
    throw new Error('migration0146 requires an explicitly admitted isolated loopback maintenance endpoint; excluded ports are refused');
  }
  const databaseName = `migration0146_${randomUUID().replaceAll('-', '')}_test`;
  const folder = mkdtempSync(join(tmpdir(), 'migration0146-history-'));
  mkdirSync(join(folder, 'meta'));
  const admin = postgres(adminInput, { max: 1, onnotice: () => {} });
  const databaseUrl = new URL(adminInput); databaseUrl.pathname = `/${databaseName}`;
  let created = false;
  let connection: ReturnType<typeof createDb> | undefined;
  const stage = (entries: Entry[]) => writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  try {
    for (const entry of journal.entries) {
      copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    const originalPath = join(folder, `${ORIGINAL_TAG}.sql`);
    writeFileSync(originalPath, initial0146);
    stage(journal.entries.slice(0, originalIndex + 1));
    await admin.unsafe(`CREATE DATABASE ${databaseName}`); created = true;
    connection = createDb(databaseUrl.toString(), { max: 1 });
    await runMigrations(connection.db, { migrationsFolder: folder });
    await work({ connection, folder, journal, originalIndex, stage, originalPath });
  } finally {
    await connection?.sql.end();
    try {
      if (created) await admin.unsafe(`DROP DATABASE ${databaseName}`);
    } finally {
      await admin.end();
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

const history = (connection: ReturnType<typeof createDb>) => connection.sql<{ id: number; hash: string; created_at: string }[]>`
  SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, id`;
const guard = (connection: ReturnType<typeof createDb>) => connection.sql`
  SELECT p.oid::text AS oid, p.prosrc AS body, pg_get_functiondef(p.oid) AS definition,
    p.proacl::text AS acl, obj_description(p.oid, 'pg_proc') AS marker
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.shardkeep_starter_expedition_insert_guard()')`;

it('upgrades ORIGINAL-0146 history through the canonical migrator to head with the exact paid body and marker', async () => {
  await withHistoricalDatabase(originalFixture(), async ({ connection, folder, journal, originalIndex, stage, originalPath }) => {
    const historical = await history(connection);
    expect(historical).toHaveLength(originalIndex + 1);
    expect(historical[originalIndex]).toMatchObject({ hash: ORIGINAL_SHA, created_at: '1790007000000' });
    stage(journal.entries);
    // Refusal evidence is retained from v1. Only a disposable filesystem copy is changed.
    writeFileSync(originalPath, editedHistoricalSql());
    await expect(runMigrations(connection.db, { migrationsFolder: folder }))
      .rejects.toThrow(`applied migration history mismatch at position ${originalIndex}`);
    expect(await history(connection)).toEqual(historical);
    writeFileSync(originalPath, originalFixture());
    await runMigrations(connection.db, { migrationsFolder: folder });
    const upgraded = await history(connection);
    expect(upgraded).toHaveLength(journal.entries.length);
    expect(upgraded.slice(0, historical.length)).toEqual(historical);
    const paid = await guard(connection);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.marker).toBe(PAID_MARKER);
    expect(paid[0]!.body).toBe(paidBody());
    expect(paid[0]!.body).toContain('paid_realm');
    const triggers = () => connection.sql`
      SELECT t.oid::text AS oid, t.tgrelid::text AS relation, t.tgfoid::text AS function,
        t.tgenabled, pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
      WHERE t.tgfoid = to_regprocedure('public.shardkeep_starter_expedition_insert_guard()') ORDER BY t.oid`;
    const rows = async () => {
      const result = [];
      for (const table of ['starter_expeditions', 'starter_expedition_inflight', 'starter_expedition_returns',
        'accounts', 'ledger_transactions', 'ledger_entries']) {
        result.push({ table, rows: await connection.sql.unsafe(`SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY 1`) });
      }
      return result;
    };
    const beforeRepeat = { triggers: await triggers(), rows: await rows() };
    expect(beforeRepeat.triggers.length).toBeGreaterThan(0);
    await runMigrations(connection.db, { migrationsFolder: folder });
    expect(await history(connection)).toEqual(upgraded);
    expect(await guard(connection)).toEqual(paid);
    expect(await triggers()).toEqual(beforeRepeat.triggers);
    expect(await rows()).toEqual(beforeRepeat.rows);
  });
}, 120_000);

it('refuses a database that applied EDITED-0146 after restoration without rewriting its journal', async () => {
  await withHistoricalDatabase(editedHistoricalSql(), async ({ connection, folder, journal, originalIndex, stage, originalPath }) => {
    const editedHistory = await history(connection);
    const beforeGuard = await guard(connection);
    expect(editedHistory[originalIndex]).toMatchObject({ hash: EDITED_SHA, created_at: '1790007000000' });
    writeFileSync(originalPath, originalFixture());
    stage(journal.entries);
    await expect(runMigrations(connection.db, { migrationsFolder: folder }))
      .rejects.toThrow(`applied migration history mismatch at position ${originalIndex}`);
    expect(await history(connection)).toEqual(editedHistory);
    expect(await guard(connection)).toEqual(beforeGuard);
  });
}, 120_000);
