import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const SPLIT = ['0134_gems_currency', '0134_gems_schema', '0134_gems_owner_scope'];

it('upgrades 0133 through the explicit M41 target without replacing enum or money storage identities, rewriting history, or dropping partial indexes', async () => {
  const name = `gems_additive_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
  const folder = await mkdtemp(path.join(tmpdir(), 'shardkeep-gems-0133-'));
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    const journal = JSON.parse(await readFile(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const split = journal.entries.filter(entry => SPLIT.includes(entry.tag));
    expect(split.map(entry => entry.tag)).toEqual(SPLIT);
    expect(split.map(entry => entry.when)).toEqual([1789914108000, 1789914108001, 1789914108002]);
    expect(journal.entries.map(entry => entry.idx)).toEqual(journal.entries.map((_, index) => index));
    expect(journal.entries.filter(entry => /^013[5-8]_/.test(entry.tag)).map(({ tag, when }) => ({ tag, when }))).toEqual([
      { tag: '0135_phase_e_building_types', when: 1789920000000 },
      { tag: '0136_gems_reserve_identity', when: 1790006400000 },
      { tag: '0137_welcome_gems_obligations', when: 1790006460000 },
      { tag: '0138_workshop_allowance', when: 1790006520000 },
    ]);
    // This proof owns the M41 additive upgrade boundary. Later blocks have
    // separate fresh-history coverage and must not broaden this fixture.
    const targetIndex = journal.entries.findIndex(entry => entry.tag === '0138_workshop_allowance');
    expect(targetIndex).toBe(140);
    const target = { ...journal, entries: journal.entries.slice(0, targetIndex + 1) };
    const historical = { ...target, entries: target.entries.slice(0, 134) };
    expect(historical.entries.at(-1)?.tag).toBe('0133_item_market_reconcile_attempt');
    await mkdir(path.join(folder, 'meta'));
    await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(historical));
    for (const entry of target.entries) {
      await copyFile(path.join(MIGRATIONS, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    }
    await admin.unsafe(`CREATE DATABASE ${name}`);
    conn = createDb(url.toString(), { max: 1 });
    const { db, sql } = conn;
    await runMigrations(db, { migrationsFolder: folder });
    expect(await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`).toEqual([{ count: 134 }]);

    // Historical fixtures use SQL, never today's ledger or account bootstrap.
    // The three currencies have balanced receipts and nonzero player caches.
    const wallet = `upgrade_${randomUUID()}`;
    await sql`INSERT INTO players (wallet) VALUES (${wallet})`;
    const [base] = await sql`INSERT INTO bases (owner_wallet) VALUES (${wallet}) RETURNING id`;
    await sql.begin(async tx => {
      const [receipt] = await tx`INSERT INTO ledger_transactions (idempotency_key, type)
        VALUES (${randomUUID()}, 'test.historical') RETURNING id`;
      for (const [currency, system, player, amount] of [
        ['KEEP', 'keep_genesis', 'player_keep', 31],
        ['SOL', 'sol_treasury', 'player_sol_credit', 17],
        ['SHARDS', 'shard_genesis', 'player_shards', 19],
      ] as const) {
        for (const [kind, owner, balance] of [[system, null, -amount], [player, wallet, amount]] as const) {
          const [account] = await tx`INSERT INTO accounts (owner_wallet, kind, currency, balance)
            VALUES (${owner}, ${kind}, ${currency}, ${balance}) RETURNING id`;
          await tx`INSERT INTO ledger_entries (txn_id, account_id, delta, balance_after)
            VALUES (${receipt!.id}, ${account!.id}, ${balance}, ${balance})`;
        }
      }
    });
    for (const kind of ['builder', 'expansion'] as const) {
      const field = kind === 'builder' ? 'expectedBuilders' : 'expectedExpansions';
      for (const payload of [{ [field]: 1 }, { [field]: 1, baseId: base!.id }]) {
        await sql`INSERT INTO deposits (player_wallet, kind, reference, payload)
          VALUES (${wallet}, ${kind}, ${randomUUID()}, ${JSON.stringify(payload)}::jsonb)`;
      }
    }
    await sql`INSERT INTO withdrawals (player_wallet, currency, amount, destination, unbonds_at)
      VALUES (${wallet}, 'KEEP', 2, ${wallet}, '2026-09-25T00:00:00Z')`;
    await sql`INSERT INTO player_items (player_wallet, item_id, qty) VALUES (${wallet}, 'legacy_player', 3)`;
    await sql`INSERT INTO base_items (base_id, item_id, qty) VALUES (${base!.id}, 'legacy_base', 4)`;

    const identities = () => sql`SELECT c.relname, c.oid::text, c.relfilenode::text
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND (c.relname IN ('accounts', 'deposits', 'withdrawals', 'ledger_entries', 'ledger_transactions')
        OR c.relname IN ('deposits_builder_legacy_slot_pending_uq', 'deposits_expansion_legacy_slot_pending_uq',
          'deposits_builder_slot_pending_uq', 'deposits_expansion_slot_pending_uq')) ORDER BY c.relname`;
    const enumRows = () => sql`SELECT t.typname, t.oid::text AS type_oid, e.enumlabel, e.oid::text AS label_oid, e.enumsortorder
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('account_kind', 'currency', 'deposit_kind') ORDER BY t.typname, e.enumsortorder`;
    const moneyRows = async () => ({
      accounts: await sql`SELECT * FROM accounts ORDER BY id`,
      entries: await sql`SELECT * FROM ledger_entries ORDER BY id`,
      receipts: await sql`SELECT * FROM ledger_transactions ORDER BY id`,
      deposits: await sql`SELECT * FROM deposits ORDER BY id`,
      withdrawals: await sql`SELECT * FROM withdrawals ORDER BY id`,
    });
    const before = { identities: await identities(), enums: await enumRows(), money: await moneyRows() };
    expect(before.identities).toHaveLength(9);
    await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(target));
    await runMigrations(db, { migrationsFolder: folder });
    expect(await identities()).toEqual(before.identities);
    expect(await enumRows()).toEqual(expect.arrayContaining(before.enums));
    expect(await moneyRows()).toEqual(before.money);
    expect(await sql`SELECT acquired_via, qty FROM player_items WHERE player_wallet = ${wallet}`)
      .toEqual([{ acquired_via: 'legacy', qty: 3 }]);
    expect(await sql`SELECT acquired_via, qty FROM base_items WHERE base_id = ${base!.id}`)
      .toEqual([{ acquired_via: 'legacy', qty: 4 }]);

    // Repeating the new SQL itself also preserves existing identities/history.
    // The owner-scope step is exercised only on this disposable database;
    // application in an owner environment remains separately held.
    for (const tag of SPLIT) {
      const migration = await readFile(path.join(MIGRATIONS, `${tag}.sql`), 'utf8');
      await sql.begin(async tx => {
        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await tx.unsafe(statement);
        }
      });
    }
    await runMigrations(db, { migrationsFolder: folder });
    expect(await identities()).toEqual(before.identities);
    expect(await moneyRows()).toEqual(before.money);
    expect(await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`).toEqual([{ count: 141 }]);
    await sql`INSERT INTO accounts (owner_wallet, kind, currency) VALUES (${wallet}, 'player_gems', 'GEMS')`;
    await expect(sql`INSERT INTO accounts (kind, currency) VALUES ('player_gems', 'GEMS')`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'accounts_owner_scope_ck' });
    await expect(sql`INSERT INTO accounts (owner_wallet, kind, currency) VALUES (${wallet}, 'gems_mint', 'GEMS')`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'accounts_owner_scope_ck' });
    await sql`INSERT INTO deposits (player_wallet, kind, reference, payload)
      VALUES (${wallet}, 'gems_buy', ${randomUUID()}, '{"idempotencyKey":"upgrade"}')`;
    await expect(sql`INSERT INTO deposits (player_wallet, kind, reference, payload)
      VALUES (${wallet}, 'gems_buy', ${randomUUID()}, '{"idempotencyKey":"upgrade"}')`)
      .rejects.toMatchObject({ code: '23505', constraint_name: 'deposits_gems_buy_key_uq' });
  } finally {
    await conn?.sql.end();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
    finally { await admin.end(); await rm(folder, { recursive: true, force: true }); }
  }
}, 120_000);
