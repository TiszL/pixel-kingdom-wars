import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapSystemAccounts, SYSTEM_ACCOUNT_KINDS } from '../src/ledger/accounts';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';

async function fixture(run: (conn: ReturnType<typeof createDb>) => Promise<void>) {
  const name = `ledger_bootstrap_${randomUUID().replaceAll('-', '')}_test`, url = new URL(ADMIN_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('local fixture required');
  url.pathname = '/' + name;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  await createMigratedDatabase(admin, name);
  const conn = createDb(url.toString());
  try { await runMigrations(conn.db); await run(conn); }
  finally { await conn.sql.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); }
}

it('returns all current system identities on first and duplicate bootstrap without changing balances', async () => fixture(async conn => {
  const first = await conn.db.transaction(tx => bootstrapSystemAccounts(tx));
  expect(Object.keys(first).sort()).toEqual([...SYSTEM_ACCOUNT_KINDS].sort());
  const before = await conn.sql`select to_jsonb(a) value from accounts a order by id`;
  expect(await bootstrapSystemAccounts(conn.db)).toEqual(first);
  expect(await conn.db.transaction(tx => bootstrapSystemAccounts(tx))).toEqual(first);
  expect(await conn.sql`select to_jsonb(a) value from accounts a order by id`).toEqual(before);
}));

it('refuses a suppressed supported kind and propagates real source-guard failures without partial accounts', async () => fixture(async conn => {
  const before = await conn.sql`select to_jsonb(a) value from accounts a order by id`;
  await conn.sql`create function public.fixture_suppress_system_account() returns trigger language plpgsql as $$
    begin if new.kind='charter_creation_escrow' then return null; end if; return new; end $$`;
  await conn.sql`create trigger a_fixture_suppress_system_account before insert on accounts
    for each row execute function public.fixture_suppress_system_account()`;
  await expect(conn.db.transaction(tx => bootstrapSystemAccounts(tx))).rejects.toThrow("bootstrapSystemAccounts: missing system account 'charter_creation_escrow'");
  expect(await conn.sql`select to_jsonb(a) value from accounts a order by id`).toEqual(before);
  await conn.sql`create or replace function public.fixture_suppress_system_account() returns trigger language plpgsql as $$
    begin raise exception using errcode='P0001',message='FIXTURE_ACCOUNT_GUARD'; end $$`;
  await expect(conn.db.transaction(tx => bootstrapSystemAccounts(tx))).rejects.toMatchObject({ cause: { code: 'P0001', message: 'FIXTURE_ACCOUNT_GUARD' } });
  expect(await conn.sql`select to_jsonb(a) value from accounts a order by id`).toEqual(before);
}));
