/** D-118: evidence and denominators survive score changes and deed transfers. */
import { randomUUID } from 'node:crypto';
import { RAID_RULES } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bases, ledgerTransactions, players, raidCommands, raids } from '../src/db/schema';
import { activityPercent, computeActivityStats, reconcilePlayerActions } from '../src/game/playtestActivity';
import { connectTestDb, fundTestKeep, insertActiveTestBase, randomWallet } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
const cohort = randomWallet();
const old = randomWallet();
const inactive = randomWallet();
const now = new Date('2030-01-16T12:00:00Z');
const eligible = sql`select wallet,created_at from players where wallet in (${cohort},${old},${inactive})`;
async function action(wallet: string, ref: string, at: string, active = true) {
  await conn.db.execute(sql`select record_player_action(${wallet},'chat_sent','fixture',${ref},${at}::timestamptz,NULL,${active},false,'{}')`);
}

beforeAll(async () => {
  conn = connectTestDb();
  await conn.db.insert(players).values([
    { wallet: cohort, createdAt: new Date('2030-01-01T00:00:00Z') },
    { wallet: old, createdAt: new Date('2020-01-01T00:00:00Z') },
    { wallet: inactive, createdAt: new Date('2030-01-01T00:00:00Z') },
  ]);
});
afterAll(async () => { await conn.sql.end(); });

