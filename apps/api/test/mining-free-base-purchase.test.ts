import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { ECONOMY, PHASE_E_POLICY } from '@shardkeep/shared';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import * as baseSetup from '../src/game/base';
import { rewardBaseShards, getBaseShardBalance } from '../src/game/baseEconomy';
import { assertFreshLockedBaseAuthority, registerOwnedDeed, resolveActiveBase } from '../src/game/baseOwnership';
import { enrollInitialFreeCohort, initializeFreeCohortCoverage, readFreeCohortInterval } from '../src/mining/freeCohort';
import { purchaseFreeBase, getFreeBasePurchase } from '../src/mining/freeBasePurchase';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, coverage = false) {
  const f = await setup(coverage);
  try { await run(f); } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await f.conn.sql.end();
    await f.admin.unsafe(`drop database ${f.name} with (force)`); await f.admin.end();
  }
}
async function setup(coverage: boolean) {
  const name = `free_base_${randomUUID().replaceAll('-', '')}_test`, url = new URL(ADMIN_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('local fixture required');
  url.pathname = `/${name}`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  await createMigratedDatabase(admin, name);
  const conn = createDb(url.toString(), { max: 5 });
  try {
    await runMigrations(conn.db);
    const clock = async (value: string) => {
      if (!/^2035-01-0[1-4]T\d{2}:00:00Z$/.test(value)) throw new Error('fixture clock only');
      await conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);
    };
    if (coverage) { await clock('2035-01-01T12:00:00Z'); await initializeFreeCohortCoverage(conn.db); }
    const wallet = Keypair.generate().publicKey.toBase58(), other = Keypair.generate().publicKey.toBase58(), sourceBaseId = randomUUID();
    await conn.sql`insert into players(wallet,created_at) values(${wallet},public.shardkeep_mining_free_clock()),(${other},public.shardkeep_mining_free_clock())`;
    await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${sourceBaseId},${wallet},5)`;
    await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${sourceBaseId})`;
    await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values
      (${wallet},${sourceBaseId},'keep',5,10,10),(${wallet},${sourceBaseId},'workshop',1,20,20),(${wallet},${sourceBaseId},'goldforge',1,25,25)`;
    await rewardBaseShards(conn.db, sourceBaseId, BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards), 'test.fund', `fund:${sourceBaseId}`);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); vi.stubEnv('MULTI_BASE_ENABLED', 'true');
    vi.stubEnv('GEMS_ENABLED', 'false'); vi.stubEnv('DEV_LOGIN', 'false');
    const request = { sourceBaseId, idempotencyKey: 'purchase-key-1' };
    return { name, admin, conn, wallet, other, sourceBaseId, request, clock, databaseUrl: url.toString() };
  } catch (error) { await conn.sql.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); throw error; }
}

describe('second free base purchase', () => {
  it('burns the source price and atomically initializes a selectable second base with an immutable lifetime receipt', async () => fixture(async f => {
    const oldTerrain = randomUUID(), welcome = randomUUID();
    await f.conn.sql`insert into obstacles(id,player_wallet,base_id,sprite_key,tx,ty)
      values(${oldTerrain},${f.wallet},${f.sourceBaseId},'fixture-old-terrain',1,1)`;
    await f.conn.sql`insert into mail_messages(id,recipient_wallet,sender_kind,kind,dedupe_key,subject,body)
      values(${welcome},${f.wallet},'system','info',${`welcome:${f.wallet}`},'Original welcome','Original retained welcome')`;
    vi.stubEnv('GEMS_ENABLED', 'true'); vi.stubEnv('DEVNET_WELCOME_GEMS_ENABLED', 'true');
    const quest = randomUUID();
    await f.conn.sql`insert into quests(id,scope,template_code,target,reward_keep,active_on)
      values(${quest},'daily','spend_200',200,1,(now() at time zone 'UTC')::date)`;
    await f.conn.sql`insert into base_quest_progress(base_id,quest_id) values(${f.sourceBaseId},${quest})`;
    const receipt = await purchaseFreeBase(f.conn.db, f.wallet, f.request);
    expect(receipt.sourceBaseId).toBe(f.sourceBaseId); expect(receipt.slot).toBe(2);
    expect(receipt.shardsCharged).toBe(String(PHASE_E_POLICY.bases.secondFreeBaseCostShards));
    expect(await getBaseShardBalance(f.conn.db, f.sourceBaseId)).toBe(0n);
    expect(await getBaseShardBalance(f.conn.db, receipt.baseId)).toBe(BigInt(ECONOMY.starterShards));
    expect(await f.conn.sql`select id from buildings where base_id=${receipt.baseId} and type='keep'`).toHaveLength(1);
    expect((await f.conn.sql`select id from obstacles where base_id=${receipt.baseId}`).length).toBeGreaterThan(0);
    expect(await f.conn.sql`select id from obstacles where base_id=${f.sourceBaseId}`).toEqual([{ id: oldTerrain }]);
    expect(await f.conn.sql`select id from mail_messages where recipient_wallet=${f.wallet} and dedupe_key=${`welcome:${f.wallet}`}`).toEqual([{ id: welcome }]);
    expect(await f.conn.sql`select wallet from welcome_gems_obligations where wallet=${f.wallet}`).toHaveLength(0);
    expect(await f.conn.sql`select id from ledger_transactions where idempotency_key=${`grant:welcome:${f.wallet}`}`).toHaveLength(0);
    expect((await resolveActiveBase(f.conn.db, f.wallet, f.sourceBaseId))?.base.id).toBe(f.sourceBaseId);
    expect((await resolveActiveBase(f.conn.db, f.wallet, receipt.baseId))?.base.id).toBe(receipt.baseId);
    await expect(resolveActiveBase(f.conn.db, f.wallet)).rejects.toMatchObject({ code: 'BASE_ID_REQUIRED' });
    expect(await f.conn.sql`select id from ledger_transactions where type='base.free_purchase'`).toHaveLength(1);
    expect((await f.conn.sql`select progress from base_quest_progress where base_id=${f.sourceBaseId} and quest_id=${quest}`)[0]!.progress).toBe(0);
    await expect(f.conn.sql`update mining_free_base_purchases set slot=3`).rejects.toThrow('FREE_BASE_RECEIPT_IMMUTABLE');
    await expect(f.conn.sql`delete from mining_free_base_purchases`).rejects.toThrow('FREE_BASE_RECEIPT_IMMUTABLE');
    await expect(f.conn.sql`truncate mining_free_base_purchases`).rejects.toThrow('FREE_BASE_RECEIPT_IMMUTABLE');
  }));
  it('recovers before pause and current custody checks, refuses changed bodies and never reopens the lifetime entitlement', async () => fixture(async f => {
    const receipt = await purchaseFreeBase(f.conn.db, f.wallet, f.request);
    await f.conn.sql`update bases set owner_wallet=${f.other} where id=${receipt.baseId}`;
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    expect(await purchaseFreeBase(f.conn.db, f.wallet, f.request)).toEqual(receipt);
    expect(await getFreeBasePurchase(f.conn.db, f.wallet, f.request.idempotencyKey)).toEqual(receipt);
    expect(await getFreeBasePurchase(f.conn.db, f.other, f.request.idempotencyKey)).toBeNull();
    await expect(purchaseFreeBase(f.conn.db, f.wallet, { ...f.request, sourceBaseId: receipt.baseId })).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
    await expect(purchaseFreeBase(f.conn.db, f.wallet, { ...f.request, idempotencyKey: 'different-key' })).rejects.toMatchObject({ code: 'FREE_BASE_ALREADY_PURCHASED' });
  }));
  it('serializes concurrent keys into one purchase and rolls back a failed initialization completely', async () => fixture(async f => {
    vi.spyOn(baseSetup, 'initializePurchasedFreeBase').mockRejectedValueOnce(new Error('fixture initialization fault'));
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toThrow('fixture initialization fault');
    expect(await f.conn.sql`select id from bases where owner_wallet=${f.wallet}`).toHaveLength(1);
    expect(await f.conn.sql`select wallet from mining_free_base_purchases`).toHaveLength(0);
    expect(await getBaseShardBalance(f.conn.db, f.sourceBaseId)).toBe(BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards));
    const attempts = await Promise.allSettled([purchaseFreeBase(f.conn.db, f.wallet, f.request), purchaseFreeBase(f.conn.db, f.wallet, { ...f.request, idempotencyKey: 'concurrent-key' })]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await f.conn.sql`select id from ledger_transactions where type='base.free_purchase'`).toHaveLength(1);
  }));
  it('refuses wrong actors, paused admission, undeveloped bases and insufficient funds without creating a base', async () => fixture(async f => {
    await expect(purchaseFreeBase(f.conn.db, f.other, f.request)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toMatchObject({ code: 'PHASE_E_DISABLED' });
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    await f.conn.sql`update buildings set level=0 where base_id=${f.sourceBaseId} and type='workshop'`;
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toMatchObject({ code: 'FREE_BASE_DEVELOPMENT_REQUIRED' });
    await f.conn.sql`update buildings set level=1 where base_id=${f.sourceBaseId} and type='workshop'`;
    const { spendBaseShards } = await import('../src/game/baseEconomy');
    await spendBaseShards(f.conn.db, f.sourceBaseId, 1n, 'test.spend', 'fixture:spend', {}, { progressQuests: false });
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toMatchObject({ code: 'ledger.insufficient_funds' });
    expect(await f.conn.sql`select id from bases where owner_wallet=${f.wallet}`).toHaveLength(1);
  }));
  it('refuses pending development, paid/minting sources and a full roster without replacing a base', async () => fixture(async f => {
    const [keep] = await f.conn.sql`select id from buildings where base_id=${f.sourceBaseId} and type='keep'`;
    await f.conn.sql`insert into builder_jobs(player_wallet,base_id,kind,building_id,finishes_at)
      values(${f.wallet},${f.sourceBaseId},'upgrade',${keep!.id},now()+interval '1 day')`;
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toMatchObject({ code: 'FREE_BASE_DEVELOPMENT_REQUIRED' });
    await f.conn.sql`update builder_jobs set completed_at=now() where base_id=${f.sourceBaseId}`;
    await f.conn.sql`update bases set deed_mint_asset_id='fixture-pending-deed' where id=${f.sourceBaseId}`;
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toMatchObject({ code: 'FREE_BASE_SOURCE_REQUIRED' });
    await f.conn.sql`update bases set deed_mint_asset_id=null,land_paid_at=now() where id=${f.sourceBaseId}`;
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toMatchObject({ code: 'FREE_BASE_SOURCE_REQUIRED' });
    await f.conn.sql`update bases set land_paid_at=null where id=${f.sourceBaseId}`;
    for (let slot = 2; slot <= PHASE_E_POLICY.bases.activePerWalletMax; slot++) {
      const id = randomUUID();
      await f.conn.sql`insert into bases(id,owner_wallet,land_paid_at) values(${id},${f.wallet},now())`;
      await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.wallet},${slot},${id})`;
    }
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toMatchObject({ code: 'BASE_SLOTS_FULL' });
    expect(await getBaseShardBalance(f.conn.db, f.sourceBaseId)).toBe(BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards));
    expect(await f.conn.sql`select wallet from mining_free_base_purchases`).toHaveLength(0);
  }));
  it('retains exact debit proof, allows later balance writes and reapplying the migration, and refuses runtime receipt forgery', async () => fixture(async f => {
    const receipt = await purchaseFreeBase(f.conn.db, f.wallet, f.request);
    const [leg] = await f.conn.sql`select e.* from ledger_entries e join accounts a on a.id=e.account_id where e.txn_id=${receipt.debitTransactionId} and a.kind='base_shards'`;
    await expect(f.conn.sql`update ledger_transactions set metadata='{}' where id=${receipt.debitTransactionId}`).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    await expect(f.conn.sql`delete from ledger_transactions where id=${receipt.debitTransactionId}`).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    await expect(f.conn.sql`update ledger_entries set delta=delta+1 where id=${leg!.id}`).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    await expect(f.conn.sql`delete from ledger_entries where id=${leg!.id}`).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    await expect(f.conn.sql`update accounts set currency='GEMS' where id=${leg!.account_id}`).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    await expect(f.conn.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${receipt.debitTransactionId},${leg!.account_id},1,1)`).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    await rewardBaseShards(f.conn.db, f.sourceBaseId, 1n, 'test.later', 'later-balance');
    const [later] = await f.conn.sql`select e.id from ledger_entries e join ledger_transactions t on t.id=e.txn_id where t.idempotency_key='later-balance' limit 1`;
    await expect(f.conn.sql`update ledger_entries set txn_id=${receipt.debitTransactionId} where id=${later!.id}`).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    expect(await getBaseShardBalance(f.conn.db, f.sourceBaseId)).toBe(1n);
    // Reach the debit-retention trigger with all newer witness dependencies in
    // scope, rather than failing PostgreSQL's foreign-key preflight first.
    await expect(f.conn.sql`truncate ledger_entries cascade`).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    // Re-execute the actual DDL, not just the migrator's already-applied skip.
    for (const statement of readFileSync(new URL('../drizzle/0163_mining_free_base_purchases.sql', import.meta.url), 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await f.conn.sql.unsafe(statement);
    }
    expect(await getFreeBasePurchase(f.conn.db, f.wallet, f.request.idempotencyKey)).toEqual(receipt);
    await expect(f.conn.sql`delete from mining_free_base_purchases`).rejects.toThrow('FREE_BASE_RECEIPT_IMMUTABLE');
    const role = `free_runtime_${randomUUID().replaceAll('-', '')}`;
    await f.conn.sql.unsafe(`create role ${role}`);
    try {
      await f.conn.sql.unsafe(`grant select,insert on mining_free_base_purchases to ${role}`);
      await expect(f.conn.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`insert into mining_free_base_purchases(wallet,request_key,source_base_id,base_id,slot,policy_version,shards_charged,debit_transaction_id,development)
          select 'forged-runtime','forged-key',source_base_id,${randomUUID()},slot,policy_version,shards_charged,${randomUUID()},development from mining_free_base_purchases`;
      })).rejects.toThrow('FREE_BASE_RECEIPT_OWNER_REQUIRED');
    } finally { await f.conn.sql.unsafe(`drop owned by ${role}`); await f.conn.sql.unsafe(`drop role ${role}`); }
  }));
  it('upgrades the oldest free base to a deed without destroying the other base or reopening the purchase', async () => fixture(async f => {
    const receipt = await purchaseFreeBase(f.conn.db, f.wallet, f.request);
    const deed = await registerOwnedDeed(f.conn.db, f.wallet, `fixture-deed-${randomUUID()}`);
    expect(deed.id).toBe(f.sourceBaseId);
    expect((await resolveActiveBase(f.conn.db, f.wallet, receipt.baseId))?.base.deedAssetId).toBeNull();
    expect(await purchaseFreeBase(f.conn.db, f.wallet, f.request)).toEqual(receipt);
    await expect(purchaseFreeBase(f.conn.db, f.wallet, { sourceBaseId: receipt.baseId, idempotencyKey: 'new-entitlement' })).rejects.toMatchObject({ code: 'FREE_BASE_ALREADY_PURCHASED' });
  }));
  it('invalidates the initial-only mining cohort from the real second-base purchase without rewriting earlier days', async () => fixture(async f => {
    const enrollment = await enrollInitialFreeCohort(f.conn.db, f.wallet, { baseId: f.sourceBaseId, assertAuthority: async (tx, w, id) => { await assertFreshLockedBaseAuthority(tx, w, id); } });
    expect(enrollment.effectiveFrom).toBe('2035-01-02T00:00:00.000Z');
    await f.clock('2035-01-03T12:00:00Z');
    expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02')).valid).toBe(true);
    await purchaseFreeBase(f.conn.db, f.wallet, f.request);
    await f.clock('2035-01-04T00:00:00Z');
    expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02')).valid).toBe(true);
    const current = await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-03');
    expect(current.valid).toBe(false); expect(current.reason).toBe('invalidated');
  }, true));
  it('rejects same-transaction proof changes before receipt insertion and requires READ COMMITTED for ordinary posting', async () => fixture(async f => {
    const original = baseSetup.initializePurchasedFreeBase;
    vi.spyOn(baseSetup, 'initializePurchasedFreeBase').mockImplementationOnce(async (tx, wallet, baseId) => {
      await original(tx, wallet, baseId);
      await tx.execute(sql`set constraints all immediate`);
      await tx.execute(sql`update ledger_transactions set metadata='{}' where type='base.free_purchase' and metadata->>'purchasedBaseId'=${baseId}`);
    });
    await expect(purchaseFreeBase(f.conn.db, f.wallet, f.request)).rejects.toMatchObject({ cause: { message: 'FREE_BASE_DEBIT_INVALID' } });
    expect(await f.conn.sql`select wallet from mining_free_base_purchases`).toHaveLength(0);
    expect(await getBaseShardBalance(f.conn.db, f.sourceBaseId)).toBe(BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards));
    // Custody league source guards now precede Charter guards for every ledger writer, including
    // ordinary rewards before enrollment. A stale snapshot must leave no credit.
    await expect(f.conn.db.transaction(async tx => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      await rewardBaseShards(tx, f.sourceBaseId, 1n, 'test.ordinary', 'ordinary-repeatable-read');
    })).rejects.toMatchObject({ cause: { code: 'P0001', message: 'CUSTODY_LEAGUE_READ_COMMITTED_REQUIRED' } });
    expect(await getBaseShardBalance(f.conn.db, f.sourceBaseId)).toBe(BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards));
    expect(await f.conn.sql`select id from ledger_transactions where idempotency_key='ordinary-repeatable-read'`).toHaveLength(0);
    await rewardBaseShards(f.conn.db, f.sourceBaseId, 1n, 'test.ordinary', 'ordinary-read-committed');
    expect(await getBaseShardBalance(f.conn.db, f.sourceBaseId)).toBe(BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards) + 1n);
  }));
  it('rejects an account identity rewrite that began while the debit existed but its receipt was still uncommitted', async () => fixture(async f => {
    const original = baseSetup.initializePurchasedFreeBase;
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; }), finish = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(baseSetup, 'initializePurchasedFreeBase').mockImplementationOnce(async (tx, wallet, baseId) => {
      await original(tx, wallet, baseId); reached(); await finish;
    });
    const [account] = await f.conn.sql`select id from accounts where base_id=${f.sourceBaseId} and kind='base_shards'`;
    const attack = postgres(f.databaseUrl, { max: 1, onnotice: () => {} });
    const [backend] = await attack`select pg_backend_pid() as pid`;
    await attack`set statement_timeout='5s'`;
    const purchase = purchaseFreeBase(f.conn.db, f.wallet, f.request);
    await ready;
    const mutation = attack`update accounts set currency='GEMS' where id=${account!.id}`;
    const refused = expect(mutation).rejects.toThrow('FREE_BASE_DEBIT_IMMUTABLE');
    try {
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 20 && !blocked; attempt++) {
          const [state] = await f.conn.sql`select cardinality(pg_blocking_pids(${backend!.pid}))>0 as blocked`;
          blocked = state!.blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      } finally { release(); await purchase; await refused; }
    } finally { await attack.end(); }
    expect((await f.conn.sql`select currency from accounts where id=${account!.id}`)[0]!.currency).toBe('SHARDS');
  }));
  it('refuses an extra leg when a repeatable-read snapshot predates the purchase transaction', async () => fixture(async f => {
    const [account] = await f.conn.sql`select id from accounts where base_id=${f.sourceBaseId} and kind='base_shards'`;
    await expect(f.conn.sql.begin(async stale => {
      await stale`set transaction isolation level repeatable read`;
      await stale`select count(*) from ledger_transactions`;
      const receipt = await purchaseFreeBase(f.conn.db, f.wallet, f.request);
      // The attacker still cannot see the newly committed receipt. The newer
      // league guard must reject this writer before the debit guard reads it.
      expect(await stale`select base_id from mining_free_base_purchases where base_id=${receipt.baseId}`).toHaveLength(0);
      await stale`insert into ledger_entries(txn_id,account_id,delta,balance_after)
        values(${receipt.debitTransactionId},${account!.id},1,1)`;
    })).rejects.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_READ_COMMITTED_REQUIRED' });
    const receipt = await getFreeBasePurchase(f.conn.db, f.wallet, f.request.idempotencyKey);
    expect(await f.conn.sql`select id from ledger_entries where txn_id=${receipt!.debitTransactionId}`).toHaveLength(2);
  }));
});
