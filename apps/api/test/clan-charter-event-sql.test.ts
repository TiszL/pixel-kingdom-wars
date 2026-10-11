import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';

let f:ReturnType<typeof resourceClaimsDatabase>,actor:string,defender:string,clan:string;
const migration=new URL('../drizzle/0215_clan_charter_raid_events.sql',import.meta.url);
beforeEach(async()=>{
 f=resourceClaimsDatabase();await f.setup();actor=randomUUID();defender=randomUUID();clan=randomUUID();
 await f.sql`insert into players(wallet) values(${actor}),(${defender})`;
 await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clan},${clan},${clan},${actor})`;
},120_000);
afterEach(async()=>{await f?.close();},120_000);
async function initialize(){return (await f.sql`select * from public.shardkeep_clan_charter_event_source_initialize()`)[0]!;}
async function raid(status='pending_orders',id=randomUUID()){
 await f.sql`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at,status)
 values(${id},${actor},${defender},1,'{}','{}',now()+interval '1 minute',${status}::raid_status)`;return id;
}
async function repeat(){await f.sql.begin(async tx=>{for(const statement of readFileSync(migration,'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});}

it('captures only prospective inserts and preserves its original source across migration repeats',async()=>{
 const old=await raid('resolved');expect(await f.sql`select * from clan_charter_raid_events`).toHaveLength(0);
 const source=await initialize();expect(source).toMatchObject({singleton:true});
 const id=await raid();const rows=await f.sql`select * from clan_charter_raid_events`;
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({raid_id:id,source_id:source.source_id,attacker_wallet:actor,defender_wallet:defender,kind:'legacy_pvp',original_clan_id:null,original_leader_wallet:null,clan_ordinal:null});
 expect((await f.sql`select admitted_at=created_at same from clan_charter_raid_events e join raids r on r.id=e.raid_id`)[0]!.same).toBe(true);
 await repeat();expect(await initialize()).toEqual(source);expect(await f.sql`select * from clan_charter_raid_events`).toEqual(rows);
 expect(await f.sql`select * from clan_charter_raid_events where raid_id=${old}`).toHaveLength(0);
});
it.each(['pending_orders','resolving'])('refuses enrollment over an existing %s raid, including direct owner source inserts',async status=>{
 await raid(status);await expect(initialize()).rejects.toThrow('CLAN_CHARTER_EVENT_PENDING_RAIDS');
 await expect(f.sql`insert into clan_charter_event_source(singleton,source_id,started_at) values(true,${randomUUID()},now())`).rejects.toThrow('CLAN_CHARTER_EVENT_PENDING_RAIDS');
 expect(await f.sql`select * from clan_charter_event_source`).toHaveLength(0);
});
it('allocates per-clan ordinals, rolls back aborted admission and retains unpriced history when dissolution holds',async()=>{
 await f.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clan})`;await initialize();
 const first=await raid();expect((await f.sql`select original_clan_id,original_leader_wallet,clan_ordinal from clan_charter_raid_events where raid_id=${first}`)[0]).toEqual({original_clan_id:clan,original_leader_wallet:actor,clan_ordinal:'1'});
 const failed=randomUUID();await expect(f.sql.begin(async tx=>{
  await tx`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${failed},${actor},${defender},1,'{}','{}',now())`;
  throw Error('fixture rollback');
 })).rejects.toThrow('fixture rollback');
 expect(await f.sql`select * from clan_charter_raid_events where raid_id=${failed}`).toHaveLength(0);
 const second=await raid();expect((await f.sql`select clan_ordinal from clan_charter_raid_events where raid_id=${second}`)[0]!.clan_ordinal).toBe('2');
 await expect(f.sql`delete from clans where id=${clan}`).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_RAID_CHEST_PENDING'});
 expect(await f.sql`select id,leader_wallet from clans where id=${clan}`).toEqual([{id:clan,leader_wallet:actor}]);
 expect(await f.sql`select player_wallet,clan_id from clan_members where player_wallet=${actor}`).toEqual([{player_wallet:actor,clan_id:clan}]);
 expect((await f.sql`select original_clan_id,original_leader_wallet from clan_charter_raid_events where raid_id=${first}`)[0]).toEqual({original_clan_id:clan,original_leader_wallet:actor});
 expect(await f.sql`select clan_id,ordinal from clan_charter_event_heads`).toEqual([{clan_id:clan,ordinal:'2'}]);
});
it('refuses mutation, truncation and direct counter or event fabrication',async()=>{
 await f.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clan})`;await initialize();await raid();
 for(const table of ['clan_charter_event_source','clan_charter_event_heads','clan_charter_raid_events']){
  await expect(f.sql.unsafe(`delete from public.${table}`)).rejects.toThrow('CLAN_CHARTER_EVENT_IMMUTABLE');
  await expect(f.sql.unsafe(`truncate public.${table} cascade`)).rejects.toThrow('CLAN_CHARTER_EVENT_IMMUTABLE');
 }
 await expect(f.sql`update clan_charter_event_source set started_at=started_at`).rejects.toThrow('CLAN_CHARTER_EVENT_IMMUTABLE');
 await expect(f.sql`update clan_charter_raid_events set admitted_at=admitted_at`).rejects.toThrow('CLAN_CHARTER_EVENT_IMMUTABLE');
 await expect(f.sql`update clan_charter_event_heads set ordinal=ordinal+1`).rejects.toMatchObject({code:'42501'});
 await expect(f.sql`insert into clan_charter_event_heads values(${randomUUID()},1)`).rejects.toMatchObject({code:'42501'});
 await expect(f.sql`insert into clan_charter_raid_events select * from clan_charter_raid_events`).rejects.toMatchObject({code:'42501'});
 const original=await f.sql`select * from clan_charter_raid_events`;
 // Deliberate owner-storage damage checks the table constraint independently
 // of the row guard. Failure rolls back the exact guard disable as well.
 await expect(f.sql.begin(async tx=>{
  await tx`alter table clan_charter_raid_events disable trigger clan_charter_raid_events_guard`;
  await tx`update clan_charter_raid_events set clan_ordinal=null`;
  await tx`alter table clan_charter_raid_events enable trigger clan_charter_raid_events_guard`;
 })).rejects.toMatchObject({code:'23514'});
 expect(await f.sql`select * from clan_charter_raid_events`).toEqual(original);
 expect((await f.sql`select tgenabled from pg_trigger where tgrelid='clan_charter_raid_events'::regclass and tgname='clan_charter_raid_events_guard'`)[0]!.tgenabled).toBe('O');
});
it('checks exact installed capture trigger identity and refuses direct or copied trigger calls',async()=>{
 await initialize();const [binding]=await f.sql`select t.tgenabled,p.proname from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid='raids'::regclass and t.tgname='raids_clan_charter_capture'`;
 expect(binding).toEqual({tgenabled:'O',proname:'shardkeep_clan_charter_capture_raid'});
 await expect(f.sql`select shardkeep_clan_charter_capture_raid()`).rejects.toThrow('trigger functions can only be called as triggers');
 await f.sql`create table copied_charter_raids(like raids including defaults)`;
 await f.sql`create trigger raids_clan_charter_capture after insert on copied_charter_raids for each row execute function shardkeep_clan_charter_capture_raid()`;
 await expect(f.sql`insert into copied_charter_raids(attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${actor},${defender},1,'{}','{}',now())`).rejects.toThrow('CLAN_CHARTER_EVENT_TRIGGER');
});
it('retains ordinary LOGIN raid insertion without private reads or privileged function execution',async()=>{
 await initialize();const role='charter_event_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  // The existing 0077 raid-scope guard reads this one legacy cutover table.
  await f.sql.unsafe(`grant usage on schema public to ${role};grant insert on raids to ${role};grant select on deed_economy_cutover_state to ${role}`);
  const [database]=await f.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  const id=randomUUID();await runtime.sql`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${id},${actor},${defender},1,'{}','{}',now())`;
  expect((await f.sql`select raid_id from clan_charter_raid_events where raid_id=${id}`)[0]!.raid_id).toBe(id);
  for(const table of ['clan_charter_event_source','clan_charter_event_heads','clan_charter_raid_events'])await expect(runtime.sql.unsafe(`select * from ${table}`)).rejects.toMatchObject({code:'42501'});
  await expect(runtime.sql`select * from shardkeep_clan_charter_event_source_initialize()`).rejects.toMatchObject({code:'42501'});
  await f.sql.unsafe(`grant insert on clan_charter_event_source,clan_charter_event_heads,clan_charter_raid_events to ${role};grant execute on function shardkeep_clan_charter_event_source_initialize() to ${role}`);
  await expect(runtime.sql`insert into clan_charter_event_heads values(${randomUUID()},1)`).rejects.toMatchObject({code:'42501'});
  await expect(runtime.sql`insert into clan_charter_event_source values(true,${randomUUID()},now())`).rejects.toMatchObject({code:'42501'});
  await expect(runtime.sql`select * from shardkeep_clan_charter_event_source_initialize()`).rejects.toMatchObject({code:'42501'});
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});
it('requires READ COMMITTED for initialization and every enrolled actual capture',async()=>{
 await expect(f.sql.begin('isolation level repeatable read',async tx=>{await tx`select * from shardkeep_clan_charter_event_source_initialize()`;})).rejects.toThrow('CLAN_CHARTER_EVENT_READ_COMMITTED');
 async function isolatedEventCapture(){
  // Reach the original installed AFTER capture independently of newer BEFORE
  // guards. Its exact rejection must roll back every temporary guard disable.
  // 2026-10-10 (CI 37503885235): 0264 (existing-clan migrations, f080124dc) added the BEFORE row guard
  // raids_migration_boundary, which refuses any raids write outside READ COMMITTED with
  // CLAN_CHARTER_MIGRATION_READ_COMMITTED first; it is one more newer guard to step past here.
  await expect(f.sql.begin('isolation level repeatable read',async tx=>{
   await tx`alter table raids disable trigger raids_charter_sale_source`;
   await tx`alter table raids disable trigger raids_clan_charter_raid_chest`;
   await tx`alter table raids disable trigger raids_migration_boundary`;
   await tx`insert into raids(attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${actor},${defender},1,'{}','{}',now())`;
  })).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_EVENT_READ_COMMITTED'});
  expect(await f.sql`select tgname,tgenabled from pg_trigger where tgrelid='raids'::regclass and tgname in('raids_charter_sale_source','raids_clan_charter_raid_chest','raids_migration_boundary') order by tgname`).toEqual([
   {tgname:'raids_charter_sale_source',tgenabled:'O'},{tgname:'raids_clan_charter_raid_chest',tgenabled:'O'},{tgname:'raids_migration_boundary',tgenabled:'O'},
  ]);
  for(const table of ['raids','clan_charter_raid_events','clan_charter_event_heads'])expect(await f.sql.unsafe(`select count(*)::int n from ${table}`)).toEqual([{n:0}]);
 }
 await isolatedEventCapture();
 // Refuse before looking up the source, so a pre-enrollment snapshot cannot
 // silently omit prospective capture after another transaction enrolls it.
 // D176's BEFORE sale guard now precedes the chest guard and B6a AFTER capture.
 await expect(f.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into raids(attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${actor},${defender},1,'{}','{}',now())`;})).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_SALE_READ_COMMITTED'});
 await expect(f.sql.begin('isolation level repeatable read',async tx=>{
  expect(await tx`select * from clan_charter_event_source`).toHaveLength(0);
  await initialize(); // Independent pool connection commits after the RR snapshot.
  expect(await tx`select * from clan_charter_event_source`).toHaveLength(0);
  await tx`insert into raids(attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${actor},${defender},1,'{}','{}',now())`;
 })).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_SALE_READ_COMMITTED'});
 await initialize();await expect(f.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into raids(attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${actor},${defender},1,'{}','{}',now())`;})).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_SALE_READ_COMMITTED'});
 await isolatedEventCapture();
 expect(await f.sql`select * from clan_charter_raid_events`).toHaveLength(0);
});
