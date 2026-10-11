/** Fixture history tests use the real activity capture and persisted SQL journal. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { collectMiningActivityEvidence } from '../src/mining/activityEvidence';
import { collectMiningWalletExperience, readMiningWalletExperience } from '../src/mining/walletExperience';
import { ADMIN_DATABASE_URL } from './db-url';
import { insertActiveTestBase } from './helpers';

const policyVersion=1 as const;
const input=(day:string)=>({day,policyVersion});
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>) {
  const f=await setup();
  try { await run(f); } finally {
    vi.unstubAllEnvs(); await f.conn.sql.end(); await f.admin.unsafe(`drop database ${f.database} with (force)`); await f.admin.end();
  }
}
async function setup() {
  const database=`mining_wallet_xp_${randomUUID().replaceAll('-','')}_test`;
  const url=new URL(ADMIN_DATABASE_URL); url.pathname=`/${database}`;
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('unsafe fixture host');
  const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});
  await admin.unsafe(`create database ${database}`);
  const conn=createDb(url.toString(),{max:4});
  try { await runMigrations(conn.db);
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');
  await conn.sql`update playtest_activity_coverage set started_at='2019-01-01T00:00:00Z' where key='authoritative-v1'`;
  const wallets=Array.from({length:3},()=>Keypair.generate().publicKey.toBase58());
  for(const wallet of wallets) await conn.sql`insert into players(wallet) values(${wallet})`;
  const bases=[randomUUID(),randomUUID(),randomUUID()];
  // Production bases always carry their owner's active slot; PvP capture (D153.235/238) requires it.
  for(let i=0;i<bases.length;i++) await insertActiveTestBase(conn.db,{id:bases[i]!,ownerWallet:wallets[i===1?0:i]!,status:'active'});
  const raid=async(day:string,opts:{wallet?:string;base?:string;opponent?:string|null;status?:'resolving'|'resolved'|'expired';stars?:number;at?:string;resolvedAt?:string;retreated?:boolean;campaignStage?:number|null;id?:string}={})=>{
    const id=opts.id??randomUUID(),wallet=opts.wallet??wallets[0]!,base=opts.base??bases[0]!;
    const accepted=opts.at??`${day}T12:00:00.000Z`,resolvedAt=opts.resolvedAt??`${day}T12:05:00.000Z`;
    await conn.sql`insert into raids(id,attacker_wallet,attacker_base_id,defender_wallet,defender_base_id,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status,bulk_deployment_accepted_at,created_at)
      values(${id},${wallet},${base},${opts.opponent??null},${opts.opponent?bases[2]!:null},${opts.opponent?null:opts.campaignStage===undefined?1:opts.campaignStage},1,'{}','{}','{"deploys":[{}],"heroDeploys":[]}',${accepted},'resolving',${accepted},${new Date(Date.parse(accepted)-1000).toISOString()})`;
    await conn.sql`update player_action_events set occurred_at=${accepted} where source_table='raids' and source_id=${id} and source_key='battle_fought'`;
    const finish=async(stars=opts.stars??1)=>{
      await conn.sql`update raids set status='resolved',result=${JSON.stringify({stars,retreated:opts.retreated??false})}::jsonb,resolved_at=${resolvedAt} where id=${id}`;
      await conn.sql`update player_action_events set occurred_at=${resolvedAt} where source_table='raids' and source_id=${id} and source_key in ('pve_battle','pvp_win')`;
    };
    if((opts.status??'resolved')==='resolved') await finish();
    if(opts.status==='expired') await conn.sql`update raids set status='expired' where id=${id}`;
    return {id,wallet,base,accepted,finish};
  };
  const redeploy=async(r:Awaited<ReturnType<typeof raid>>,at:string)=>{
    const [command]=await conn.sql`insert into raid_commands(raid_id,sequence,client_command_id,kind,payload,server_offset_ms,payload_hash,accepted_at)
      values(${r.id},(select coalesce(max(sequence),0)+1 from raid_commands where raid_id=${r.id}),${randomUUID()},'deploy','{}',1,'fixture',${at}) returning id::text`;
    await conn.sql`update player_action_events set occurred_at=${at} where source_table='raid_commands' and source_id=${command!.id}`;
  };
  const seal=async(day:string)=>{await collectMiningActivityEvidence(conn.db,{day,policyVersion:'battle-evidence-v1'});return collectMiningWalletExperience(conn.db,input(day));};
  return {database,url,admin,conn,wallets,bases,raid,redeploy,seal};
  } catch(error) {vi.unstubAllEnvs();await conn.sql.end();await admin.unsafe(`drop database ${database} with (force)`);await admin.end();throw error;}
}

describe('prospective wallet experience from sealed battle authority',()=>{
 it('keeps a closed XP cutoff unchanged when later days arrive and refuses open or malformed cutoffs',async()=>fixture(async f=>{
  await f.raid('2020-09-01');await f.seal('2020-09-01');
  const earlier=await readMiningWalletExperience(f.conn.db,f.wallets[0]!,'2020-09-01');
  expect(earlier.recordedXp).toBe(100);expect(earlier.coverage?.observedThroughDay).toBe('2020-09-01');
  await f.raid('2020-09-03');await f.seal('2020-09-03');
  expect(await readMiningWalletExperience(f.conn.db,f.wallets[0]!,'2020-09-01')).toEqual(earlier);
  const later=await readMiningWalletExperience(f.conn.db,f.wallets[0]!,'2020-09-03');
  expect(later.recordedXp).toBe(200);expect(later.coverage?.unprocessedDays).toEqual(['2020-09-02']);
  expect((await readMiningWalletExperience(f.conn.db,f.wallets[0]!)).recordedXp).toBe(200);
  for(const cutoff of ['2020-02-31','not-a-day','9999-12-31'])await expect(readMiningWalletExperience(f.conn.db,f.wallets[0]!,cutoff)).rejects.toMatchObject({code:'INVALID_INPUT'});
 }),30_000);
 it('awards fourteen actual days, caps each wallet day deterministically and survives transfer/reconnect/pause',async()=>fixture(async f=>{
  const expected=[];
  for(let i=1;i<=14;i++){const day=`2020-01-${String(i).padStart(2,'0')}`;const raids=[];
   for(let j=4;j>=1;j--)raids.push(await f.raid(day,{id:`00000000-0000-4000-8000-${String(i*10+j).padStart(12,'0')}`}));
   expected.push({day,ids:raids.map(r=>r.id).sort().slice(0,3)});
  }
  const original=[];for(const e of expected){const r=await f.seal(e.day);expect(r.wallets).toEqual([{wallet:f.wallets[0],qualifyingRaidIds:expect.any(Array),awardedRaidIds:e.ids,awardedXp:300,activityBps:10000}]);original.push(r);}
  const current=await readMiningWalletExperience(f.conn.db,f.wallets[0]!);expect(current).toMatchObject({recordedXp:4200,recordedXpBps:10000,allocationReady:false,publicationAuthorized:false});
  expect(current.coverage?.recordedDays).toHaveLength(14);expect(current.coverage?.firstRecordedDay).toBe('2020-01-01');expect(current.coverage?.unprocessedDays.length).toBeGreaterThan(0);
  expect(current.coverage?.priorSourceRange).toMatchObject({from:'2019-01-01',through:'2019-12-31'});
  await f.conn.sql`update bases set owner_wallet=${f.wallets[2]!} where id=${f.bases[0]!}`;vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const other=createDb(f.url.toString(),{max:1});try{for(let i=0;i<expected.length;i++)expect(await collectMiningWalletExperience(other.db,input(expected[i]!.day))).toEqual(original[i]);expect((await readMiningWalletExperience(other.db,f.wallets[0]!)).recordedXp).toBe(4200);}finally{await other.sql.end();}
  const migration=readFileSync(new URL('../drizzle/0164_mining_wallet_experience.sql',import.meta.url),'utf8');for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await f.conn.sql.unsafe(statement);
  expect(await collectMiningWalletExperience(f.conn.db,input(expected[0]!.day))).toEqual(original[0]);
  await expect(f.conn.sql`update mining_wallet_experience_awards set points=1`).rejects.toThrow('IMMUTABLE');await expect(f.conn.sql`truncate mining_wallet_experience_days cascade`).rejects.toThrow('IMMUTABLE');
 }),60_000);
 it('waits for sealed delayed resolution, assigns redeploys once to the first day, and excludes PvP/retreat/noncampaign sources',async()=>fixture(async f=>{
  const r=await f.raid('2020-02-01',{status:'resolving',at:'2020-02-01T23:59:59.000Z',resolvedAt:'2020-02-02T00:00:02.000Z'});
  await f.redeploy(r,'2020-02-02T00:00:01.000Z');
  await expect(collectMiningWalletExperience(f.conn.db,input('2020-02-01'))).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  await expect(f.seal('2020-02-01')).rejects.toMatchObject({code:'PENDING_BATTLES'});await r.finish();
  await f.raid('2020-02-01',{opponent:f.wallets[2]!});await f.raid('2020-02-01',{retreated:true});await f.raid('2020-02-01',{campaignStage:null});await f.raid('2020-02-01',{stars:0});
  expect((await f.seal('2020-02-01')).wallets).toEqual([{wallet:f.wallets[0],qualifyingRaidIds:[r.id],awardedRaidIds:[r.id],awardedXp:100,activityBps:3333}]);
  expect((await f.seal('2020-02-02')).wallets).toEqual([]);expect((await readMiningWalletExperience(f.conn.db,f.wallets[0]!)).recordedXp).toBe(100);
 }),30_000);
 it('fails closed on forged input, source contradiction, missing coverage and paused new capture',async()=>fixture(async f=>{
  for(const extra of [{xp:1},{wallet:f.wallets[0]},{now:'2020-03-03'},{eligible:true}])await expect(collectMiningWalletExperience(f.conn.db,{...input('2020-03-01'),...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  const r=await f.raid('2020-03-01');await f.conn.sql`update player_action_events set metadata=metadata||'{"stars":2}' where source_id=${r.id} and source_key='pve_battle'`;
  await expect(f.seal('2020-03-01')).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await f.conn.sql`delete from playtest_activity_coverage`;await expect(f.seal('2020-03-02')).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');await expect(collectMiningWalletExperience(f.conn.db,input('2020-03-02'))).rejects.toMatchObject({code:'DISABLED'});
  expect(await f.conn.sql`select * from mining_wallet_experience_days`).toHaveLength(0);
 }),30_000);
 it('keeps day results order independent and distinguishes source gaps from zero awards',async()=>fixture(async f=>{
  await f.raid('2020-04-01');await f.raid('2020-04-03');const later=await f.seal('2020-04-03');await f.seal('2020-04-01');expect(await f.seal('2020-04-03')).toEqual(later);
  const read=await readMiningWalletExperience(f.conn.db,f.wallets[0]!);expect(read.recordedXp).toBe(200);expect(read.coverage?.unprocessedDays).toContain('2020-04-02');
  await f.seal('2020-04-02');expect((await readMiningWalletExperience(f.conn.db,f.wallets[0]!)).coverage?.unprocessedDays).not.toContain('2020-04-02');
 }),30_000);
 it('rejects broadly granted runtime journals and awards and source relabelling',async()=>fixture(async f=>{
  await f.raid('2020-05-01');await f.seal('2020-05-01');const role=`xp_runtime_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role}`);
  try{await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);await f.conn.sql.unsafe(`grant select,insert,update,delete on all tables in schema public to ${role}`);
   for(const table of ['mining_wallet_experience_days','mining_wallet_experience_awards'])await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`select set_config('shardkeep.mining_xp_owner','true',true)`;await tx.unsafe(`insert into ${table} select * from ${table}`);})).rejects.toThrow('MINING_WALLET_XP_OWNER_REQUIRED');
  }finally{await f.conn.sql.unsafe(`drop owned by ${role}`);await f.conn.sql.unsafe(`drop role ${role}`);}
  await expect(f.conn.sql`insert into mining_wallet_experience_awards select ${randomUUID()}::uuid,day,policy_version,wallet,base_id,first_accepted_at,points,source_hash from mining_wallet_experience_awards`).rejects.toThrow('SOURCE');
 }),30_000);
 it('refuses active journal writers and rolls back a rejected award with its day seal',async()=>fixture(async f=>{
  await f.raid('2020-06-01');await collectMiningActivityEvidence(f.conn.db,{day:'2020-06-01',policyVersion:'battle-evidence-v1'});
  let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>{release=r}),locked=new Promise<void>(r=>{ready=r});const writer=f.conn.sql.begin(async tx=>{await tx`lock table mining_activity_evidence in row exclusive mode`;ready();await gate;});
  try{await locked;await expect(collectMiningWalletExperience(f.conn.db,input('2020-06-01'))).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  await f.conn.sql`create function refuse_xp() returns trigger language plpgsql as $$ begin raise exception 'fixture XP refusal'; end $$`;
  await f.conn.sql`create trigger fixture_xp before insert on mining_wallet_experience_awards for each row execute function refuse_xp()`;
  await expect(collectMiningWalletExperience(f.conn.db,input('2020-06-01'))).rejects.toThrow();expect(await f.conn.sql`select * from mining_wallet_experience_days`).toHaveLength(0);
  await f.conn.sql`drop trigger fixture_xp on mining_wallet_experience_awards`;expect((await collectMiningWalletExperience(f.conn.db,input('2020-06-01'))).wallets[0]?.awardedXp).toBe(100);
 }),30_000);
 it('rejects a direct incomplete day seal at commit without losing its source or permitting partial XP',async()=>fixture(async f=>{
  const day='2020-07-01';await f.raid(day);await collectMiningActivityEvidence(f.conn.db,{day,policyVersion:'battle-evidence-v1'});
  // Obtain a valid owner-produced seal, including its real source/hash, then
  // roll it back. The direct SQL attempt omits only its required award row.
  let seal!:Record<string,unknown>;const rollback=new Error('fixture capture rollback');
  await expect(f.conn.db.transaction(async tx=>{
   await collectMiningWalletExperience(tx as unknown as typeof f.conn.db,input(day));
   seal=(await tx.execute(sql`select * from mining_wallet_experience_days where day=${day}::date`))[0]!;
   throw rollback;
  })).rejects.toBe(rollback);
  await expect(f.conn.sql.begin(async tx=>{
   await tx`insert into mining_wallet_experience_days select * from jsonb_populate_record(null::mining_wallet_experience_days,${JSON.stringify(seal)}::jsonb)`;
  })).rejects.toThrow('MINING_WALLET_XP_INCOMPLETE');
  expect(await f.conn.sql`select * from mining_wallet_experience_days`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_wallet_experience_awards`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_activity_evidence where day=${day}::date`).toHaveLength(1);
  expect((await collectMiningWalletExperience(f.conn.db,input(day))).wallets[0]?.awardedXp).toBe(100);
 }),30_000);
 it('caps XP by unequal deployment time before UUID order and uses UUID only to break a time tie',async()=>fixture(async f=>{
  const day='2020-08-01',id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  // Lowest UUID is the latest deployment; insertion order also differs from
  // eligibility order. Neither may displace an earlier participating raid.
  await f.raid(day,{id:id(1),at:`${day}T12:00:00.000Z`});
  await f.raid(day,{id:id(9),at:`${day}T10:00:00.000Z`});
  await f.raid(day,{id:id(2),at:`${day}T11:00:00.000Z`});
  await f.raid(day,{id:id(8),at:`${day}T10:00:00.000Z`});
  const result=await f.seal(day);
  expect(result.wallets).toEqual([{wallet:f.wallets[0],qualifyingRaidIds:[id(8),id(9),id(2),id(1)],
   awardedRaidIds:[id(8),id(9),id(2)],awardedXp:300,activityBps:10000}]);
  const awards=await f.conn.sql`select raid_id from mining_wallet_experience_awards order by first_accepted_at,raid_id`;
  expect(awards.map(a=>a.raid_id)).toEqual([id(8),id(9),id(2)]);
  expect((await readMiningWalletExperience(f.conn.db,f.wallets[0]!)).recordedXp).toBe(300);
 }),30_000);

});
