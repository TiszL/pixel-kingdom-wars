/** Intended path: apps/api/test/clan-charter-creation-bootstrap.test.ts.
 * An interrupted enum-only rollout must not turn pre-existing money or old
 * posting rows into prospective funding proof when the new hooks are installed. */
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapSystemAccounts, postTransaction } from '../src/ledger';
import { ADMIN_DATABASE_URL } from './db-url';

for (const mode of ['nonzero', 'previously-used-zero', 'historical-post']) {
  it(`holds first Charter hook installation for ${mode} escrow/source history`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'charter-migration-prefix-'));
    const name = 'charter_bootstrap_' + randomUUID().replaceAll('-', '') + '_test';
    const url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + name;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Owned local fixture database required');
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    let conn: ReturnType<typeof createDb> | undefined;
    try {
      const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
      const fundingIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0220_charter_creation_reservations');
      expect(fundingIndex).toBeGreaterThan(0);
      const entries = journal.entries.slice(0, fundingIndex);
      expect(entries.at(-1).tag).toBe('0219_charter_creation_escrow_kind');
      mkdirSync(join(folder, 'meta'));
      writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) copyFileSync(new URL('../drizzle/' + entry.tag + '.sql', import.meta.url), join(folder, entry.tag + '.sql'));
      await admin.unsafe(`create database ${name}`); conn = createDb(url.toString(), { max: 1 });
      await runMigrations(conn.db, { migrationsFolder: folder });
      const system = await bootstrapSystemAccounts(conn.db);
      const [escrow] = await conn.sql`select id,balance from accounts where kind::text='charter_creation_escrow'`;
      expect(escrow!.balance).toBe('0');
      if (mode === 'nonzero') await conn.sql`update accounts set balance=1 where id=${escrow!.id}`;
      if (mode === 'previously-used-zero') {
        for (const amount of [1n, -1n]) await postTransaction(conn.db, {
          idempotencyKey: randomUUID(), type: 'test.pre_hook_escrow',
          entries: [{ account: system.shard_genesis, delta: -amount }, { account: escrow!.id, delta: amount }],
        });
        expect((await conn.sql`select balance from accounts where id=${escrow!.id}`)[0]!.balance).toBe('0');
        expect(await conn.sql`select id from ledger_entries where account_id=${escrow!.id}`).toHaveLength(2);
      }
      if (mode === 'historical-post') await conn.sql`insert into ledger_transactions(type,idempotency_key,metadata)
        values('clan.charter.reserve',${randomUUID()},'{}'::jsonb)`;
      const before = await conn.sql`select * from accounts order by id`;
      let failure: unknown; try { await runMigrations(conn.db); } catch (error) { failure = error; }
      let leaf: { code: string; message: string } | undefined;
      for (let depth = 0; depth < 8 && failure && typeof failure === 'object'; depth++) {
        if ('code' in failure && typeof failure.code === 'string' && 'message' in failure && typeof failure.message === 'string')
          leaf = { code: failure.code, message: failure.message };
        failure = 'cause' in failure ? failure.cause : undefined;
      }
      expect(leaf).toEqual({ code: 'P0001', message: 'CLAN_CHARTER_CREATION_BOOTSTRAP_HELD' });
      expect(await conn.sql`select * from accounts order by id`).toEqual(before);
      expect((await conn.sql`select to_regclass('public.charter_creation_funding_posts') value`)[0]!.value).toBeNull();
    } finally {
      await conn?.sql.end();
      try { await admin.unsafe(`drop database if exists ${name} with (force)`); }
      finally { await admin.end(); rmSync(folder, { recursive: true, force: true }); }
    }
  }, 120_000);
}
