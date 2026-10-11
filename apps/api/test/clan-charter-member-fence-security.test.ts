/** B6c real-connection admission races and historical roster integrity.
 * Fixtures seed clan/base rows; no payout or transfer authority is inferred. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {joinClan} from '../src/game/clans';
import {ADMIN_DATABASE_URL} from './db-url';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {randomWallet} from './helpers';

let f:ReturnType<typeof resourceClaimsDatabase>,leader:string,member:string,buyer:string,clan:string,leaderBase:string,memberBase:string;
beforeEach(async()=>{
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');f=resourceClaimsDatabase();await f.setup();
 leader=randomWallet();member=randomWallet();buyer=randomWallet();clan=randomUUID();leaderBase=randomUUID();memberBase=randomUUID();
 await f.sql`insert into players(wallet) values(${leader}),(${member}),(${buyer})`;
 await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clan},${clan},${clan},${leader})`;
 await f.sql`insert into clan_members(player_wallet,clan_id) values(${leader},${clan})`;
 await f.sql`insert into bases(id,owner_wallet,land_paid_at) values(${leaderBase},${leader},now()),(${memberBase},${member},now())`;
 await f.sql`insert into base_slots(wallet,slot,base_id) values(${leader},1,${leaderBase}),(${member},1,${memberBase})`;
 await f.sql`select * from shardkeep_clan_charter_event_source_initialize()`;
},120_000);
afterEach(async()=>{vi.unstubAllEnvs();await f?.close();},120_000);
async function facade(){return (await import('../src/game/clanCharterMemberFences')).createClanCharterMemberFences(f.db);}
type Writer=Pick<ReturnType<typeof resourceClaimsDatabase>['sql'],'unsafe'>;
async function insertFence(tx:Writer,key=randomUUID()){
 const [row]=await tx.unsafe('insert into clan_charter_member_fences(clan_id,actor_wallet,idempotency_key) values($1,$2,$3) returning id',[clan,leader,key]);return String(row!.id);
}
async function empty(){expect(await f.sql`select * from clan_charter_member_fences`).toHaveLength(0);expect(await f.sql`select * from clan_charter_member_roster`).toHaveLength(0);}
async function snapshot(){const data:Record<string,unknown>={};for(const table of ['clan_charter_member_fences','clan_charter_member_roster','clan_members','clans','accounts','ledger_transactions','ledger_entries'])data[table]=await f.sql.unsafe(`select to_jsonb(t)::text row from ${table} t order by to_jsonb(t)::text`);return data;}

for(const direction of ['join','leave'] as const)it(`refuses a fence during a pending ${direction} and snapshots only the committed roster on retry`,async()=>{
 if(direction==='leave')await joinClan(f.db,member,clan);
 const connection=f.reopen(),key=randomUUID();let ready!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const writer=connection.sql.begin(async tx=>{
  await tx`select id from clans where id=${clan} for update`;
  if(direction==='join')await tx`insert into clan_members(player_wallet,clan_id) values(${member},${clan})`;
  else await tx`delete from clan_members where player_wallet=${member} and clan_id=${clan}`;
  ready();await gate;
 });
 try{
  await Promise.race([entered,writer]);await expect(f.sql.begin(async tx=>{await tx`set local statement_timeout='3000ms'`;await insertFence(tx,key);})).rejects.toMatchObject({code:'55P03'});await empty();
 }finally{release();try{await writer;}finally{await connection.sql.end();}}
 const saved=await (await facade()).begin(leader,{clanId:clan,idempotencyKey:key});
 expect(saved.members.map(m=>m.wallet).sort()).toEqual((direction==='join'?[leader,member]:[leader]).sort());
 expect(saved.members.every(m=>m.eligibilityAtFence)).toBe(true);
 expect(await f.sql`select * from clan_charter_member_fences`).toHaveLength(1);
},30_000);

it('makes a real join waiting behind uncommitted fence capture refuse after that fence commits',async()=>{
 const connection=f.reopen();let ready!:()=>void,release!:()=>void,pid=0,id='';
 const entered=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const writer=connection.sql.begin(async tx=>{id=await insertFence(tx);pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;ready();await gate;});
 let joining:ReturnType<typeof joinClan>|undefined;
 try{
  await Promise.race([entered,writer]);joining=joinClan(f.db,member,clan);void joining.catch(()=>undefined);
  await expect.poll(async()=>(await f.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) and query like '%clans%') waiting`)[0]!.waiting).toBe(true);
  release();await writer;await expect(joining).rejects.toMatchObject({cause:{message:'CLAN_CHARTER_MEMBER_FENCED'}});
 }finally{release();try{await writer;}finally{await joining?.catch(()=>undefined);await connection.sql.end();}}
 expect(await f.sql`select * from clan_members where player_wallet=${member}`).toHaveLength(0);
 const saved=await (await facade()).read(id);expect(saved.members.map(m=>m.wallet)).toEqual([leader]);
 expect(await f.sql`select * from clan_charter_member_fences`).toHaveLength(1);
},30_000);

it('holds a pending base ownership change and excludes the transferred deed when fence capture retries',async()=>{
 await joinClan(f.db,member,clan);const connection=f.reopen(),key=randomUUID();let ready!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const writer=connection.sql.begin(async tx=>{await tx`update bases set owner_wallet=${buyer} where id=${memberBase}`;ready();await gate;});
 try{
  await Promise.race([entered,writer]);await expect(f.sql.begin(async tx=>{await tx`set local statement_timeout='3000ms'`;await insertFence(tx,key);})).rejects.toMatchObject({code:'55P03'});await empty();
 }finally{release();try{await writer;}finally{await connection.sql.end();}}
 const saved=await (await facade()).begin(leader,{clanId:clan,idempotencyKey:key});
 expect(saved.members.find(m=>m.wallet===member)).toEqual({wallet:member,eligibilityAtFence:false,baseId:null,slot:null});
 expect(saved.members.find(m=>m.wallet===leader)).toEqual({wallet:leader,eligibilityAtFence:true,baseId:leaderBase,slot:1});
},30_000);

it('refuses a membership writer whose real RR snapshot predates an independently committed fence',async()=>{
 await joinClan(f.db,member,clan);const connection=f.reopen(),key=randomUUID();
 try{
  await expect(connection.sql.begin('isolation level repeatable read',async tx=>{
   expect(await tx`select * from clan_charter_member_fences`).toHaveLength(0);
   await insertFence(f.sql,key);
   expect(await tx`select * from clan_charter_member_fences`).toHaveLength(0);
   await tx`delete from clan_members where player_wallet=${member} and clan_id=${clan}`;
  })).rejects.toThrow(/READ_COMMITTED/);
 }finally{await connection.sql.end();}
 expect(await f.sql`select * from clan_members where player_wallet=${member} and clan_id=${clan}`).toHaveLength(1);
 const [row]=await f.sql`select id from clan_charter_member_fences where idempotency_key=${key}`;
 expect((await (await facade()).read(String(row!.id))).members.map(m=>m.wallet).sort()).toEqual([leader,member].sort());
},30_000);

it('refuses transaction handles and a separate LOGIN even after accidental private SELECT and INSERT grants',async()=>{
 const make=(await import('../src/game/clanCharterMemberFences')).createClanCharterMemberFences;
 const saved=await make(f.db).begin(leader,{clanId:clan,idempotencyKey:randomUUID()});
 await f.db.transaction(async tx=>{expect(()=>Reflect.apply(make,undefined,[tx])).toThrow(expect.objectContaining({code:'CLAN_CHARTER_FENCE_TOP_LEVEL'}));});
 const role='fence_private_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await f.sql.unsafe(`grant usage on schema public to ${role};grant select,insert on clan_charter_member_fences,clan_charter_member_roster to ${role}`);
  const [database]=await f.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  expect(await runtime.sql`select id from clan_charter_member_fences`).toEqual([{id:saved.fenceId}]);
  const before=await snapshot(),capability=make(runtime.db);
  await expect(capability.read(saved.fenceId)).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_OWNER'});
  await expect(capability.begin(leader,{clanId:clan,idempotencyKey:saved.idempotencyKey})).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_OWNER'});
  await expect(capability.begin(leader,{clanId:clan,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_OWNER'});
  expect(await snapshot()).toEqual(before);
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
},30_000);

it('holds an owner-damaged missing roster child on read and exact-key replay without replacing the frozen graph',async()=>{
 await joinClan(f.db,member,clan);const events=await facade(),key=randomUUID(),saved=await events.begin(leader,{clanId:clan,idempotencyKey:key});
 // Deliberate owner storage corruption; restore the precise immutable guard
 // before invoking the normal facade. This is not a runtime-role exploit.
 await f.sql.begin(async tx=>{await tx`alter table clan_charter_member_roster disable trigger clan_charter_member_roster_guard`;await tx`delete from clan_charter_member_roster where fence_id=${saved.fenceId} and member_wallet=${member}`;await tx`alter table clan_charter_member_roster enable trigger clan_charter_member_roster_guard`;});
 const before=await snapshot();await expect(events.read(saved.fenceId)).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_HELD'});
 await expect(events.begin(leader,{clanId:clan,idempotencyKey:key})).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_HELD'});
 expect(await snapshot()).toEqual(before);expect((await f.sql`select tgenabled from pg_trigger where tgrelid='clan_charter_member_roster'::regclass and tgname='clan_charter_member_roster_guard'`)[0]!.tgenabled).toBe('O');
},30_000);

it('keeps the original eligible wallet after its historical base transfers without treating the buyer as a beneficiary',async()=>{
 await joinClan(f.db,member,clan);const events=await facade(),key=randomUUID(),saved=await events.begin(leader,{clanId:clan,idempotencyKey:key});
 expect(saved.members.find(m=>m.wallet===member)).toEqual({wallet:member,eligibilityAtFence:true,baseId:memberBase,slot:1});
 await f.sql`update bases set owner_wallet=${buyer} where id=${memberBase}`;
 await f.sql`delete from base_slots where wallet=${member} and base_id=${memberBase}`;
 await f.sql`insert into base_slots(wallet,slot,base_id) values(${buyer},1,${memberBase})`;
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
 expect(await events.read(saved.fenceId)).toEqual(saved);expect(await events.begin(leader,{clanId:clan,idempotencyKey:key})).toEqual(saved);
 expect(saved.members.some(m=>m.wallet===buyer)).toBe(false);
 expect(await f.sql`select id from ledger_transactions where type like 'clan.%'`).toHaveLength(0);
},30_000);
