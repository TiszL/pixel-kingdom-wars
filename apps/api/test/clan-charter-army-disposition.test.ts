/** Real admission, troop consumption and submitOrders compensation. Only chain
 * creation/ownership uses the existing declared encoded-bank fixture. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { charterSalesRaidFixture, type CharterSalesRaidFixture } from './fixtures/charterSalesRaid';
import { captureCharterArmyChange } from '../src/game/clanCharterRaidDisposition';
import { compensatePendingRaid, createRaid, type RaidBaseAuthority } from '../src/game/raids';
import { consumeArmy, consumeBaseArmy } from '../src/game/army';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { postgresLeaf } from './fixtures/charterPermitInventory';

let f: CharterSalesRaidFixture | undefined;
beforeEach(async () => { f = await charterSalesRaidFixture(); }, 120000);
afterEach(async () => { const closing = f; f = undefined; try { await closing?.dispose(); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); } }, 120000);

it('captures real depletion between two admitted raids and permits the original paid member frontier with the scouting ante intact', async () => {
 const c = f!, first = await c.raid(), second = await c.raid();
 await c.resolve(first); const before = await c.money();
 await expect(c.resolve(second)).rejects.toMatchObject({ code: 'RAID_ARMY_CHANGED' });
 expect(await c.money()).toEqual(before);
 const [record] = await c.sql`select * from charter_army_dispositions where raid_id=${second.value.id}`;
 expect(record).toMatchObject({ actor: c.birth.actor.wallet, requested: { highlander: 1 } });
 expect(record!.army).toContainEqual({ player_wallet: c.birth.actor.wallet, troop: 'highlander', count: 0 });
 const paid = await c.pay(), [proof] = await c.sql`select shardkeep_charter_sale_clearance(${paid.accepted.original.id}::uuid) value`;
 const raidProof = proof!.value.raids.find((r: { admission: { raid_id: string } }) => r.admission.raid_id === second.value.id);
 expect(raidProof.classification).toBe('army-changed-retained'); expect(raidProof.disposition).toMatchObject({ raid_id: second.value.id, requested: { highlander: 1 } });
 expect(await c.sql`select id from ledger_transactions where idempotency_key=${'raid-ante-refund:' + second.value.id}`).toHaveLength(0);
 const saved = await c.store().read(c.buyer.wallet, paid.accepted.original.id);
 expect(saved.memberPayment?.id).toBe(paid.paid.id);
 await expect(c.resolve(second)).rejects.toMatchObject({ message: 'raid already resolved' });
 expect(await c.sql`select * from charter_army_dispositions where raid_id=${second.value.id}`).toEqual([record]);
}, 120000);

it('uses the original deed army despite unrelated wallet troops and preserves the original base-scoped ante', async () => {
 const c = f!;
 // Declared opening camp inventory; admission/consumption/compensation and all
 // subsequent immutable source records use the real stable-base services.
 await c.sql`insert into base_army(base_id,troop,count) values(${c.source.baseId},'highlander',1)`;
 vi.stubEnv('MULTI_BASE_ENABLED', 'true');
 const authority: RaidBaseAuthority = async (wallet, id, lockedDb) => { await assertFreshLockedBaseAuthority(lockedDb ?? c.db, wallet, id); };
 const raid = await createRaid(c.db, c.source.wallet, { defenderWallet: c.buyer.wallet, attackerBaseId: c.source.baseId,
  defenderBaseId: c.buyer.baseId, authorizeAttackerBase: authority, authorizeDefenderBase: authority, idempotencyKey: randomUUID() });
 await consumeBaseArmy(c.db, c.source.baseId, { highlander: 1 });
 expect(await c.sql`select count from army where player_wallet=${c.source.wallet} and troop='highlander'`).toEqual([{ count: 1 }]);
 const before = await c.money();
 // Base PvP uses the live command protocol, so this source-scope case calls
 // the real internal compensation writer with an explicit fixture lease. It
 // does not rewrite the admitted mode or pretend to be a batch HTTP journey.
 const lease = randomUUID(); await c.sql`update raids set simulation_lease_token=${lease} where id=${raid.id}`;
 expect(await compensatePendingRaid(c.db, { id: raid.id, attackerWallet: c.source.wallet, simVersion: raid.simVersion }, false, lease, false, { highlander: 1 })).toBe(true);
 const [d] = await c.sql`select * from charter_army_dispositions where raid_id=${raid.id}`;
 expect(d!.army).toEqual([{ base_id: c.source.baseId, troop: 'highlander', count: 0 }]); expect(d!.before_raid.attacker_base_id).toBe(c.source.baseId);
 const proof = (await c.sql`select shardkeep_charter_sale_ante_proof(${raid.id}::uuid,true) value`)[0]!.value;
 expect(proof.classification).toBe('army-changed-retained');
 // Stable-base cancellation also returns the defender's loot reservation;
 // only the original scouting-ante accounts must retain their balances.
 const beforeById = new Map(before.map(r => [r.id, r.balance])), afterById = new Map((await c.money()).map(r => [r.id, r.balance]));
 for (const entry of proof.entries) expect(afterById.get(entry.original_entry.account_id)).toBe(beforeById.get(entry.original_entry.account_id));
 expect(await c.sql`select state from raid_loot_reservations where raid_id=${raid.id}`).toEqual([{ state: 'released' }]);
}, 120000);

it('rejects source tampering, a contradictory refund and same-transaction ante balance changes without partial evidence', async () => {
 const c = f!, raid = await c.raid(), lease = randomUUID();
 await consumeArmy(c.db, c.birth.actor.wallet, { highlander: 1 });
 await c.sql`update raids set simulation_lease_token=${lease} where id=${raid.value.id}`;
 const identity = { id: raid.value.id, attackerWallet: c.birth.actor.wallet, simVersion: raid.value.simVersion };
 const before = await c.money();
 const tampered = await c.db.transaction(async tx => {
  await tx.execute(sql`alter table charter_army_dispositions disable trigger charter_army_dispositions_guard`);
  await captureCharterArmyChange(tx, raid.value.id, c.birth.actor.wallet, lease, { highlander: 1 });
 }).then(() => null, error => error);
 expect(postgresLeaf(tampered)?.message).toBe('CHARTER_ARMY_SOURCE');
 const refunded = await c.db.transaction(async tx => {
  await captureCharterArmyChange(tx, raid.value.id, c.birth.actor.wallet, lease, { highlander: 1 });
  await compensatePendingRaid(tx, identity, false, lease, true);
 }).then(() => null, error => error);
 expect(postgresLeaf(refunded)?.message).toBe('CHARTER_ARMY_TERMINAL');
 const changed = await c.db.transaction(async tx => {
  await compensatePendingRaid(tx, identity, false, lease, false, { highlander: 1 });
  await tx.execute(sql`update accounts set balance=balance+1 where kind='shard_burn'`);
 }).then(() => null, error => error);
 expect(postgresLeaf(changed)?.message).toBe('CHARTER_ARMY_ACCOUNTING');
 expect(await c.sql`select * from charter_army_dispositions`).toHaveLength(0); expect(await c.money()).toEqual(before);
}, 120000);

it('leaves a restored army pending and refuses wrong wallet, lease and quantities without inventing a past shortage', async () => {
 const c = f!, raid = await c.raid(), lease = randomUUID();
 await c.sql`update raids set simulation_lease_token=${lease} where id=${raid.value.id}`;
 const before = await c.money();
 expect(await compensatePendingRaid(c.db, { id: raid.value.id, attackerWallet: c.birth.actor.wallet, simVersion: raid.value.simVersion }, false, lease, false, { highlander: 1 })).toBe(false);
 expect(await c.sql`select status from raids where id=${raid.value.id}`).toEqual([{ status: 'pending_orders' }]);
 for (const [actor, token, counts] of [[c.buyer.wallet, lease, { highlander: 1 }], [c.birth.actor.wallet, randomUUID(), { highlander: 1 }], [c.birth.actor.wallet, lease, { highlander: 2 }]] as const) {
  await expect(c.db.transaction(tx => captureCharterArmyChange(tx, raid.value.id, actor, token, counts))).rejects.toThrow();
 }
 expect(await c.sql`select * from charter_army_dispositions`).toHaveLength(0); expect(await c.money()).toEqual(before);
}, 120000);

it('requires the matching compensation terminal in the same committed transaction and rolls back partial evidence', async () => {
 const c = f!, raid = await c.raid(), lease = randomUUID();
 await consumeArmy(c.db, c.birth.actor.wallet, { highlander: 1 });
 await c.sql`update raids set simulation_lease_token=${lease} where id=${raid.value.id}`;
 const before = await c.money();
 const error = await c.db.transaction(async tx => {
  expect(await captureCharterArmyChange(tx, raid.value.id, c.birth.actor.wallet, lease, { highlander: 1 })).toBe(true);
  await tx.execute(sql`set constraints charter_army_dispositions_complete immediate`);
 }).then(() => null, error => error);
 expect(postgresLeaf(error)?.message).toBe('CHARTER_ARMY_TERMINAL');
 expect(await c.sql`select * from charter_army_dispositions`).toHaveLength(0);
 expect(await c.sql`select status from raids where id=${raid.value.id}`).toEqual([{ status: 'pending_orders' }]); expect(await c.money()).toEqual(before);
}, 120000);
