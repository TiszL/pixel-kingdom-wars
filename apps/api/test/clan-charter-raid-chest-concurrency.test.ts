/** Deterministic lock holders prove refusal, rollback and retry. No timing
 * sleep or live gameplay scheduling is acceptance evidence. */
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { sql, type SQL } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { raidChestFixture, raidChestPg, type RaidChestFixture } from './fixtures/clanCharterRaidChest';

let f: RaidChestFixture;
beforeEach(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false');
  f = raidChestFixture(); await f.setup();
}, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); }, 120_000);
async function lock(statement: SQL) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = f.db.transaction(async tx => { await tx.execute(statement); enter(); await gate; });
  await Promise.race([entered, held.then(() => { throw Error('Lock holder finished before entering'); })]);
  return async () => { release(); await held; };
}

it('rolls actual admission and ordinal back when dissolution holds the clan mutex, then captures once on retry', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  await f.initialize(); const before = await f.money();
  const unlock = await lock(sql`select id from clans where id=${c.id} for update`);
  try {
    const error = await f.admit(a.wallet, d.wallet).catch(error => error);
    expect(raidChestPg(error)?.code).toBe('55P03');
    expect(await f.money()).toEqual(before);
    expect(await f.sql`select * from clan_charter_event_heads where clan_id=${c.id}`).toHaveLength(0);
    expect(await f.sql`select * from clan_charter_raid_events where attacker_wallet=${a.wallet}`).toHaveLength(0);
  } finally { await unlock(); }
  const raid = await f.admit(a.wallet, d.wallet);
  expect(await f.sql`select clan_ordinal::text from clan_charter_raid_events where raid_id=${raid.id}`).toEqual([{ clan_ordinal: '1' }]);
});

it('refuses money-to-clan contention without committing loot and retries the same captured raid', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet), before = await f.money();
  const unlock = await lock(sql`select id from clans where id=${c.id} for update`);
  try {
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='2s'`);
      return f.settlement(tx, raid.id, BigInt(PHASE_E_POLICY.basisPoints));
    })).rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_BUSY' });
    expect(await f.money()).toEqual(before); expect(await f.entries(raid.id)).toHaveLength(0);
    expect(await f.sql`select status from raids where id=${raid.id}`).toEqual([{ status: 'pending_orders' }]);
  } finally { await unlock(); }
  await f.settle(raid.id, BigInt(PHASE_E_POLICY.basisPoints));
  expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled' });
});

it('source hooks holding an account row use NOWAIT for the captured-event mutex and preserve the committed proof', async () => {
  const a = await f.attacker(); await f.clan(a.wallet); const d = await f.defender();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet);
  await f.settle(raid.id, BigInt(PHASE_E_POLICY.basisPoints));
  const proof = await f.service().read(raid.id), entries = await f.entries(raid.id);
  const unlock = await lock(sql`select raid_id from clan_charter_raid_events where raid_id=${raid.id} for update`);
  try {
    const error = await f.db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='2s'`);
      await tx.execute(sql`update accounts set created_at=created_at+interval '1 microsecond' where id=${entries[0]!.account_id}`);
    }).catch(error => error);
    expect(raidChestPg(error)?.code).toBe('55P03');
  } finally { await unlock(); }
  expect(await f.entries(raid.id)).toEqual(entries); expect(await f.service().read(raid.id)).toEqual(proof);
  const error = await f.sql`update accounts set created_at=created_at+interval '1 microsecond' where id=${entries[0]!.account_id}`.catch(error => error);
  expect(raidChestPg(error)).toEqual({ code: 'P0001', message: 'CLAN_CHARTER_RAID_CHEST_PROOF' });
});
