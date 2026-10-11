/** GREEN-only S3 counterexamples. The three original RED files remain intact. */
import { CAMPAIGN, CLANS, LOOT, PHASE_E_POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bases, baseRaidLocks, baseSlots, raids } from '../src/db/schema';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { createClanCharterReconciliation } from '../src/game/clanCharterReconciliation';
import { createCampaignRaid, submitOrders } from '../src/game/raids';
import { reserveDeedRaidLoot, settleDeedRaidLoot } from '../src/game/raidLoot';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { raidChestFixture, raidChestKey, raidChestPg, type RaidChestFixture } from './fixtures/clanCharterRaidChest';

let f: RaidChestFixture;
beforeEach(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false');
  f = raidChestFixture(); await f.setup();
}, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); }, 120_000);
const expectProof = (error: unknown) => expect(raidChestPg(error))
  .toEqual({ code: 'P0001', message: 'CLAN_CHARTER_RAID_CHEST_PROOF' });

it('raw balanced loot and terminal writes cannot bypass the missing or wrong original-clan attribution', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  const otherLeader = await f.funded(), other = await f.clan(otherLeader.wallet);
  const rule = await f.initialize(), raid = await f.admit(a.wallet, d.wallet);
  const att = await getOrCreatePlayerAccount(f.db, a.wallet, 'player_shards');
  const def = await getOrCreatePlayerAccount(f.db, d.wallet, 'player_shards'), sys = await bootstrapSystemAccounts(f.db);
  const before = await f.money(), gross = BigInt(rule.basisPoints), cut = BigInt(rule.titheBps);
  for (const destination of [null, other.id]) {
    let reached = false;
    const error = await f.db.transaction(async tx => {
      await tx.execute(sql`update raids set status='resolving' where id=${raid.id}`);
      const p = await postTransaction(tx, { idempotencyKey: `raid:${raid.id}:loot`, type: 'raid.loot',
        entries: [{ account: def.id, delta: -gross }, { account: att.id, delta: gross - cut }, { account: sys.clan_chest, delta: cut }],
        metadata: { raidId: raid.id, attacker: a.wallet, defender: d.wallet, clanChest: String(cut) } });
      if (destination) await tx.execute(sql`update clans set chest_shards=chest_shards+${cut} where id=${destination}`);
      await tx.execute(sql`update raids set status='resolved',resolved_at=now(),result=jsonb_build_object('lootShards',${String(gross-cut)}::numeric) where id=${raid.id}`);
      const [check] = await tx.execute<{ n: number; terminal: boolean }>(sql`
        select (select count(*)::int from ledger_entries where txn_id=${p.transaction.id}) n,
        exists(select 1 from clan_charter_raid_terminals where raid_id=${raid.id}) terminal`);
      expect(check).toEqual({ n: 3, terminal: true }); reached = true;
      // Intentionally no TypeScript assertion: commit must enforce completeness.
    }).catch(error => error);
    expect(reached).toBe(true); expectProof(error); expect(await f.money()).toEqual(before);
    expect(await f.sql`select chest_shards::text from clans where id in (${c.id},${other.id})`).toEqual([{ chest_shards: '0' }, { chest_shards: '0' }]);
    expect(await f.entries(raid.id)).toHaveLength(0);
  }
  await f.settle(raid.id, gross); expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled' });
});

