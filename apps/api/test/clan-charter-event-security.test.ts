/** Admission capture must serialize membership absence as well as presence.
 * These are real independent-connection races at the SQL source boundary;
 * actual raid gameplay acceptance is covered by clan-charter-events.test.ts. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {joinClan,leaveClan} from '../src/game/clans';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {randomWallet} from './helpers';

let f:ReturnType<typeof resourceClaimsDatabase>,actor:string,leader:string,defender:string,clan:string;
beforeEach(async()=>{
 vi.stubEnv('MULTI_BASE_ENABLED','false');f=resourceClaimsDatabase();await f.setup();
 actor=randomWallet();leader=randomWallet();defender=randomWallet();clan=randomUUID();
 await f.sql`insert into players(wallet) values(${actor}),(${leader}),(${defender})`;
 await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clan},${'Race '+clan},${clan},${leader})`;
 await f.sql`insert into clan_members(player_wallet,clan_id) values(${leader},${clan})`;
 await f.sql`select * from public.shardkeep_clan_charter_event_source_initialize()`;
},120_000);
afterEach(async()=>{vi.unstubAllEnvs();await f?.close();},120_000);

type Writer=Pick<ReturnType<typeof resourceClaimsDatabase>['sql'],'unsafe'>;
async function admit(tx:Writer,id=randomUUID()){
 await tx.unsafe("insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at,status) values($1,$2,$3,1,'{}','{}',now()+interval '1 minute','pending_orders')",[id,actor,defender]);return id;
}
async function snapshot(){
 const result:Record<string,unknown>={};
 for(const table of ['raids','clan_charter_event_source','clan_charter_event_heads','clan_charter_raid_events'])result[table]=await f.sql.unsafe(`select to_jsonb(t)::text row from ${table} t order by to_jsonb(t)::text`);
 return result;
}
async function event(id:string){return (await f.sql`select raid_id,attacker_wallet,original_clan_id,original_leader_wallet,clan_ordinal from clan_charter_raid_events where raid_id=${id}`)[0];}

for(const direction of ['join','leave'] as const)it(`refuses capture during an uncommitted ${direction}, then retries against the committed membership`,async()=>{
 if(direction==='leave')await joinClan(f.db,actor,clan);
 const before=await snapshot(),other=f.reopen(),id=randomUUID();let ready!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const writer=other.sql.begin(async tx=>{
  // The real membership writers lock the clan before their INSERT/DELETE.
  // Keep that mutation uncommitted to expose both the absence and presence race.
  await tx`select id from clans where id=${clan} for update`;
  if(direction==='join')await tx`insert into clan_members(player_wallet,clan_id) values(${actor},${clan})`;
  else await tx`delete from clan_members where player_wallet=${actor} and clan_id=${clan}`;
  ready();await gate;
 });
 try{
  await entered;
  // A broken blocking implementation must fail this exact NOWAIT assertion,
  // rather than making the test wait forever for its own holder to release.
  await expect(f.sql.begin(async tx=>{await tx`set local statement_timeout='3000ms'`;await admit(tx,id);})).rejects.toMatchObject({code:'55P03'});
  expect(await snapshot()).toEqual(before);
 }finally{release();await writer;await other.sql.end();}
 await admit(f.sql,id);
 expect(await event(id)).toEqual({raid_id:id,attacker_wallet:actor,original_clan_id:direction==='join'?clan:null,original_leader_wallet:direction==='join'?leader:null,clan_ordinal:direction==='join'?'1':null});
 expect(await f.sql`select clan_id,ordinal from clan_charter_event_heads`).toEqual(direction==='join'?[{clan_id:clan,ordinal:'1'}]:[]);
},30_000);

it('captures none before a waiting real join, and the original clan before a waiting real leave',async()=>{
 const ids:string[]=[];
 for(const direction of ['join','leave'] as const){
  const other=f.reopen(),id=randomUUID();let ready!:()=>void,release!:()=>void,pid=0;
  const entered=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
  const capture=other.sql.begin(async tx=>{await admit(tx,id);pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;ready();await gate;});
  let change:ReturnType<typeof joinClan>|ReturnType<typeof leaveClan>|undefined;
  try{
   await entered;change=direction==='join'?joinClan(f.db,actor,clan):leaveClan(f.db,actor);void change.catch(()=>undefined);
   await expect.poll(async()=>(await f.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) and (query like '%clan_members%' or query like '%clans%')) waiting`)[0]!.waiting).toBe(true);
   release();await capture;await change;
  }finally{release();await capture;await change?.catch(()=>undefined);await other.sql.end();}
  ids.push(id);
  expect(await event(id)).toEqual({raid_id:id,attacker_wallet:actor,original_clan_id:direction==='join'?null:clan,original_leader_wallet:direction==='join'?null:leader,clan_ordinal:direction==='join'?null:'1'});
 }
 expect(await f.sql`select * from clan_members where player_wallet=${actor}`).toHaveLength(0);
 expect(await event(ids[0]!)).toMatchObject({original_clan_id:null,clan_ordinal:null});
 expect(await event(ids[1]!)).toMatchObject({original_clan_id:clan,clan_ordinal:'1'});
 expect(await f.sql`select clan_id,ordinal from clan_charter_event_heads`).toEqual([{clan_id:clan,ordinal:'1'}]);
},30_000);

it('refuses a busy clan mutex even without a membership write and consumes no ordinal until retry',async()=>{
 await joinClan(f.db,actor,clan);const before=await snapshot(),id=randomUUID(),other=f.reopen();let ready!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const holder=other.sql.begin(async tx=>{await tx`select id from clans where id=${clan} for update`;ready();await gate;});
 try{
  await entered;await expect(f.sql.begin(async tx=>{await tx`set local statement_timeout='3000ms'`;await admit(tx,id);})).rejects.toMatchObject({code:'55P03'});
  expect(await snapshot()).toEqual(before);
 }finally{release();await holder;await other.sql.end();}
 await admit(f.sql,id);expect(await event(id)).toMatchObject({original_clan_id:clan,original_leader_wallet:leader,clan_ordinal:'1'});
 expect(await f.sql`select clan_id,ordinal from clan_charter_event_heads`).toEqual([{clan_id:clan,ordinal:'1'}]);
},30_000);
