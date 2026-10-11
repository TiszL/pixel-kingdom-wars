/** Source preservation after terminal proof, including after clan dissolution.
 * Exact PostgreSQL errors distinguish these guards from incidental FK failures. */
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { raids } from '../src/db/schema';
import { createClanCharterRaidChest, resolveOriginalClanRaidChest } from '../src/game/clanCharterRaidChest';
import { leaveClan } from '../src/game/clans';
import { rewardShards } from '../src/game/spend';
import { getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { ADMIN_DATABASE_URL } from './db-url';
import { raidChestFixture, raidChestKey, raidChestPg, type RaidChestFixture } from './fixtures/clanCharterRaidChest';

let f: RaidChestFixture;
beforeEach(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false');
  f = raidChestFixture(); await f.setup();
}, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); }, 120_000);
async function refusal(work: Promise<unknown>, message = 'CLAN_CHARTER_RAID_CHEST_PROOF') {
  expect(raidChestPg(await work.catch(error => error))).toEqual({ code: 'P0001', message });
}
async function original(gross = BigInt(PHASE_E_POLICY.basisPoints)) {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  const rule = await f.initialize(), raid = await f.admit(a.wallet, d.wallet);
  const settled = await f.settle(raid.id, gross);
  expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled', ruleId: rule.id });
  return { a, c, d, raid, settled };
}

it('rejects transaction factories and stale RR writes before an unenrolled visibility branch', async () => {
  await expect(f.db.transaction(async tx => createClanCharterRaidChest(tx as unknown as Db)))
    .rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_TOP_LEVEL' });
  const a = await f.attacker(), d = await f.defender(), raid = await f.admit(a.wallet, d.wallet);
  await expect(f.db.transaction(tx => resolveOriginalClanRaidChest(tx, raid.id, a.wallet, 1n),
    { isolationLevel: 'repeatable read' })).rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED' });
  expect(await f.sql`select * from clan_charter_event_source`).toHaveLength(0);
});

it('refuses a nonowner facade even after accidental broad table and function grants', async () => {
  await f.initialize(); const role = 'raid_chest_' + raidChestKey().replaceAll('-', ''), password = raidChestKey();
  let runtime: ReturnType<typeof createDb> | undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try {
    await f.sql.unsafe(`grant usage on schema public to ${role};grant select,insert,update,delete on all tables in schema public to ${role};grant execute on all functions in schema public to ${role}`);
    const [database] = await f.sql`select current_database() name`, url = new URL(ADMIN_DATABASE_URL);
    url.pathname = '/' + database!.name; url.username = role; url.password = password; runtime = createDb(url.toString());
    expect(await runtime.sql`select current_user u,session_user s`).toEqual([{ u: role, s: role }]);
    await expect(createClanCharterRaidChest(runtime.db).read(raidChestKey()))
      .rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_OWNER' });
    await expect(createClanCharterRaidChest(runtime.db).initializeRule())
      .rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_OWNER' });
  } finally { await runtime?.sql.end(); await f.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
});

it('keeps rule data immutable against direct owner and TEMP-trigger updates', async () => {
  const rule = await f.initialize(), before = await f.sql`select * from clan_charter_raid_tithe_rules`;
  await refusal(f.sql`update clan_charter_raid_tithe_rules set tithe_bps=tithe_bps+1 where id=${rule.id}`,
    'CLAN_CHARTER_RAID_CHEST_IMMUTABLE');
  await refusal(f.sql`delete from clan_charter_raid_tithe_rules where id=${rule.id}`,
    'CLAN_CHARTER_RAID_CHEST_IMMUTABLE');
  await refusal(f.db.transaction(async tx => {
    await tx.execute(sql`create temporary table b6p_rule_wrapper(n integer) on commit drop`);
    await tx.execute(sql.raw(`create function pg_temp.b6p_rule_wrapper() returns trigger language plpgsql as $$
      begin update public.clan_charter_raid_tithe_rules set tithe_bps=tithe_bps+1;return new;end $$`));
    await tx.execute(sql`create trigger b6p_rule_wrapper after insert on b6p_rule_wrapper for each row execute function pg_temp.b6p_rule_wrapper()`);
    await tx.execute(sql`insert into b6p_rule_wrapper values(1)`);
  }), 'CLAN_CHARTER_RAID_CHEST_IMMUTABLE');
  expect(await f.sql`select * from clan_charter_raid_tithe_rules`).toEqual(before);
});

it('after committed zero and dissolution refuses later real balanced loot instead of invalidating the earlier proof', async () => {
  const x = await original(0n), proof = await f.service().read(x.raid.id);
  await leaveClan(f.db, x.a.wallet);
  const before = await f.money(), a = await getOrCreatePlayerAccount(f.db, x.a.wallet, 'player_shards');
  const d = await getOrCreatePlayerAccount(f.db, x.d.wallet, 'player_shards');
  await refusal(postTransaction(f.db, { idempotencyKey: `raid:${x.raid.id}:loot`, type: 'raid.loot',
    entries: [{ account: d.id, delta: -1n }, { account: a.id, delta: 1n }],
    metadata: { raidId: x.raid.id, attacker: x.a.wallet, defender: x.d.wallet, clanChest: '0' } }));
  expect(await f.money()).toEqual(before); expect(await f.entries(x.raid.id)).toHaveLength(0);
  expect(await f.service().read(x.raid.id)).toEqual(proof);
});

it('after actual expiry and dissolution refuses a late wrong-type canonical key and mutation into that source', async () => {
  const a = await f.attacker(); await f.clan(a.wallet); const d = await f.defender();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet); await f.expire(raid, a.wallet);
  await leaveClan(f.db, a.wallet); const proof = await f.service().read(raid.id), before = await f.money();
  await refusal(rewardShards(f.db, a.wallet, 1n, 'test.raid-chest.disguised', `raid:${raid.id}:loot`));
  const ordinary = await rewardShards(f.db, a.wallet, 1n, 'test.raid-chest.ordinary', raidChestKey());
  const afterOrdinary = await f.money(); expect(afterOrdinary).not.toEqual(before);
  await refusal(f.sql`update ledger_transactions set idempotency_key=${'raid:' + raid.id + ':loot'} where id=${ordinary.transaction.id}`);
  await refusal(f.sql`update ledger_transactions set type='raid.loot',metadata=jsonb_build_object('raidId',${raid.id}::text)
    where id=${ordinary.transaction.id}`);
  expect(await f.money()).toEqual(afterOrdinary); expect(await f.entries(raid.id)).toHaveLength(0);
  expect(await f.service().read(raid.id)).toEqual(proof);
});

