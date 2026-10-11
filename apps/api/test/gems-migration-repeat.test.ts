import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_DATABASE_URL } from './db-url';

it('repeats the reserve, welcome and Workshop migrations without changing accepted facts or weakening their guards', async () => {
  const name = `gems_repeat_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    conn = createDb(url.toString(), { max: 1 });
    const { db, sql } = conn;
    await runMigrations(db);
    const wallet = `repeat_${randomUUID()}`;
    const address = '11111111111111111111111111111111';
    const otherAddress = '22222222222222222222222222222222';
    await sql`INSERT INTO economy_chain_identity (cluster, keep_mint, core_program, config_pda)
      VALUES ('devnet', ${address}, ${address}, ${address})`;
    await sql`UPDATE economy_chain_identity SET gems_reserve_owner = ${address}, gems_reserve_ata = ${address}`;
    await sql`INSERT INTO players (wallet) VALUES (${wallet})`;
    const [base] = await sql`INSERT INTO bases (owner_wallet) VALUES (${wallet}) RETURNING id`;
    await sql`INSERT INTO welcome_gems_obligations (wallet, gems) VALUES (${wallet}, 10)`;
    const jobs: string[] = [];
    // A pre-classification NULL remains unknown; a new accepted classification
    // and an already-collected job must also survive retries byte-for-byte.
    for (const scope of [null, 'free_wallet', 'deed_base']) {
      const [receipt] = await sql`INSERT INTO ledger_transactions (idempotency_key, type)
        VALUES (${randomUUID()}, 'test.workshop.start') RETURNING id`;
      const [job] = await sql`INSERT INTO workshop_jobs (base_id, started_by_wallet,
        workshop_level_at_start, capacity_scope_at_start, recipe_version, ingots, shards_charged,
        ready_at, debit_ledger_txn_id, start_idempotency_key)
        VALUES (${base!.id}, ${wallet}, 1, ${scope}, 1, 1, ${PHASE_E_POLICY.forge.shardsPerIngot},
          '2026-09-25T00:00:00Z', ${receipt!.id}, ${randomUUID()}) RETURNING id`;
      jobs.push(job!.id as string);
    }
    await sql`UPDATE workshop_jobs SET collected_at = '2026-09-26T00:00:00Z',
      collected_by_wallet = ${wallet}, collect_idempotency_key = 'collected' WHERE id = ${jobs[2]!}`;

    const facts = async () => ({
      identity: await sql`SELECT * FROM economy_chain_identity`,
      obligations: await sql`SELECT * FROM welcome_gems_obligations ORDER BY wallet`,
      jobs: await sql`SELECT * FROM workshop_jobs ORDER BY id`,
      receipts: await sql`SELECT * FROM ledger_transactions ORDER BY id`,
      journal: await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
    });
    const guards = async () => ({
      constraints: await sql`SELECT oid::text, conname, pg_get_constraintdef(oid) AS definition
        FROM pg_catalog.pg_constraint WHERE conrelid IN ('economy_chain_identity'::regclass,
          'welcome_gems_obligations'::regclass, 'workshop_jobs'::regclass) ORDER BY conname`,
      triggers: await sql`SELECT oid::text, tgname, pg_get_triggerdef(oid) AS definition
        FROM pg_catalog.pg_trigger WHERE tgrelid IN ('economy_chain_identity'::regclass,
          'welcome_gems_obligations'::regclass, 'workshop_jobs'::regclass) ORDER BY tgname`,
      functions: await sql`SELECT oid::text, proname, proacl, pg_get_functiondef(oid) AS definition
        FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
          ('shardkeep_guard_economy_chain_identity', 'shardkeep_guard_welcome_gems_obligation',
            'shardkeep_guard_workshop_start_facts') ORDER BY proname`,
      index: await sql`SELECT c.oid::text, c.relfilenode::text, pg_get_indexdef(c.oid) AS definition
        FROM pg_catalog.pg_class c WHERE c.oid = 'workshop_jobs_wallet_started_idx'::regclass`,
      columnGrants: await sql`SELECT attname, attacl FROM pg_catalog.pg_attribute
        WHERE attrelid = 'economy_chain_identity'::regclass AND attname IN
          ('gems_reserve_owner', 'gems_reserve_ata') ORDER BY attname`,
    });
    const before = { facts: await facts(), guards: await guards() };
    const checkPolicy = async () => {
      await expect(sql`UPDATE economy_chain_identity SET gems_reserve_owner = ${otherAddress},
        gems_reserve_ata = ${otherAddress}`).rejects.toThrow('database economy chain identity is immutable');
      await expect(sql`UPDATE economy_chain_identity SET gems_reserve_owner = NULL,
        gems_reserve_ata = NULL`).rejects.toThrow('database economy chain identity is immutable');
      await expect(sql`DELETE FROM economy_chain_identity`).rejects.toThrow('database economy chain identity is immutable');
      await expect(sql`UPDATE welcome_gems_obligations SET gems = gems + 1 WHERE wallet = ${wallet}`)
        .rejects.toThrow('welcome Gems obligation is immutable');
      await expect(sql`DELETE FROM welcome_gems_obligations WHERE wallet = ${wallet}`)
        .rejects.toThrow('welcome Gems obligation is immutable');
      await expect(sql`UPDATE workshop_jobs SET capacity_scope_at_start = 'deed_base' WHERE id = ${jobs[0]!}`)
        .rejects.toThrow('Workshop start facts are immutable');
      await expect(sql`UPDATE workshop_jobs SET shards_charged = shards_charged + 1 WHERE id = ${jobs[1]!}`)
        .rejects.toThrow('Workshop start facts are immutable');
      await expect(sql`UPDATE workshop_jobs SET collected_at = NULL WHERE id = ${jobs[2]!}`)
        .rejects.toThrow('Workshop collection facts are immutable');
      await expect(sql`DELETE FROM workshop_jobs WHERE id = ${jobs[1]!}`)
        .rejects.toThrow('Workshop start facts are immutable');
    };
    await checkPolicy();
    await sql`SET lock_timeout = '321ms'`;
    for (const tag of ['0136_gems_reserve_identity', '0137_welcome_gems_obligations', '0138_workshop_allowance']) {
      const migration = await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), 'utf8');
      await sql.begin(async tx => {
        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await tx.unsafe(statement);
        }
      });
      expect(await sql`SHOW lock_timeout`).toEqual([{ lock_timeout: '321ms' }]);
    }
    await checkPolicy();
    expect(await facts()).toEqual(before.facts);
    expect(await guards()).toEqual(before.guards);
    await runMigrations(db);
    expect(await facts()).toEqual(before.facts);
  } finally {
    await conn?.sql.end();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
    finally { await admin.end(); }
  }
}, 120_000);
