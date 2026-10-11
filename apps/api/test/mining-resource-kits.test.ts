/** Disposable DB clocks never change the real future-install rule. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { describe,it,expect,vi,afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_DATABASE_URL } from './db-url';
import { rewardBaseShards,getBaseShardBalance } from '../src/game/baseEconomy';
import { reserveMiningContribution,readMiningContribution,abortMiningContributions } from '../src/game/miningContributions';
import { readMiningContributionView } from '../src/game/miningContributionView';
import { ensureResourceMiningPolicy,installResourceMiningV3Cutover,readResourceMiningDayPolicy } from '../src/mining/resourceMiningPolicy';
import { readResourceMiningEpoch } from '../src/mining/resourcePublicationCustody';
async function fixture(run:(f:{conn:ReturnType<typeof createDb>;url:string;day:string;before:string;after:string})=>Promise<void>){
 const u=new URL(ADMIN_DATABASE_URL);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Local fixture required');
 const name=`mining_kits_${randomUUID().replaceAll('-','')}_test`,admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});
 await admin.unsafe(`create database ${name}`);u.pathname=`/${name}`;const conn=createDb(u.toString(),{max:5});
 try{await runMigrations(conn.db);const [d]=await conn.sql`select ((clock_timestamp() at time zone 'UTC')::date+2)::text as "day",((clock_timestamp() at time zone 'UTC')::date+1)::text as "before",((clock_timestamp() at time zone 'UTC')::date+3)::text as "after"`;
  await run({conn,url:u.toString(),day:d!.day,before:d!.before,after:d!.after});
 }finally{await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();}
}
async function waitForBlockedEpoch(conn:ReturnType<typeof createDb>){
 for(let i=0;i<100;i++){
  const [r]=await conn.sql`select exists(select 1 from pg_locks where relation='public.mining_ingot_epochs'::regclass and not granted) blocked`;
  if(r!.blocked)return;await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw Error('Expected independent writer to block on epoch table');
}
const leaf=(e:unknown):string=>{let x=e as {cause?:unknown;message?:string};while(x?.cause)x=x.cause as typeof x;return x?.message??String(e);};
afterEach(()=>vi.unstubAllEnvs());
describe('prospective resource policy3 custody',()=>{
 it('preserves old originals, follows server day, shares allowance and holds prior sources',async()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('FORGE_INGOTS_ENABLED','true');
  const {conn,day,before,after}=f,wallet=Keypair.generate().publicKey.toBase58(),baseId=randomUUID(),otherBase=randomUUID();
  await conn.sql`insert into players(wallet) values(${wallet})`;
  for(const [i,id] of [baseId,otherBase].entries()){
   await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${id},${wallet},3)`;
   await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},${i+1},${id})`;
   await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${id},'keep',3,10,10),(${wallet},${id},'workshop',1,20,20),(${wallet},${id},'goldforge',1,25,25)`;
   await rewardBaseShards(conn.db,id,40_000n,'test.kit-mining',randomUUID());
  }
  const authority=(id=baseId)=>({baseId:id,assertAuthority:async()=>{}}),clock=(d:string)=>()=>new Date(d+'T12:00:00Z');
  const command=(d:string,version:2|3,id=baseId,quantity='15000')=>({baseId:id,idempotencyKey:randomUUID(),expectedDay:d,policyVersion:version,lines:[{resourceId:'shards' as const,quantity}]});
  expect(await readResourceMiningDayPolicy(conn.db,day)).toBe(2);
  const original=command(before,2),accepted=await reserveMiningContribution(conn.db,wallet,original,authority(),{clock:clock(before)});
  const savedPolicy=await conn.sql`select * from mining_contribution_policies where version=2`;
  await expect(conn.sql`insert into mining_contribution_policies(version,catalogue,free_value) values(3,'{"shards":"1"}',20000)`).rejects.toThrow('MINING_RESOURCE_POLICY_CONFLICT');
  await ensureResourceMiningPolicy(conn.db,3);
  await expect(conn.sql.begin(async tx=>{await tx`set local timezone='Pacific/Kiritimati'`;await tx`insert into mining_resource_v3_cutover(singleton,first_day,policy_version) values(true,(clock_timestamp() at time zone 'UTC')::date,3)`;})).rejects.toThrow('MINING_RESOURCE_CUTOVER_FUTURE');
  const cutover=await installResourceMiningV3Cutover(conn.db,day);expect(await installResourceMiningV3Cutover(conn.db,day)).toEqual(cutover);
  expect(await readResourceMiningDayPolicy(conn.db,before)).toBe(2);expect(await readResourceMiningDayPolicy(conn.db,day)).toBe(3);
  expect(await conn.sql`select * from mining_contribution_policies where version=2`).toEqual(savedPolicy);
  await expect(installResourceMiningV3Cutover(conn.db,after)).rejects.toThrow('IMMUTABLE');
  await expect(conn.sql`update mining_resource_v3_cutover set first_day=${after}`).rejects.toThrow('IMMUTABLE');
  await expect(conn.sql`delete from mining_resource_v3_cutover`).rejects.toThrow('IMMUTABLE');
  await expect(conn.sql`truncate mining_resource_v3_cutover`).rejects.toThrow('IMMUTABLE');
  await expect(reserveMiningContribution(conn.db,wallet,command(day,2),authority(),{clock:clock(day)})).rejects.toMatchObject({code:'MINING_POLICY_REVIEW_REQUIRED'});
  await expect(reserveMiningContribution(conn.db,wallet,command(before,3),authority(),{clock:clock(before)})).rejects.toMatchObject({code:'MINING_POLICY_REVIEW_REQUIRED'});
  const current=command(day,3),now=await reserveMiningContribution(conn.db,wallet,current,authority(),{clock:clock(day)});
  await expect(reserveMiningContribution(conn.db,wallet,command(day,3,otherBase,'6000'),authority(otherBase),{clock:clock(day)})).rejects.toMatchObject({code:'MINING_FREE_CAP_EXCEEDED'});
  expect(await getBaseShardBalance(conn.db,otherBase)).toBe(40_000n);
  await expect(readMiningContributionView(conn.db,wallet,authority(),clock(day))).rejects.toMatchObject({code:'MINING_POLICY_REVIEW_REQUIRED'});
  const view=await readMiningContributionView(conn.db,wallet,authority(),clock(day),3);
  expect(view.policyVersion).toBe(3);expect(view.resources).toHaveLength(22);expect(view.remainingValue).toBe('5000');
  expect((await readMiningContributionView(conn.db,wallet,authority(),clock(before),3)).policyVersion).toBe(2);
  const input={epochId:now.receipt!.epochId,day,policyVersion:3 as const};
  await expect(readResourceMiningEpoch(conn.db,input)).rejects.toThrow('EPOCH_UNAVAILABLE');
  expect(await readResourceMiningEpoch(conn.db,input,clock(after)).then(()=>null,leaf)).toContain('MINING_RESOURCE_PRIOR_UNDECIDED');
  await abortMiningContributions(conn.db,{epochId:accepted.receipt!.epochId,decisionKey:randomUUID(),reason:'test explicit original return'},clock(after)());
  expect((await readResourceMiningEpoch(conn.db,input,clock(after))).cutover).toEqual(cutover);
  await conn.sql`insert into mining_publication_attempts(epoch_id,attempt_key,intent_bytes) values(${input.epochId},${randomUUID()},${Buffer.from([1,2])})`;
  const later=await reserveMiningContribution(conn.db,wallet,command(after,3,otherBase,'1'),authority(otherBase),{clock:clock(after)});
  const nextClock=()=>new Date(Date.parse(after+'T12:00:00Z')+86400000);
  expect(await readResourceMiningEpoch(conn.db,{epochId:later.receipt!.epochId,day:after,policyVersion:3},nextClock).then(()=>null,leaf)).toContain('MINING_RESOURCE_PRIOR_UNDECIDED');
  await expect(reserveMiningContribution(conn.db,wallet,command(before,2,otherBase,'6000'),authority(otherBase),{clock:clock(before)})).rejects.toMatchObject({code:'MINING_FREE_CAP_EXCEEDED'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  expect((await reserveMiningContribution(conn.db,wallet,original,authority(),{clock:clock(after)})).receipt).toEqual(accepted.receipt);
  expect((await readMiningContribution(conn.db,wallet,current.idempotencyKey)).receipt).toEqual(now.receipt);
  expect((await readMiningContribution(conn.db,wallet,randomUUID())).status).toBe('unknown');
  for(const key of [`resource-mining-v2:${day}`,`resource-mining-v4:${after}`,'resource-mining-v3:2026-02-30',`resource-mining-v3:${after}:extra`,`resource-mining-v3:${day}`])
   await expect(conn.sql`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${randomUUID()},${key},clock_timestamp())`).rejects.toThrow();
  await expect(conn.sql.begin(async tx=>{await tx`set local transaction isolation level repeatable read`;await tx`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${randomUUID()},${'resource-mining-v3:'+after},clock_timestamp())`;})).rejects.toThrow('OWNER_ISOLATION');
  await expect(conn.sql.begin(async tx=>{await tx`alter table mining_resource_v3_cutover disable trigger mining_resource_v3_cutover_guard`;await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
  const role='kit_mining_'+randomUUID().replaceAll('-','');await conn.sql.unsafe(`create role ${role}`);
  try{await expect(conn.sql.begin(async tx=>{await tx.unsafe(`grant select,insert,update,delete,truncate on mining_resource_v3_cutover to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`insert into mining_resource_v3_cutover(singleton,first_day,policy_version) values(true,${after},3)`;})).rejects.toThrow();}
  finally{await conn.sql.unsafe(`drop role ${role}`);}
 }),180_000);
 it('installer waits for earlier epoch then refuses even an empty future epoch',async()=>fixture(async f=>{
  const writer=createDb(f.url,{max:1}),installer=createDb(f.url,{max:1});let release!:()=>void,started!:()=>void;
  const start=new Promise<void>(r=>started=r),hold=new Promise<void>(r=>release=r);
  try{
   const writing=writer.sql.begin(async tx=>{await tx`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${randomUUID()},${'resource-mining-v2:'+f.day},clock_timestamp())`;started();await hold;});
   await start;const install=installResourceMiningV3Cutover(installer.db,f.day).then(()=>null,e=>e);
   await waitForBlockedEpoch(f.conn);release();await writing;
   expect(leaf(await install)).toContain('MINING_RESOURCE_CUTOVER_EXISTING_EPOCH');
   expect(await f.conn.sql`select * from mining_resource_v3_cutover`).toHaveLength(0);
  }finally{release?.();await writer.sql.end();await installer.sql.end();}
 }),120_000);
 it('epoch writer starts before installer commit and sees new policy after waiting',async()=>fixture(async f=>{
  const installer=createDb(f.url,{max:1}),writer=createDb(f.url,{max:1});let release!:()=>void,started!:()=>void;
  const start=new Promise<void>(r=>started=r),hold=new Promise<void>(r=>release=r);
  try{
   const installing=installer.db.transaction(async tx=>{
    await tx.execute(sql`lock table mining_ingot_epochs in share row exclusive mode`);await ensureResourceMiningPolicy(tx,3);
    await tx.execute(sql`insert into mining_resource_v3_cutover(singleton,first_day,policy_version) values(true,${f.day}::date,3)`);started();await hold;
   });
   await start;const writing=writer.sql`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${randomUUID()},${'resource-mining-v2:'+f.day},clock_timestamp())`.then(()=>null,e=>e);
   await waitForBlockedEpoch(f.conn);release();await installing;
   expect(leaf(await writing)).toContain('MINING_RESOURCE_EPOCH_POLICY');
   await writer.sql`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${randomUUID()},${'resource-mining-v3:'+f.day},clock_timestamp())`;
   expect(await f.conn.sql`select epoch_key from mining_ingot_epochs`).toEqual([{epoch_key:'resource-mining-v3:'+f.day}]);
  }finally{release?.();await writer.sql.end();await installer.sql.end();}
 }),120_000);
});