it('protects both sides of later header, entry and terminal rewrites after a valid positive proof and dissolution', async () => {
  const x = await original(), proof = await f.service().read(x.raid.id), post = x.settled.ledgerId!;
  await leaveClan(f.db, x.a.wallet);
  const entries = await f.entries(x.raid.id), first = entries[0]!;
  const ordinary = await rewardShards(f.db, x.a.wallet, 1n, 'test.raid-chest.other', raidChestKey());
  const [otherEntry] = await f.sql`select id from ledger_entries where txn_id=${ordinary.transaction.id} order by id limit 1`;
  const before = await f.money();
  const writes = [
    () => f.sql`update ledger_transactions set idempotency_key=${'other:' + raidChestKey()} where id=${post}`,
    () => f.sql`update ledger_transactions set type='test.raid-chest.hidden' where id=${post}`,
    () => f.sql`update ledger_transactions set metadata='{}' where id=${post}`,
    () => f.sql`update ledger_entries set delta=delta+1 where id=${first.id}`,
    () => f.sql`update ledger_entries set balance_after=balance_after+1 where id=${first.id}`,
    () => f.sql`update ledger_entries set txn_id=${ordinary.transaction.id} where id=${first.id}`,
    () => f.sql`update ledger_entries set txn_id=${post} where id=${otherEntry!.id}`,
    () => f.sql`delete from ledger_entries where id=${first.id}`,
    () => f.sql`update raids set result=jsonb_set(result,'{lootShards}','0') where id=${x.raid.id}`,
    () => f.sql`update raids set status='pending_orders' where id=${x.raid.id}`,
    () => f.sql`update accounts set created_at=created_at+interval '1 microsecond' where id=${first.account_id}`,
  ];
  for (const write of writes) {
    await refusal(write()); expect(await f.service().read(x.raid.id)).toEqual(proof);
    expect(await f.entries(x.raid.id)).toEqual(entries); expect(await f.money()).toEqual(before);
  }
});

