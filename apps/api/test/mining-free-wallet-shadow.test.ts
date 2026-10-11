import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { Keypair } from '@solana/web3.js';
import { FORGE_INGOT, BUILD_COSTS } from '@shardkeep/shared';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { collectRefine, startRefine } from '../src/game/workshop';
import { abortPendingMiningEpoch, reservePendingMiningIngots } from '../src/game/miningIngotReservations';
import { enrollInitialFreeCohort, initializeFreeCohortCoverage } from '../src/mining/freeCohort';
import { collectFreeWalletShadow } from '../src/mining/freeWalletShadow';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';

async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>) {
  const f=await setup();
  try {await run(f);} finally {vi.unstubAllEnvs();await f.conn.sql.end();await f.admin.unsafe(`drop database ${f.name} with (force)`);await f.admin.end();}
}
async function setup() {
  const name=`mining_free_shadow_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('fixture host required');
  url.pathname=`/${name}`;const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await createMigratedDatabase(admin, name);
  const conn=createDb(url.toString(),{max:4});
  try {
  await runMigrations(conn.db);
  const clock=async(at:string|null)=>conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select ${at?`'${at}'::timestamptz`:'clock_timestamp()'} $$`);
  await clock('2019-12-30T00:00:00Z');await initializeFreeCohortCoverage(conn.db);
  await conn.sql`update playtest_activity_coverage set started_at='2019-12-30'`;
  await clock('2019-12-31T12:00:00Z');
  const wallet=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58(),baseId=randomUUID();
  await conn.sql`insert into players(wallet,created_at) values(${wallet},'2019-12-31'),(${buyer},'2019-12-31')`;
  await conn.sql`insert into bases(id,owner_wallet,created_at,keep_level) values(${baseId},${wallet},'2019-12-31',${BUILD_COSTS.workshop.requiresKeepLevel})`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${baseId},'keep',${BUILD_COSTS.workshop.requiresKeepLevel},10,10),(${wallet},${baseId},'workshop',1,20,20)`;
  for(const flag of ['PHASE_E_MINING_ENABLED','PHASE_E_BUILDINGS_ENABLED','FORGE_INGOTS_ENABLED']) vi.stubEnv(flag,'true');
  const context={baseId,assertAuthority:async(tx:Parameters<typeof assertFreshLockedBaseAuthority>[0],w:string,b:string)=>{await assertFreshLockedBaseAuthority(tx,w,b,new Date());}};
  await enrollInitialFreeCohort(conn.db,wallet,context);
  await rewardBaseShards(conn.db,baseId,BigInt(FORGE_INGOT.shardsPerIngot)*100n,'test.shadow.fund',randomUUID());
  const reserve=async(day:string,qty=1,epochDay=day,actor=wallet,targetBase=baseId)=>{
    const targetContext={...context,baseId:targetBase};
    await clock(`${day}T06:00:00Z`);
    const job=await startRefine(conn.db,actor,targetBase,qty,FORGE_INGOT.recipeVersion,randomUUID(),new Date(`${day}T06:00:00Z`),targetContext);
    const ready=new Date(job.readyAt);await clock(ready.toISOString());
    await collectRefine(conn.db,actor,targetBase,job.jobId,randomUUID(),ready,targetContext);
    const receipt=await reservePendingMiningIngots(conn.db,actor,{epochKey:`free-shadow-v1:${epochDay}`,baseId:targetBase,ingots:qty,idempotencyKey:randomUUID()},targetContext,ready);
    return {job,receipt};
  };
  const battle=async(day:string,pending=false,at=`${day}T12:00:00Z`)=>{
    const id=randomUUID();await clock(at);
    await conn.sql`insert into raids(id,attacker_wallet,attacker_base_id,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status,bulk_deployment_accepted_at,created_at)
      values(${id},${wallet},${baseId},1,1,'{}','{}','{"deploys":[{}]}',${at},'resolving',${at},${new Date(Date.parse(at)-1000).toISOString()})`;
    await conn.sql`update player_action_events set occurred_at=${at} where source_id=${id} and source_key='battle_fought'`;
    const finish=async(resolvedAt=at)=>{await conn.sql`update raids set status='resolved',result='{"stars":1,"retreated":false}',resolved_at=${resolvedAt} where id=${id}`;
      await conn.sql`update player_action_events set occurred_at=${resolvedAt} where source_id=${id} and source_key='pve_battle'`;};
    if(!pending) await finish();return {id,finish};
  };
  const input=(day:string)=>({day,wallet,policyVersion:'free-shadow-v1'});
  const collect=(day:string)=>collectFreeWalletShadow(conn.db,input(day));
  return {name,url,admin,conn,wallet,buyer,baseId,context,clock,reserve,battle,input,collect};
  } catch(error) {vi.unstubAllEnvs();await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();throw error;}
}
describe('free-wallet shadow earning inputs',()=>{
  it('seals fourteen actual paid days and replays original receipts after reconnect, abort and transfer',async()=>fixture(async f=>{
    const expected=[];
    for(let d=1;d<=14;d++) {const day=`2020-01-${String(d).padStart(2,'0')}`,r=await f.reserve(day),b=await f.battle(day);expected.push({day,r,b});}
    await f.clock(null);const results=[];
    for(const {day,r,b} of expected) {const result=await f.collect(day);expect(result).toMatchObject({day,wallet:f.wallet,baseId:f.baseId,eligibleUnits:1,pendingUnits:1,
      reservedUnits:1,releasedUnits:0,projectedReturnUnits:0,capacityUnits:2,reservationIds:[r.receipt.id],playedRaidIds:[b.id],reason:'qualified_inputs',allocationReady:false,publicationAuthorized:false});results.push(result);}
    for(const name of ['0161_mining_free_cohorts.sql','0162_mining_free_wallet_shadows.sql']) {
      const migration=readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8');
      for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim())) await f.conn.sql.unsafe(statement);
    }
    await abortPendingMiningEpoch(f.conn.db,{epochId:expected[0]!.r.receipt.epochId,decisionKey:randomUUID(),reason:'fixture-after-observation'});
    await f.conn.sql`update bases set owner_wallet=${f.buyer} where id=${f.baseId}`;
    const other=createDb(f.url.toString(),{max:1});try {for(let i=0;i<expected.length;i++) expect(await collectFreeWalletShadow(other.db,f.input(expected[i]!.day))).toEqual(results[i]);}finally{await other.sql.end();}
    expect((await f.conn.sql`select count(*)::int n from mining_free_wallet_shadows`)[0]!.n).toBe(14);
    await expect(f.conn.sql`update mining_free_wallet_shadows set result='{}'`).rejects.toThrow();
    await expect(f.conn.sql`delete from mining_free_wallet_shadows`).rejects.toThrow();
  }),60_000);
  it('projects excess and already released contributions without changing custody',async()=>fixture(async f=>{
    const r=await f.reserve('2020-02-01',3);await f.battle('2020-02-01');
    const released=await f.reserve('2020-02-02',2);await f.battle('2020-02-02');await f.clock(null);
    await abortPendingMiningEpoch(f.conn.db,{epochId:released.receipt.epochId,decisionKey:randomUUID(),reason:'fixture-before-observation'});
    const before=await f.conn.sql`select * from base_items where base_id=${f.baseId}`;
    expect(await f.collect('2020-02-01')).toMatchObject({eligibleUnits:2,projectedReturnUnits:1,reservationIds:[r.receipt.id]});
    expect(await f.collect('2020-02-02')).toMatchObject({eligibleUnits:0,releasedUnits:2,pendingUnits:0,projectedReturnUnits:0,reason:'released_contribution'});
    expect(await f.conn.sql`select * from base_items where base_id=${f.baseId}`).toEqual(before);
  }),30_000);
  it('records known absence and invalidation as zero, but never seals uncertain battle authority',async()=>fixture(async f=>{
    await f.reserve('2020-03-01');await f.reserve('2020-03-02');const pending=await f.battle('2020-03-02',true);
    await f.clock('2020-03-03T00:00:00Z');await f.conn.sql`update base_slots set active=false where base_id=${f.baseId}`;
    await f.conn.sql`update base_slots set active=true where base_id=${f.baseId}`;await f.battle('2020-03-03');await f.clock(null);
    expect(await f.collect('2020-03-01')).toMatchObject({eligibleUnits:0,projectedReturnUnits:1,reason:'no_fresh_battle'});
    await expect(f.collect('2020-03-02')).rejects.toMatchObject({code:'PENDING_BATTLES'});
    expect(await f.conn.sql`select * from mining_free_wallet_shadows where day='2020-03-02'`).toHaveLength(0);
    await pending.finish();expect(await f.collect('2020-03-02')).toMatchObject({eligibleUnits:1});
    expect(await f.collect('2020-03-03')).toMatchObject({eligibleUnits:0,cohortValid:false,reason:'cohort_invalid'});
  }),30_000);
  it('rejects forged input, inconsistent epoch time and missing cohort/clock authority',async()=>fixture(async f=>{
    await f.reserve('2020-04-01',1,'2020-04-02');await f.battle('2020-04-02');await f.clock(null);
    for(const extra of [{bps:1},{ownership:true},{now:'2020-04-03'},{contributions:2}]) await expect(collectFreeWalletShadow(f.conn.db,{...f.input('2020-04-02'),...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(f.collect('2020-04-02')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    await expect(collectFreeWalletShadow(f.conn.db,{...f.input('2020-04-03'),wallet:f.buyer})).rejects.toThrow();
    await f.clock('2020-04-04T00:00:00Z');await expect(f.collect('2020-04-03')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    expect(await f.conn.sql`select * from mining_free_wallet_shadows`).toHaveLength(0);
  }),30_000);
  it('fails fast on a source writer and rolls back a refused seal',async()=>fixture(async f=>{
    await f.reserve('2020-05-01');await f.battle('2020-05-01');await f.clock(null);
    let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r}),locked=new Promise<void>(r=>{ready=r});
    const writer=f.conn.sql.begin(async tx=>{await tx`lock table mining_ingot_reservations in row exclusive mode`;ready();await gate;});
    try {await locked;await expect(f.collect('2020-05-01')).rejects.toMatchObject({code:'SOURCE_BUSY'});}finally{release();await writer;}
    await f.conn.sql`create function refuse_shadow_seal() returns trigger language plpgsql as $$ begin raise exception 'fixture shadow seal failure'; end $$`;
    await f.conn.sql`create trigger fixture_refusal before insert on mining_free_wallet_shadows for each row execute function refuse_shadow_seal()`;
    await expect(f.collect('2020-05-01')).rejects.toThrow();expect(await f.conn.sql`select * from mining_free_wallet_shadows`).toHaveLength(0);
    await f.conn.sql`drop trigger fixture_refusal on mining_free_wallet_shadows`;expect(await f.collect('2020-05-01')).toMatchObject({eligibleUnits:1});
  }),30_000);
  it('keeps midnight redeployment and delayed resolution on the original battle day',async()=>fixture(async f=>{
    await f.reserve('2020-06-01');const b=await f.battle('2020-06-01',true,'2020-06-01T23:59:59Z');
    await f.clock('2020-06-02T00:00:01Z');
    const [command]=await f.conn.sql`insert into raid_commands(raid_id,sequence,client_command_id,kind,payload,server_offset_ms,payload_hash,accepted_at)
      values(${b.id},1,${randomUUID()},'deploy','{}',1,'fixture','2020-06-02T00:00:01Z') returning id::text`;
    await f.conn.sql`update player_action_events set occurred_at='2020-06-02T00:00:01Z' where source_table='raid_commands' and source_id=${command!.id}`;
    await b.finish('2020-06-02T00:00:02Z');await f.reserve('2020-06-02');await f.clock(null);
    expect(await f.collect('2020-06-01')).toMatchObject({eligibleUnits:1,playedRaidIds:[b.id],reason:'qualified_inputs'});
    expect(await f.collect('2020-06-02')).toMatchObject({eligibleUnits:0,playedRaidIds:[],projectedReturnUnits:1,reason:'no_fresh_battle'});
  }),30_000);
  it('refuses a new owner reservation on the original cohort base',async()=>fixture(async f=>{
    await f.clock('2020-07-01T00:00:00Z');
    await f.conn.sql`update bases set owner_wallet=${f.buyer} where id=${f.baseId}`;
    await f.conn.sql`update base_slots set wallet=${f.buyer} where base_id=${f.baseId}`;
    await f.reserve('2020-07-01',1,'2020-07-01',f.buyer);await f.clock(null);
    await expect(f.collect('2020-07-01')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    expect(await f.conn.sql`select * from mining_free_wallet_shadows`).toHaveLength(0);
  }),30_000);
  it('refuses the same actor reservation from another base',async()=>fixture(async f=>{
    const otherBase=randomUUID();await f.clock('2020-08-01T00:00:00Z');
    await f.conn.sql`insert into bases(id,owner_wallet,created_at,keep_level) values(${otherBase},${f.wallet},'2020-08-01',${BUILD_COSTS.workshop.requiresKeepLevel})`;
    await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.wallet},2,${otherBase})`;
    await f.conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${f.wallet},${otherBase},'workshop',1,20,20)`;
    await rewardBaseShards(f.conn.db,otherBase,BigInt(FORGE_INGOT.shardsPerIngot)*10n,'test.shadow.other',randomUUID());
    await f.reserve('2020-08-01',1,'2020-08-01',f.wallet,otherBase);await f.clock(null);
    await expect(f.collect('2020-08-01')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    expect(await f.conn.sql`select * from mining_free_wallet_shadows`).toHaveLength(0);
  }),30_000);
  it('rejects runtime insertion of valid positive journals despite broad grants and spoofed authority',async()=>fixture(async f=>{
    await f.reserve('2020-09-01');await f.battle('2020-09-01');await f.clock(null);
    // Capture fully valid positive journals from an owner transaction, then roll
    // it back: the runtime attempts precede any committed owner observation.
    let activity!:Record<string,unknown>,shadow!:Record<string,unknown>;
    const rollback=new Error('fixture rollback');
    await expect(f.conn.db.transaction(async tx=>{
      expect(await collectFreeWalletShadow(tx as unknown as typeof f.conn.db,f.input('2020-09-01'))).toMatchObject({eligibleUnits:1});
      activity=(await tx.execute(sql`select * from mining_activity_evidence`))[0]!;
      shadow=(await tx.execute(sql`select * from mining_free_wallet_shadows`))[0]!;
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await f.conn.sql`select * from mining_activity_evidence`).toHaveLength(0);
    expect(await f.conn.sql`select * from mining_free_wallet_shadows`).toHaveLength(0);
    const role=`shadow_runtime_${randomUUID().replaceAll('-','')}`;
    await f.conn.sql.unsafe(`create role ${role}`);
    try {
      await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);
      await f.conn.sql.unsafe(`grant select,insert,update,delete on all tables in schema public to ${role}`);
      for(const [table,row,message] of [['mining_activity_evidence',activity,'MINING_ACTIVITY_OWNER_REQUIRED'],['mining_free_wallet_shadows',shadow,'MINING_FREE_SHADOW_OWNER_REQUIRED']] as const) {
        await expect(f.conn.sql.begin(async tx=>{
          await tx.unsafe(`set local role ${role}`);
          await tx`select set_config('shardkeep.deed_economy_writer','v1',true)`;
          await tx`select set_config('shardkeep.mining_free_owner','true',true)`;
          await tx.unsafe(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`,[JSON.stringify(row)]);
        })).rejects.toThrow(message);
      }
    } finally {await f.conn.sql.unsafe(`drop owned by ${role}`);await f.conn.sql.unsafe(`drop role ${role}`);}
    const result=await f.collect('2020-09-01');expect(result).toMatchObject({eligibleUnits:1});expect(await f.collect('2020-09-01')).toEqual(result);
  }),30_000);

});