it('rejects an owner TEMP forged nonnegative before-clan witness without an actual clan increment', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  const sys = await bootstrapSystemAccounts(f.db), opening = BigInt(CLANS.chestTitheBps) * 2n;
  await f.db.transaction(async tx => {
    await postTransaction(tx, { idempotencyKey: raidChestKey(), type: 'test.raid-chest.backed-opening',
      entries: [{ account: sys.shard_genesis, delta: -opening }, { account: sys.clan_chest, delta: opening }] });
    await tx.execute(sql`update clans set chest_shards=${opening} where id=${c.id}`);
  });
  const rule = await f.initialize(), raid = await f.admit(a.wallet, d.wallet);
  const att = await getOrCreatePlayerAccount(f.db, a.wallet, 'player_shards'), def = await getOrCreatePlayerAccount(f.db, d.wallet, 'player_shards');
  const before = await f.money(), heads = await f.sql`select * from clan_charter_raid_chest_heads`;
  let reached = false;
  const error = await f.db.transaction(async tx => {
    await tx.execute(sql`update raids set status='resolving' where id=${raid.id}`);
    const gross = BigInt(rule.basisPoints), cut = BigInt(rule.titheBps);
    const p = await postTransaction(tx, { idempotencyKey: `raid:${raid.id}:loot`, type: 'raid.loot',
      entries: [{ account: def.id, delta: -gross }, { account: att.id, delta: gross-cut }, { account: sys.clan_chest, delta: cut }],
      metadata: { raidId: raid.id, attacker: a.wallet, defender: d.wallet, clanChest: String(cut) } });
    expect((await tx.execute<{ n: number }>(sql`select count(*)::int n from ledger_entries where txn_id=${p.transaction.id}`))[0]?.n).toBe(3);
    expect((await tx.execute<{ chest: string }>(sql`select chest_shards::text chest from clans where id=${c.id}`))[0]?.chest).toBe(String(opening));
    await tx.execute(sql`create temporary table b6p_fake_credit(ledger_id uuid,clan_id uuid,cut bigint) on commit drop`);
    await tx.execute(sql.raw(`create function pg_temp.b6p_fake_credit() returns trigger language plpgsql as $$
      declare current_clan jsonb;source uuid;begin
       select to_jsonb(c) into current_clan from public.clans c where c.id=new.clan_id;
       select source_id into source from public.clan_charter_loot_posts where ledger_id=new.ledger_id;
       insert into public.clan_charter_chest_updates(id,source_id,actual_clan_id,tx_key,before_clan,after_clan,delta,pairing,candidate_ledger_ids,ledger_id)
       values(gen_random_uuid(),source,new.clan_id,pg_current_xact_id()::text,
        jsonb_set(current_clan,'{chest_shards}',to_jsonb((current_clan->>'chest_shards')::bigint-new.cut)),
        current_clan,new.cut,'matched',array[new.ledger_id],new.ledger_id);return new;end $$`));
    await tx.execute(sql`create trigger b6p_fake_credit after insert on b6p_fake_credit for each row execute function pg_temp.b6p_fake_credit()`);
    reached = true;
    await tx.execute(sql`insert into b6p_fake_credit values(${p.transaction.id},${c.id},${cut})`);
  }).catch(error => error);
  expect(reached).toBe(true); expectProof(error); expect(await f.money()).toEqual(before);
  expect(await f.sql`select * from clan_charter_raid_chest_heads`).toEqual(heads);
  expect(await f.sql`select chest_shards::text from clans where id=${c.id}`).toEqual([{ chest_shards: String(opening) }]);
  expect(await f.sql`select * from clan_charter_chest_updates`).toHaveLength(0);
});

it('cannot reuse an earlier positive witness after a same-transaction A-to-B-to-A-to-B snapshot cycle', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  const rule = await f.initialize(), raid = await f.admit(a.wallet, d.wallet), before = await f.money();
  let reached = false;
  const error = await f.db.transaction(async tx => {
    await f.settlement(tx, raid.id, BigInt(rule.basisPoints));
    const [first] = await tx.execute<{ revision: string }>(sql`select revision::text from clan_charter_raid_chest_heads where clan_id=${c.id}`);
    expect(first?.revision).toBe('1');
    await tx.execute(sql`update clans set chest_shards=chest_shards-${rule.titheBps} where id=${c.id}`);
    expect((await tx.execute<{ revision: string }>(sql`select revision::text from clan_charter_raid_chest_heads where clan_id=${c.id}`))[0]?.revision).toBe('2');
    reached = true;
    await tx.execute(sql`update clans set chest_shards=chest_shards+${rule.titheBps} where id=${c.id}`);
  }).catch(error => error);
  expect(reached).toBe(true); expectProof(error); expect(await f.money()).toEqual(before);
  expect(await f.sql`select revision::text from clan_charter_raid_chest_heads where clan_id=${c.id}`).toEqual([{ revision: '0' }]);
  expect(await f.entries(raid.id)).toHaveLength(0);
});

it('uses the immutable captured rate when the current runtime rate changes after admission', async () => {
  const a = await f.attacker(); await f.clan(a.wallet); const d = await f.defender();
  const rule = await f.initialize(), raid = await f.admit(a.wallet, d.wallet);
  const descriptor = Object.getOwnPropertyDescriptor(CLANS, 'chestTitheBps')!;
  try {
    Object.defineProperty(CLANS, 'chestTitheBps', { ...descriptor, value: rule.titheBps + 1 });
    expect(CLANS.chestTitheBps).not.toBe(rule.titheBps);
    expect(await f.service().initializeRule()).toEqual(rule);
    expect(await f.settle(raid.id, BigInt(rule.basisPoints))).toMatchObject({ chestCut: BigInt(rule.titheBps) });
    expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled', ruleId: rule.id, chestShards: String(rule.titheBps) });
    expect(await createClanCharterReconciliation(f.db).read(raid.id)).toMatchObject({ status: 'reconciled', chestShards: String(rule.titheBps) });
  } finally { Object.defineProperty(CLANS, 'chestTitheBps', descriptor); }
});