it('refuses a newly inserted leg on an old committed post rather than silently omitting it from captured evidence', async () => {
  const x = await original(), proof = await f.service().read(x.raid.id), entries = await f.entries(x.raid.id);
  await leaveClan(f.db, x.a.wallet); const before = await f.money();
  await refusal(f.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after)
    select ${x.settled.ledgerId}::uuid,id,1,balance+1 from accounts where id=${entries[0]!.account_id}`);
  expect(await f.entries(x.raid.id)).toEqual(entries); expect(await f.money()).toEqual(before);
  expect(await f.service().read(x.raid.id)).toEqual(proof);
});

it('holds missing hook coverage and rolls back trailing same-transaction terminal changes with the actual money', async () => {
  const a = await f.attacker(); await f.clan(a.wallet); const d = await f.defender();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet), before = await f.money();
  await refusal(f.db.transaction(async tx => {
    const settlement = await f.settlement(tx, raid.id, BigInt(PHASE_E_POLICY.basisPoints));
    const reached = await tx.execute<{ n: number }>(sql`select count(*)::int n from ledger_entries where txn_id=${settlement.ledgerId}`);
    expect(reached[0]?.n).toBe(3);
    await tx.execute(sql`update raids set result=jsonb_set(result,'{lootShards}','0') where id=${raid.id}`);
  }));
  expect(await f.money()).toEqual(before); expect(await f.entries(raid.id)).toHaveLength(0);
  await f.sql`alter table ledger_entries disable trigger ledger_entries_clan_charter_raid_chest`;
  try {
    expect(await f.service().read(raid.id)).toEqual({ status: 'held', reason: 'hooks_missing' });
    // The real raid UPDATE reaches the source hook before the TS resolver;
    // pin that earliest refusal rather than expecting facade translation.
    await refusal(f.settle(raid.id, BigInt(PHASE_E_POLICY.basisPoints)));
    expect(await f.money()).toEqual(before);
  } finally { await f.sql`alter table ledger_entries enable trigger ledger_entries_clan_charter_raid_chest`; }
  await f.settle(raid.id, BigInt(PHASE_E_POLICY.basisPoints));
  expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled' });
});

it('captures a genuinely new nested-savepoint INSERT even when its gameplay timestamp predates enrollment', async () => {
  const a = await f.funded(), c = await f.clan(a.wallet), d = await f.funded(), rule = await f.initialize();
  const earlier = new Date(0);
  const raid = await f.db.transaction(async tx => {
    const [top] = await tx.execute<{ xid: string }>(sql`select pg_current_xact_id()::text xid`);
    return tx.transaction(async nested => {
      // This source-layer fixture deliberately supplies an earlier domain
      // clock; the physical INSERT is new and the real mandatory hooks run.
      const [created] = await nested.insert(raids).values({ attackerWallet: a.wallet, defenderWallet: d.wallet,
        seed: 1n, snapshot: {}, armySnapshot: {}, idempotencyKey: raidChestKey(),
        createdAt: earlier, ordersDeadlineAt: earlier }).returning();
      const [captured] = await nested.execute<{ row_xid: string; admission_tx: string; rule_id: string }>(sql`
        select r.xmin::text row_xid,e.chest_admission_tx admission_tx,e.tithe_rule_id rule_id
        from raids r join clan_charter_raid_events e on e.raid_id=r.id where r.id=${created!.id}`);
      expect(captured?.row_xid).not.toBe((BigInt(top!.xid) % (1n << 32n)).toString());
      expect(captured).toMatchObject({ admission_tx: top!.xid, rule_id: rule.id });
      return created!;
    });
  });
  expect(raid.createdAt).toEqual(earlier);
  await f.settle(raid.id, 0n);
  expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled', originalClanId: c.id, ruleId: rule.id });
});

it('never adopts an older terminal through reopening, deletion/reinsert, TEMP evidence or a copied capture hook', async () => {
  const a = await f.attacker(), d = await f.defender(), raid = await f.admit(a.wallet, d.wallet);
  await f.expire(raid, a.wallet); await f.initialize();
  expect(await f.sql`select * from clan_charter_raid_events where raid_id=${raid.id}`).toHaveLength(0);
  for (const status of ['pending_orders', 'resolving']) {
    await refusal(f.sql`update raids set status=${status}::raid_status where id=${raid.id}`);
  }
  await refusal(f.sql`delete from raids where id=${raid.id}`);
  await refusal(f.sql`truncate raids cascade`);
  await refusal(f.db.transaction(async tx => {
    await tx.execute(sql`create temporary table b6p_old_adoption(raid_id uuid) on commit drop`);
    await tx.execute(sql.raw(`create function pg_temp.b6p_old_adoption() returns trigger language plpgsql as $$
      begin
       insert into public.clan_charter_raid_events(raid_id,source_id,attacker_wallet,attacker_base_id,defender_wallet,defender_base_id,
        pve_camp_id,campaign_stage,kind,original_clan_id,original_leader_wallet,clan_ordinal,admitted_at)
       select r.id,s.source_id,r.attacker_wallet,r.attacker_base_id,r.defender_wallet,r.defender_base_id,
        r.pve_camp_id,r.campaign_stage,'legacy_pvp',null,null,null,r.created_at
       from public.raids r cross join public.clan_charter_event_source s where r.id=new.raid_id;
       return new;end $$`));
    await tx.execute(sql`create trigger b6p_old_adoption after insert on b6p_old_adoption for each row execute function pg_temp.b6p_old_adoption()`);
    await tx.execute(sql`insert into b6p_old_adoption values(${raid.id})`);
  }), 'CLAN_CHARTER_RAID_CHEST_SOURCE');
  await refusal(f.db.transaction(async tx => {
    await tx.execute(sql`create temporary table b6p_copied_raid(like public.raids including defaults) on commit drop`);
    await tx.execute(sql`create trigger raids_clan_charter_capture after insert on b6p_copied_raid for each row execute function public.shardkeep_clan_charter_capture_raid()`);
    await tx.execute(sql`insert into b6p_copied_raid select * from public.raids where id=${raid.id}`);
  }), 'CLAN_CHARTER_EVENT_TRIGGER');
  expect(await f.sql`select status from raids where id=${raid.id}`).toEqual([{ status: 'expired' }]);
  expect(await f.sql`select * from clan_charter_raid_events where raid_id=${raid.id}`).toHaveLength(0);
  expect(await f.service().read(raid.id)).toEqual({ status: 'held', reason: 'admission_missing' });
});