describe('independent action evidence', () => {
  it('deduplicates exact source retries and counts mature exact return days', async () => {
    for (const day of ['01','02','08','15','16']) await action(cohort,`day-${day}`,`2030-01-${day}T01:00:00Z`);
    await action(cohort,'day-16','2030-01-16T01:00:00Z');
    await action(old,'old-first-surviving','2030-01-16T02:00:00Z');
    await action(inactive,'passive','2030-01-16T02:00:00Z',false);
    const stats = await computeActivityStats(conn.db,eligible,now);
    expect(stats.dau).toBe(2);
    expect(stats.wau).toBe(2);
    for (const metric of Object.values(stats.retention)) {
      // The old wallet's first surviving action is not proof of acquisition.
      expect(metric).toMatchObject({ eligible: 1, returned: 1, percent: 100 });
    }
    const events = await conn.db.execute(sql`select count(*)::int n from player_action_events where wallet=${cohort} and source_id='day-16'`);
    expect(events[0]?.['n']).toBe(1);
  });

  it('excludes unfinished target days and exposes zero denominators as null', async () => {
    const stats = await computeActivityStats(conn.db,eligible,new Date('2030-01-15T23:59:59Z'));
    expect(stats.retention.d14).toMatchObject({ eligible: 0, returned: 0, percent: null });
    expect(activityPercent(0,0)).toBeNull();
  });

  it('counts an actual losing deployment, excluding an empty visit and passive defence', async () => {
    const common = { attackerWallet: old, defenderWallet: cohort, seed: 1n,
      snapshot: {}, armySnapshot: {}, ordersDeadlineAt: now, status: 'resolved' as const,
      createdAt: now, resolvedAt: now, result: { stars: 0, retreated: true } };
    await conn.db.insert(raids).values([
      { ...common, id: randomUUID(), bulkDeploymentAcceptedAt: now, orders: { deploys: [{ troop: 'highlander', x: 0, y: 0, tMs: 0 }], heroDeploys: [] } },
      { ...common, id: randomUUID(), attackerWallet: inactive, orders: { deploys: [], heroDeploys: [] } },
    ]);
    // This test measures a window AFTER the committed losing deployment. The
    // host's Date clock can still truncate to a millisecond before PostgreSQL's
    // acceptance timestamp on a fast local connection. Derive the explicit
    // reporting boundary from that evidence; no sleep or weaker count assertion.
    const [boundary] = await conn.db.execute<{ at: Date }>(sql`select
      date_trunc('milliseconds', max(occurred_at)) + interval '1 millisecond' as at
      from player_action_events where wallet=${old} and active and source_table='raids'`);
    expect(boundary!.at).not.toBeNull();
    const stats = await computeActivityStats(conn.db,eligible,new Date(boundary!.at));
    expect(stats.dau).toBe(1);
    expect(stats.foughtToday).toBe(1);
    expect(stats.foughtPercent).toBe(100);
  });

  it('removes a cancelled-only day without erasing other real actions', async () => {
    await action(inactive,'cancelled','2030-01-16T03:00:00Z');
    await conn.db.execute(sql`update player_action_events set invalidated_for_scoring_at=${now.toISOString()}::timestamptz where wallet=${inactive} and source_id='cancelled'`);
    const stats = await computeActivityStats(conn.db,eligible,now);
    expect(stats.dau).toBe(2);
  });

  it('refuses to finalize a campaign predating reliable capture', async () => {
    await expect(reconcilePlayerActions(conn.db,{from:new Date('2020-01-01'),to:now})).rejects.toThrow('coverage');
  });

  it('checks coverage at full database precision instead of truncating a partial first second', async () => {
    await conn.db.transaction(async tx => {
      const previous = await tx.execute(sql`select started_at::text at from playtest_activity_coverage where key='authoritative-v1'`);
      await tx.execute(sql`update playtest_activity_coverage set started_at='2030-01-01T00:00:00.750Z' where key='authoritative-v1'`);
      await expect(reconcilePlayerActions(tx,{from:new Date('2030-01-01T00:00:00.500Z'),to:now})).rejects.toThrow('coverage');
      await expect(reconcilePlayerActions(tx,{from:new Date('2030-01-01T00:00:00.750Z'),to:now})).resolves.toBeUndefined();
      await tx.execute(sql`update playtest_activity_coverage set started_at=${String(previous[0]?.['at'])}::timestamptz where key='authoritative-v1'`);
    });
  });

  it('captures every command at live acceptance, preserving source time without worker-created play', async () => {
    const wallet = randomWallet();
    await conn.db.insert(players).values({ wallet });
    const raidId = randomUUID();
    await conn.db.insert(raids).values({ id: raidId, attackerWallet: wallet, seed: 1n, snapshot: {}, armySnapshot: {}, ordersDeadlineAt: now });
    let join = '';
    for (const [index,at] of ['2030-01-15T23:59:59Z','2030-01-16T00:00:01Z','2030-01-16T12:00:00Z'].entries()) {
      if (index === 2) {
        const clock = await conn.db.execute(sql`select clock_timestamp()::text at`);
        join = String(clock[0]?.['at']);
      }
      await conn.db.insert(raidCommands).values({ raidId, sequence: index, clientCommandId: randomUUID(),
        kind: 'deploy', payload: { troop: 'highlander' }, serverOffsetMs: index, payloadHash: 'fixture', acceptedAt: new Date(at) });
    }
    await conn.db.execute(sql`update raids set status='resolved',resolved_at='2030-01-17T01:00:00Z',
      orders='{"deploys":[{}]}',result='{"stars":1}' where id=${raidId}::uuid`);
    const rows = await conn.db.execute(sql`select source_key,active,occurred_at,metadata from player_action_events where wallet=${wallet} order by occurred_at`);
    const commands = rows.filter(r => r['source_key']==='battle_fought');
    expect(commands).toHaveLength(3);
    expect(commands[0]?.['metadata']).toMatchObject({sourceOccurredAt:'2030-01-15T23:59:59+00:00'});
    expect(rows.find(r => r['source_key']==='pve_battle')?.['active']).toBe(false);
    const afterJoin = await conn.db.execute(sql`select count(*)::int n from player_action_events where wallet=${wallet} and active and occurred_at >= ${join}::timestamptz`);
    expect(afterJoin[0]?.['n']).toBe(1);
    const days = await conn.db.execute(sql`select day::text from player_activity_days where wallet=${wallet} order by day`);
    expect(days.map(r => r['day'])).toEqual([new Date().toISOString().slice(0,10)]);
  });

  it('fences new live activity before sampling acceptance instead of backdating past close', async () => {
    const wallet = randomWallet();
    await conn.db.insert(players).values({wallet});
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const close = conn.db.transaction(async tx => {
      await tx.execute(sql`lock table player_action_events in share mode`);
      ready();
      await released;
      return tx.execute(sql`select clock_timestamp()::text at`);
    });
    await locked;
    const capture = conn.db.execute(sql`select capture_live_player_action(${wallet},'chat_sent','fixture','late','2020-01-01'::timestamptz)`);
    // Force the lazy query to start while closeout owns the fence.
    const pending = Promise.resolve(capture);
    release();
    const [boundary] = await Promise.all([close,pending]);
    const events = await conn.db.execute(sql`select occurred_at >= ${String(boundary[0]?.['at'])}::timestamptz after_close,metadata from player_action_events where wallet=${wallet}`);
    expect(events[0]?.['after_close']).toBe(true);
    expect(events[0]?.['metadata']).toMatchObject({sourceOccurredAt:'2020-01-01T00:00:00+00:00'});
  });

  it('retains immutable observation versions without counting chain refreshes as play', async () => {
    const wallet=randomWallet(),baseId=randomUUID();
    await conn.db.insert(players).values({wallet});
    await conn.db.insert(bases).values({id:baseId,ownerWallet:wallet,status:'active'});
    const observations=await conn.db.execute(sql`insert into deed_ownership_observations(base_id,asset_id,owner,slot,checked_at,source,status,audit_hash)
      values(${baseId}::uuid,'observation-fixture',${wallet},1,'2020-01-01','fixture','owned','first') returning id`);
    await conn.db.execute(sql`update deed_ownership_observations set owner=null,status='unavailable',slot=2,checked_at='2020-01-02' where id=${String(observations[0]?.['id'])}::bigint`);
    const versions=await conn.db.execute(sql`select metadata from player_action_events where base_id=${baseId}::uuid and source_key='deed_observation' order by occurred_at`);
    expect(versions.map(r=>r['metadata'])).toMatchObject([{owner:wallet,slot:'1',status:'owned'}, {owner:null,slot:'2',status:'unavailable'}]);
    const days=await conn.db.execute(sql`select day from player_activity_days where wallet=${wallet}`);
    expect(days).toHaveLength(0);
  });

  it('requires an actual attack on the same stable bases within the gameplay revenge window', async () => {
    const a=randomWallet(),b=randomWallet(),aBase=randomUUID(),bBase=randomUUID(),otherBase=randomUUID();
    await conn.db.insert(players).values([{wallet:a},{wallet:b}]);
    await insertActiveTestBase(conn.db,{id:aBase,ownerWallet:a,status:'active'});await insertActiveTestBase(conn.db,{id:bBase,ownerWallet:b,status:'active'});
    await insertActiveTestBase(conn.db,{id:otherBase,ownerWallet:a,status:'active'});
    const current = new Date();
    const makePrior = async (ageHours:number,defenderBaseId=aBase,deploys:unknown[]=[{}]) => {
      const id=randomUUID();
      await conn.db.insert(raids).values({id,attackerWallet:b,defenderWallet:a,attackerBaseId:bBase,defenderBaseId,
        seed:1n,snapshot:{},armySnapshot:{},ordersDeadlineAt:current,status:'resolved',orders:{deploys},result:{stars:1},
        createdAt:new Date(current.getTime()-ageHours*3_600_000),resolvedAt:new Date(current.getTime()-60_000)});
      return id;
    };
    const resolveReturn = async () => {
      const id=randomUUID();
      await conn.db.insert(raids).values({id,attackerWallet:a,defenderWallet:b,attackerBaseId:aBase,defenderBaseId:bBase,
        seed:1n,snapshot:{},armySnapshot:{},ordersDeadlineAt:current,status:'resolved',orders:{deploys:[{}]},result:{stars:1},createdAt:current,resolvedAt:current});
      const evidence=await conn.db.execute(sql`select metadata from player_action_events where source_table='raids' and source_id=${id} and source_key='pvp_win'`);
      return evidence[0]?.['metadata'] as Record<string,unknown>;
    };
    await makePrior(RAID_RULES.revengeLockHours+1);
    await makePrior(1,otherBase);
    await makePrior(1,aBase,[]);
    expect(await resolveReturn()).not.toHaveProperty('originalAttackId');
    const qualifying = await makePrior(1);
    expect(await resolveReturn()).toMatchObject({originalAttackId:qualifying});
  });

  it('keeps actor snapshots after transfer and invalidates cancellation receipts atomically', async () => {
    const seller=randomWallet(),buyer=randomWallet(),baseId=randomUUID(),jobId=randomUUID(),debit=randomUUID(),refund=randomUUID();
    await conn.db.insert(players).values([{wallet:seller},{wallet:buyer}]);
    await conn.db.insert(bases).values({id:baseId,ownerWallet:seller,status:'active',deedAssetId:`fixture-${baseId}`,landPaidAt:now});
    await conn.db.insert(ledgerTransactions).values([
      { id:debit,idempotencyKey:randomUUID(),type:'fixture' },{ id:refund,idempotencyKey:randomUUID(),type:'fixture' },
    ]);
    await conn.db.execute(sql`insert into builder_jobs(id,player_wallet,base_id,kind,started_at,finishes_at,paid_shard_cost,debit_ledger_txn_id)
      values(${jobId}::uuid,${seller},${baseId}::uuid,'upgrade',${now.toISOString()}::timestamptz,${now.toISOString()}::timestamptz,1,${debit}::uuid)`);
    await conn.db.execute(sql`update bases set owner_wallet=${buyer},status='inactive' where id=${baseId}::uuid`);
    await conn.db.execute(sql`update builder_jobs set player_wallet=${buyer} where id=${jobId}::uuid`);
    const actor=await conn.db.execute(sql`select wallet from player_action_events where source_table='builder_jobs' and source_id=${jobId}`);
    expect(actor.map(r=>r['wallet'])).toEqual([seller]);
    await conn.db.execute(sql`update builder_jobs set completed_at=${now.toISOString()}::timestamptz,cancelled_at=${now.toISOString()}::timestamptz,
      refund_ledger_txn_id=${refund}::uuid,cancel_idempotency_key=${randomUUID()} where id=${jobId}::uuid`);
    const remaining=await conn.db.execute(sql`select * from player_activity_days where wallet=${seller}`);
    expect(remaining).toHaveLength(0);
    const state=await conn.db.execute(sql`select metadata from player_action_events where base_id=${baseId}::uuid and source_key='deed_eligibility' order by occurred_at desc limit 1`);
    expect(state[0]?.['metadata']).toMatchObject({ownerWallet:buyer,status:'inactive',paid:true});
  });

  it('captures ledger actors without a client claim and rolls failed source transactions back', async () => {
    const wallet=randomWallet();
    await conn.db.insert(players).values({wallet});
    await fundTestKeep(conn.db,wallet,1n,'mine.collect',randomUUID());
    const evidence=await conn.db.execute(sql`select wallet,source_key from player_action_events where wallet=${wallet}`);
    expect(evidence).toEqual([{wallet,source_key:'mine_collected'}]);
    await expect(conn.db.transaction(async tx => {
      await tx.execute(sql`select record_player_action(${wallet},'chat_sent','fixture','rollback',${now.toISOString()}::timestamptz)`);
      throw new Error('rollback source');
    })).rejects.toThrow('rollback source');
    const failed=await conn.db.execute(sql`select id from player_action_events where wallet=${wallet} and source_id='rollback'`);
    expect(failed).toHaveLength(0);
  });

  it('records every qualified referee action for exact cutoffs and removes cancelled credit', async () => {
    const referrer=randomWallet(),referee=randomWallet(),baseId=randomUUID();
    await conn.db.insert(players).values([{wallet:referrer},{wallet:referee}]);
    await conn.db.insert(bases).values({id:baseId,ownerWallet:referee,status:'active',keepLevel:3,landPaidAt:now});
    await conn.db.execute(sql`insert into referrals(referrer_wallet,referee_wallet,qualified_at) values(${referrer},${referee},'2030-01-01')`);
    await action(referee,'before-join','2030-01-16T01:00:00Z');
    await action(referee,'after-join','2030-01-16T12:00:00Z');
    const eligibleActions=await conn.db.execute(sql`select metadata from player_action_events where wallet=${referrer} and occurred_at>='2030-01-16T06:00:00Z'`);
    expect(eligibleActions).toEqual([{metadata:{refereeWallet:referee}}]);
    await conn.db.execute(sql`update player_action_events set invalidated_for_scoring_at=now() where wallet=${referee} and source_id='after-join'`);
    const invalidated=await conn.db.execute(sql`select id from player_action_events where wallet=${referrer} and invalidated_for_scoring_at is not null`);
    expect(invalidated).toHaveLength(1);
    await conn.db.execute(sql`update bases set status='inactive' where id=${baseId}::uuid`);
    await action(referee,'no-deed','2030-01-16T13:00:00Z');
    const bonus=await conn.db.execute(sql`select id from player_action_events where wallet=${referrer}`);
    expect(bonus).toHaveLength(2);
    const passive=await conn.db.execute(sql`select day from player_activity_days where wallet=${referrer}`);
    expect(passive).toHaveLength(0);
  });

  it('retains concurrent real activity when the only earlier action is cancelled', async () => {
    const wallet=randomWallet();
    await conn.db.insert(players).values({wallet});
    await action(wallet,'cancel-race','2030-01-16T01:00:00Z');
    await Promise.all([
      conn.db.execute(sql`update player_action_events set invalidated_for_scoring_at=now() where wallet=${wallet} and source_id='cancel-race'`),
      action(wallet,'real-race','2030-01-16T02:00:00Z'),
    ]);
    const day=await conn.db.execute(sql`select first_at,last_at from player_activity_days where wallet=${wallet}`);
    expect(day).toHaveLength(1);
    expect(new Date(String(day[0]?.['first_at'])).toISOString()).toBe('2030-01-16T02:00:00.000Z');
  });

  it('executes capture under an ordinary invoker with the runtime table grants', async () => {
    const role=`activity_runtime_${randomUUID().replaceAll('-','')}`;
    const identifier=sql.raw(`"${role}"`);
    const wallet=randomWallet();
    await conn.db.insert(players).values({wallet});
    await conn.db.execute(sql`create role ${identifier} nologin nosuperuser`);
    try {
      await conn.db.execute(sql`grant usage on schema public to ${identifier}`);
      await conn.db.execute(sql`grant select,insert,update,delete on all tables in schema public to ${identifier}`);
      await conn.db.execute(sql`grant usage,select on all sequences in schema public to ${identifier}`);
      await conn.db.transaction(async tx => {
        await tx.execute(sql`set local role ${identifier}`);
        await tx.execute(sql`select capture_live_player_action(${wallet},'chat_sent','fixture','runtime',${now.toISOString()}::timestamptz)`);
        await tx.execute(sql`insert into global_chat_messages(author_wallet,client_message_id,text,text_hash,author_name_at_send,author_seeker_verified_at_send)
          values(${wallet},${randomUUID()}::uuid,'runtime activity','fixture','Runtime player',false)`);
      });
      const captured=await conn.db.execute(sql`select day from player_activity_days where wallet=${wallet}`);
      expect(captured).toHaveLength(1);
      const triggered=await conn.db.execute(sql`select id from player_action_events where wallet=${wallet} and source_table='global_chat_messages'`);
      expect(triggered).toHaveLength(1);
    } finally {
      await conn.db.execute(sql`drop owned by ${identifier}`);
      await conn.db.execute(sql`drop role ${identifier}`);
    }
  });
});