it('actual campaign completion retains the full untaxed first-three-star reward under the new rule', async () => {
  const a = await f.attacker('turrider'), c = await f.clan(a.wallet); await f.initialize();
  const raid = await createCampaignRaid(f.db, a.wallet, 1, raidChestKey());
  const before = (await getOrCreatePlayerAccount(f.db, a.wallet, 'player_shards')).balance;
  const { result } = await submitOrders(f.db, a.wallet, raid.id, { idempotencyKey: raidChestKey(), deploys: [
    { troop: 'turrider', tx: 6, ty: 14, tMs: 0 }, { troop: 'turrider', tx: 23, ty: 14, tMs: 0 },
    { troop: 'turrider', tx: 14, ty: 6, tMs: 0 }, { troop: 'turrider', tx: 14, ty: 23, tMs: 0 }] });
  expect(result.stars).toBe(3);
  const expected = BigInt(CAMPAIGN.firstThreeStarShardsByKeep[CAMPAIGN.encounters[0]!.keepLevel-1]!);
  expect((await getOrCreatePlayerAccount(f.db, a.wallet, 'player_shards')).balance-before).toBe(expected);
  expect(await f.sql`select chest_shards::text from clans where id=${c.id}`).toEqual([{ chest_shards: '0' }]);
  expect(await f.entries(raid.id)).toHaveLength(0);
  expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled', originalClanId: c.id, chestShards: '0' });
});

it('actual deed-PvP reservation and settlement remain untaxed under an original-clan rule', async () => {
  const a = await f.funded(), c = await f.clan(a.wallet), d = await f.funded();
  const [att] = await f.db.insert(bases).values({ ownerWallet: a.wallet, status: 'active' }).returning();
  const [def] = await f.db.insert(bases).values({ ownerWallet: d.wallet, status: 'active' }).returning();
  await f.db.insert(baseSlots).values([{ wallet: a.wallet, slot: 1, baseId: att!.id }, { wallet: d.wallet, slot: 1, baseId: def!.id }]);
  const opening = BigInt(PHASE_E_POLICY.basisPoints);
  await rewardBaseShards(f.db, def!.id, opening, 'test.raid-chest.deed-opening', raidChestKey());
  await f.initialize(); const now = new Date();
  // Synthetic battle input; actual paid reservation/settlement services and
  // their canonical ledger sources run here. No simulator/authority claim.
  const [raid] = await f.db.insert(raids).values({ attackerWallet: a.wallet, attackerBaseId: att!.id,
    defenderWallet: d.wallet, defenderBaseId: def!.id, seed: 1n, snapshot: { buildings: [] }, armySnapshot: {},
    idempotencyKey: raidChestKey(), ordersDeadlineAt: new Date(now.getTime()+120_000) }).returning();
  await f.db.insert(baseRaidLocks).values({ baseId: def!.id, raidId: raid!.id, expiresAt: new Date(now.getTime()+180_000) });
  const expected = opening * BigInt(LOOT.balanceLootableBps) / BigInt(PHASE_E_POLICY.basisPoints);
  expect(await reserveDeedRaidLoot(f.db, { raidId: raid!.id, attackerBaseId: att!.id, defenderBaseId: def!.id, now }))
    .toEqual({ balancePool: expected, mines: 0n, maximum: expected });
  await f.db.transaction(async tx => {
    await tx.execute(sql`update raids set status='resolving' where id=${raid!.id}`);
    const paid = await settleDeedRaidLoot(tx, raid!.id, 3, [], now);
    expect(paid.total).toBe(expected);
    await tx.execute(sql`update raids set status='resolved',resolved_at=now(),result=jsonb_build_object('lootShards',${String(paid.total)}::numeric) where id=${raid!.id}`);
  });
  expect(await getBaseShardBalance(f.db, att!.id)).toBe(expected);
  expect(await getBaseShardBalance(f.db, def!.id)).toBe(opening-expected);
  expect(await f.entries(raid!.id)).toHaveLength(0);
  expect(await f.sql`select chest_shards::text from clans where id=${c.id}`).toEqual([{ chest_shards: '0' }]);
  expect(await f.service().read(raid!.id)).toMatchObject({ status: 'reconciled', originalClanId: c.id, chestShards: '0' });
});
