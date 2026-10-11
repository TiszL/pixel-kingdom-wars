/** Real Workshop output backs pending commitments; no mining award is implied. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FORGE_INGOT } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { baseItems, bases, baseSlots, buildings } from '../src/db/schema';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { collectRefine, getWorkshopView, startRefine } from '../src/game/workshop';
import { reservePendingMiningIngots, abortPendingMiningEpoch, getMiningIngotReservation } from '../src/game/miningIngotReservations';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db, at = new Date('2035-01-01T00:00:00Z');
beforeAll(() => { vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('FORGE_INGOTS_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); });
afterAll(async () => { vi.unstubAllEnvs(); await conn.sql.end(); });
const context = (baseId: string) => ({ baseId, assertAuthority: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], wallet: string, id: string) => { await assertFreshLockedBaseAuthority(tx, wallet, id, at); } });
async function fixture(quantity = 3, wallet?: string, slot = 1) {
  wallet ??= (await createTestPlayer(db)).wallet;
  const [base] = await db.insert(bases).values({ ownerWallet: wallet }).returning();
  const baseId = base!.id;
  await db.insert(baseSlots).values({ wallet, baseId, slot });
  await db.insert(buildings).values({ playerWallet: wallet, baseId, type: 'workshop', level: 1, tx: 20, ty: 20 });
  await rewardBaseShards(db, baseId, BigInt(FORGE_INGOT.shardsPerIngot) * 100n, 'test.ingot.fund', randomUUID());
  const job = await startRefine(db, wallet, baseId, quantity, FORGE_INGOT.recipeVersion, randomUUID(), at, context(baseId));
  const ready = new Date(job.readyAt);
  await collectRefine(db, wallet, baseId, job.jobId, randomUUID(), ready, context(baseId));
  const body = { epochKey: randomUUID(), baseId, ingots: quantity, idempotencyKey: randomUUID() };
  return { wallet, baseId, body, ready, job, reserve: () => reservePendingMiningIngots(db, wallet!, body, context(baseId), ready) };
}
const qty = async (id: string) => (await conn.sql`select qty from base_items where base_id=${id} and item_id='forge_ingot'`)[0]!.qty;

describe('pending mining ingot reservations', () => {
  it('preserves pending custody and source guards when its migration repeats', async () => {
    const f = await fixture(1), receipt = await f.reserve();
    const migration = readFileSync(new URL('../drizzle/0160_mining_ingot_reservations.sql', import.meta.url), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      await conn.sql.begin(async tx => {
        for (const statement of migration.split('--> statement-breakpoint').filter(s => s.trim())) await tx.unsafe(statement);
      });
    }
    expect(await f.reserve()).toEqual(receipt);
    expect(await qty(f.baseId)).toBe(0);
    expect(await conn.sql`select * from mining_ingot_reservations where id=${receipt.id}`).toHaveLength(1);
    await expect(conn.sql`update ledger_transactions set metadata='{}' where id=(select debit_ledger_txn_id from workshop_jobs where base_id=${f.baseId})`)
      .rejects.toThrow('MINING_INGOT_RECEIPT_IMMUTABLE');
    await expect(conn.sql`truncate ledger_entries cascade`).rejects.toThrow('MINING_INGOT_RECEIPT_IMMUTABLE');
  });

  it('reserves real earned output, counts it against storage, and recovers one whole-epoch abort while paused', async () => {
    const f = await fixture(), before = await getWorkshopView(db, f.wallet, f.baseId, f.ready);
    const receipt = await f.reserve(); expect(receipt.authority).toBe('pending'); expect(await qty(f.baseId)).toBe(0);
    const after = await getWorkshopView(db, f.wallet, f.baseId, f.ready);
    expect(after.allowance.holding.reserved).toBe(3); expect(after.holding.reserved).toBe(3);
    expect(after.allowance.holding.remaining).toBe(before.allowance.holding.remaining);
    expect(await f.reserve()).toEqual(receipt);
    await expect(reservePendingMiningIngots(db, f.wallet, { ...f.body, ingots: 1 }, context(f.baseId), f.ready)).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    try {
      expect(await f.reserve()).toEqual(receipt);
      await expect(reservePendingMiningIngots(db, f.wallet, { ...f.body, idempotencyKey: randomUUID() }, context(f.baseId), f.ready)).rejects.toMatchObject({ code: 'PHASE_E_DISABLED' });
      const request = { epochId: receipt.epochId, decisionKey: randomUUID(), reason: 'fixture-abort-no-allocation' };
      const [returned, duplicate] = await Promise.all([abortPendingMiningEpoch(db, request, f.ready), abortPendingMiningEpoch(db, request, f.ready)]);
      expect(duplicate).toEqual(returned);
      expect(await abortPendingMiningEpoch(db, request, f.ready)).toEqual(returned); expect(await qty(f.baseId)).toBe(3);
      expect((await getWorkshopView(db, f.wallet, f.baseId, f.ready)).allowance.holding.remaining).toBe(before.allowance.holding.remaining);
    } finally { vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); }
  });
  it('serializes concurrent overdraw and binds keys to the original actor/body', async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled([f.reserve(), reservePendingMiningIngots(db, f.wallet, { ...f.body, idempotencyKey: randomUUID() }, context(f.baseId), f.ready)]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(await qty(f.baseId)).toBe(0);
  });
  it('returns to the original base after transfer/inactivation and exposes only historical receipt facts', async () => {
    const f = await fixture(), receipt = await f.reserve(), buyer = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    await db.update(baseSlots).set({ wallet: buyer.wallet, active: false }).where(eq(baseSlots.baseId, f.baseId));
    const historical = await getMiningIngotReservation(db, f.wallet, f.body.idempotencyKey);
    expect(historical).toEqual(receipt); expect(historical).not.toHaveProperty('held');
    expect(await getMiningIngotReservation(db, buyer.wallet, f.body.idempotencyKey)).toBeNull();
    await abortPendingMiningEpoch(db, { epochId: receipt.epochId, decisionKey: randomUUID(), reason: 'fixture-abort' }, f.ready);
    expect(await qty(f.baseId)).toBe(3);
  });
  it('counts reservations on inactive free bases across the wallet allowance', async () => {
    const f = await fixture(), receipt = await f.reserve(), other = await fixture(1, f.wallet, 2);
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId));
    expect((await getWorkshopView(db, f.wallet, other.baseId, other.ready)).allowance.holding.reserved).toBe(3);
    await abortPendingMiningEpoch(db, { epochId: receipt.epochId, decisionKey: randomUUID(), reason: 'fixture-abort' }, f.ready);
    expect((await getWorkshopView(db, f.wallet, other.baseId, other.ready)).allowance.holding.held).toBe(4);
  });
  it('refuses unbacked stock and rolls admission/debit back on failure', async () => {
    const f = await fixture();
    await db.update(baseItems).set({ qty: 4 }).where(eq(baseItems.baseId, f.baseId));
    await expect(f.reserve()).rejects.toThrow(); expect(await qty(f.baseId)).toBe(4);
    expect(await conn.sql`select * from mining_ingot_admissions where base_id=${f.baseId}`).toHaveLength(0);
  });
  it('rejects forged deltas, forged return receipts, immutable rewrites and unsealed partial aborts', async () => {
    const f = await fixture(), receipt = await f.reserve();
    const stranger = await createTestPlayer(db);
    await expect(conn.sql`insert into mining_ingot_reservations(id,epoch_id,base_id,actor_wallet,idempotency_key,qty,created_at)
      values(${randomUUID()},${receipt.epochId},${f.baseId},${stranger.wallet},${randomUUID()},1,${f.ready.toISOString()})`).rejects.toThrow('MINING_INGOT_CUSTODY_INVALID');
    await expect(conn.sql`insert into mining_ingot_reservations(id,epoch_id,base_id,actor_wallet,idempotency_key,qty,created_at)
      values(${randomUUID()},${receipt.epochId},${f.baseId},${f.wallet},${randomUUID()},1,${f.ready.toISOString()})`).rejects.toThrow('MINING_INGOT_CONSERVATION');
    await expect(conn.sql`update base_items set qty=qty+1 where base_id=${f.baseId} and item_id='forge_ingot'`).rejects.toThrow();
    await expect(conn.sql`delete from mining_ingot_reservations where id=${receipt.id}`).rejects.toThrow();
    await expect(conn.sql`insert into mining_ingot_aborts(epoch_id,decision_key,reason,created_at) values(${receipt.epochId},${randomUUID()},'forged-partial',${f.ready.toISOString()})`).rejects.toThrow('MINING_ABORT_INCOMPLETE');
    await expect(conn.sql`insert into mining_ingot_releases(reservation_id,abort_epoch_id,created_at) values(${receipt.id},${receipt.epochId},${f.ready.toISOString()})`).rejects.toThrow();
    expect(await qty(f.baseId)).toBe(0);
  });
  it('retains every paid receipt leg and account identity after admission, including moved-in legs', async () => {
    const f = await fixture(); await f.reserve();
    const [job] = await conn.sql`select debit_ledger_txn_id id from workshop_jobs where id=${f.job.jobId}`;
    const entries = await conn.sql`select * from ledger_entries where txn_id=${job!.id} order by delta`;
    const debit = entries[0]!, credit = entries[1]!;
    const other = randomUUID();
    await conn.sql`insert into ledger_transactions(id,idempotency_key,type) values(${other},${randomUUID()},'test.unrelated')`;
    const [unrelated] = await conn.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${other},${credit.account_id},0,0) returning id`;
    const attempts = [
      () => conn.sql`update ledger_transactions set metadata='{}'::jsonb where id=${job!.id}`,
      () => conn.sql`update ledger_transactions set type='forged' where id=${job!.id}`,
      () => conn.sql`update ledger_transactions set idempotency_key=${randomUUID()} where id=${job!.id}`,
      () => conn.sql`update ledger_entries set delta=delta+1 where id=${debit.id}`,
      () => conn.sql`update ledger_entries set account_id=${credit.account_id} where id=${debit.id}`,
      () => conn.sql`update ledger_entries set txn_id=${other} where id=${debit.id}`,
      () => conn.sql`update ledger_entries set txn_id=${job!.id} where id=${unrelated!.id}`,
      () => conn.sql`delete from ledger_entries where id=${credit.id}`,
      () => conn.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${job!.id},${credit.account_id},0,0)`,
      () => conn.sql`update accounts set currency='KEEP' where id=${debit.account_id}`,
      () => conn.sql`update accounts set kind='base_forge_escrow' where id=${debit.account_id}`,
      () => conn.sql`update accounts set owner_wallet=${f.wallet} where id=${debit.account_id}`,
      () => conn.sql`update accounts set base_id=null where id=${debit.account_id}`,
      () => conn.sql`update accounts set id=${randomUUID()} where id=${debit.account_id}`,
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow('MINING_INGOT_RECEIPT_IMMUTABLE');
    expect(await conn.sql`select * from ledger_entries where txn_id=${job!.id} order by delta`).toEqual(entries);
    // Unrelated receipts and ordinary balances remain writable.
    await conn.sql`update ledger_transactions set metadata='{"unrelated":true}'::jsonb where id=${other}`;
    await rewardBaseShards(db, f.baseId, 1n, 'test.ingot.topup', randomUUID());
  });
  it('rejects receipt edits before or after admission in the same transaction and rejects stale isolation', async () => {
    const f = await fixture();
    const [job] = await conn.sql`select debit_ledger_txn_id id from workshop_jobs where id=${f.job.jobId}`;
    await expect(conn.sql.begin(async tx => {
      await tx`update ledger_transactions set metadata='{}'::jsonb where id=${job!.id}`;
      await tx`insert into mining_ingot_admissions(base_id) values(${f.baseId})`;
    })).rejects.toThrow('MINING_INGOT_SOURCE_INVALID');
    await expect(conn.sql.begin(async tx => {
      await tx`insert into mining_ingot_admissions(base_id) values(${f.baseId})`;
      await tx`update ledger_transactions set metadata='{}'::jsonb where id=${job!.id}`;
    })).rejects.toThrow('MINING_INGOT_RECEIPT_IMMUTABLE');
    await expect(conn.sql.begin(async tx => {
      await tx`set transaction isolation level repeatable read`;
      await tx`insert into mining_ingot_admissions(base_id) values(${f.baseId})`;
    })).rejects.toThrow('MINING_INGOT_READ_COMMITTED_REQUIRED');
    expect(await conn.sql`select * from mining_ingot_admissions where base_id=${f.baseId}`).toHaveLength(0);
    // No admission means no change to the legacy receipt contract.
    await conn.sql.begin(async tx => {
      const [prior] = await tx`select metadata from ledger_transactions where id=${job!.id}`;
      await tx`update ledger_transactions set metadata='{}'::jsonb where id=${job!.id}`;
      await tx`update ledger_transactions set metadata=${JSON.stringify(prior!.metadata)}::jsonb where id=${job!.id}`;
    });
  });
  it('serializes an in-flight admission before permitting any concurrent evidence mutation', async () => {
    const f = await fixture();
    const [job] = await conn.sql`select debit_ledger_txn_id id from workshop_jobs where id=${f.job.jobId}`;
    let admitted!: () => void, finish!: () => void, pid = 0;
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    const admission = conn.sql.begin(async tx => {
      await tx`select id from bases where id=${f.baseId} for update`;
      await tx`insert into mining_ingot_admissions(base_id) values(${f.baseId})`;
      admitted(); await release;
    }).then(() => null, error => error as Error);
    await ready;
    const mutation = conn.sql.begin(async tx => {
      pid = Number((await tx`select pg_backend_pid() pid`)[0]!.pid);
      await tx`update ledger_transactions set metadata='{}'::jsonb where id=${job!.id}`;
    }).then(() => null, error => error as Error);
    try {
      await vi.waitFor(async () => {
        expect(pid).toBeGreaterThan(0);
        expect((await conn.sql`select wait_event_type from pg_stat_activity where pid=${pid}`)[0]?.wait_event_type).toBe('Lock');
      }, { timeout: 2_000 });
    } finally { finish(); await admission; }
    expect(await admission).toBeNull();
    expect((await mutation)?.message).toContain('MINING_INGOT_RECEIPT_IMMUTABLE');
  });
  it('collects and reserves new real Workshop output after admission without blocking balance updates', async () => {
    const f = await fixture(); await f.reserve();
    const later = new Date(f.ready.getTime() + 86_400_000);
    const job = await startRefine(db, f.wallet, f.baseId, 1, FORGE_INGOT.recipeVersion, randomUUID(), later, context(f.baseId));
    const ready = new Date(job.readyAt);
    await collectRefine(db, f.wallet, f.baseId, job.jobId, randomUUID(), ready, context(f.baseId));
    expect(await qty(f.baseId)).toBe(1);
    await reservePendingMiningIngots(db, f.wallet, { ...f.body, idempotencyKey: randomUUID(), ingots: 1 }, context(f.baseId), ready);
    expect(await qty(f.baseId)).toBe(0);
    expect((await getWorkshopView(db, f.wallet, f.baseId, ready)).holding.reserved).toBe(4);
  });
  it('returns the full pending epoch after transfer even when the buyer is already at capacity', async () => {
    const source = await fixture(), receipt = await source.reserve(), buyer = await fixture();
    let clock = buyer.ready;
    const initial = await getWorkshopView(db, buyer.wallet, buyer.baseId, clock);
    let held = await qty(buyer.baseId);
    while (held < initial.allowance.holding.cap) {
      clock = new Date(clock.getTime() + 86_400_000);
      const amount = Math.min(initial.allowance.daily.cap, initial.batch.size, initial.allowance.holding.cap - held);
      const job = await startRefine(db, buyer.wallet, buyer.baseId, amount, FORGE_INGOT.recipeVersion, randomUUID(), clock, context(buyer.baseId));
      clock = new Date(job.readyAt);
      await collectRefine(db, buyer.wallet, buyer.baseId, job.jobId, randomUUID(), clock, context(buyer.baseId));
      held += amount;
    }
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, source.baseId));
    await db.update(baseSlots).set({ wallet: buyer.wallet, slot: 2, active: false }).where(eq(baseSlots.baseId, source.baseId));
    const before = (await getWorkshopView(db, buyer.wallet, buyer.baseId, clock)).allowance.holding;
    expect(before.held).toBe(before.cap); expect(before.reserved).toBe(source.body.ingots);
    await abortPendingMiningEpoch(db, { epochId: receipt.epochId, decisionKey: randomUUID(), reason: 'fixture-abort-after-transfer' }, clock);
    const after = (await getWorkshopView(db, buyer.wallet, buyer.baseId, clock)).allowance.holding;
    expect(after.held).toBe(before.cap + source.body.ingots); expect(after.reserved).toBe(0); expect(after.remaining).toBe(0);
    expect(await qty(source.baseId)).toBe(source.body.ingots);
    await expect(startRefine(db, buyer.wallet, buyer.baseId, 1, FORGE_INGOT.recipeVersion, randomUUID(), new Date(clock.getTime() + 86_400_000), context(buyer.baseId)))
      .rejects.toMatchObject({ code: 'HOLDING_CAP_EXCEEDED' });
  });
  it('refuses source TRUNCATE after admission without erasing immutable custody', async () => {
    const f = await fixture(); await f.reserve();
    for (const table of ['ledger_entries', 'ledger_transactions', 'accounts', 'workshop_jobs', 'base_items']) {
      await expect(conn.sql.unsafe(`truncate table ${table} cascade`)).rejects.toThrow(table === 'ledger_entries' || table === 'workshop_jobs' || table === 'base_items' ? 'MINING_INGOT_RECEIPT_IMMUTABLE' : undefined);
    }
    expect(await qty(f.baseId)).toBe(0);
    expect(await getMiningIngotReservation(db, f.wallet, f.body.idempotencyKey)).not.toBeNull();
  });
  it('rejects a broadly granted runtime principal and spoofed GUC authority', async () => {
    const f = await fixture(); await f.reserve();
    const [job] = await conn.sql`select debit_ledger_txn_id id from workshop_jobs where id=${f.job.jobId}`;
    const role = `ingot_runtime_${randomUUID().replaceAll('-', '')}`;
    await conn.sql.unsafe(`create role ${role}`);
    try {
      await conn.sql.unsafe(`grant usage on schema public to ${role}`);
      await conn.sql.unsafe(`grant select,insert,update,delete on all tables in schema public to ${role}`);
      await expect(conn.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select set_config('shardkeep.deed_economy_writer','v1',true)`;
        await tx`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${randomUUID()},${randomUUID()},${at.toISOString()})`;
      })).rejects.toThrow('MINING_INGOT_OWNER_REQUIRED');
      await expect(conn.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select set_config('shardkeep.deed_economy_writer','v1',true)`;
        await tx`update ledger_transactions set metadata='{}'::jsonb where id=${job!.id}`;
      })).rejects.toThrow('MINING_INGOT_RECEIPT_IMMUTABLE');
    } finally { await conn.sql.unsafe(`drop owned by ${role}`); await conn.sql.unsafe(`drop role ${role}`); }
  });
});
