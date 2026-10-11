import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
let f:ReturnType<typeof resourceClaimsDatabase>,actor:string,member:string,other:string,clan:string,paid:string,free:string;
const migration=new URL('../drizzle/0217_clan_charter_member_fences.sql',import.meta.url);
beforeEach(async()=>{
 f=resourceClaimsDatabase();await f.setup();actor=randomUUID();member=randomUUID();other=randomUUID();clan=randomUUID();paid=randomUUID();free=randomUUID();
 await f.sql`insert into players(wallet) values(${actor}),(${member}),(${other})`;
 await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clan},${clan},${clan},${actor})`;
 await f.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clan}),(${member},${clan})`;
 await f.sql`insert into bases(id,owner_wallet,land_paid_at) values(${free},${actor},null),(${paid},${actor},now())`;
 await f.sql`insert into base_slots(wallet,slot,base_id,active) values(${actor},1,${free},true),(${actor},2,${paid},true)`;
 await f.sql`select * from shardkeep_clan_charter_event_source_initialize()`;
},120_000);
afterEach(async()=>{await f?.close();},120_000);
async function begin(key=randomUUID()){return (await f.sql`insert into clan_charter_member_fences(clan_id,actor_wallet,idempotency_key) values(${clan},${actor},${key}) returning *`)[0]!;}
async function raid(){const id=randomUUID();await f.sql`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${id},${actor},${other},1,'{}','{}',now())`;return id;}
async function repeat(file:URL){await f.sql.begin(async tx=>{for(const s of readFileSync(file,'utf8').split('--> statement-breakpoint'))if(s.trim())await tx.unsafe(s);});}
it('derives the entire private fence and captures every member with first eligible paid slot',async()=>{
 await raid();const requested=randomUUID(),key=randomUUID();const [header]=await f.sql`insert into clan_charter_member_fences(id,clan_id,actor_wallet,idempotency_key,chest_shards,raid_ordinal,roster_count,eligible_count,created_at,original_clan)
 values(${requested},${clan},${actor},${key},999,999,999,999,'2000-01-01','{}') returning *`;
 expect(header).toMatchObject({clan_id:clan,actor_wallet:actor,idempotency_key:key,chest_shards:'0',raid_ordinal:'1',roster_count:2,eligible_count:1});expect(header!.id).not.toBe(requested);
 const rows=await f.sql`select member_wallet,eligible,base_id,slot,original_base,original_slot from clan_charter_member_roster where fence_id=${header!.id}`;
 expect(rows).toHaveLength(2);expect(rows.find(r=>r.member_wallet===actor)).toMatchObject({eligible:true,base_id:paid,slot:2});expect(rows.find(r=>r.member_wallet===member)).toEqual({member_wallet:member,eligible:false,base_id:null,slot:null,original_base:null,original_slot:null});
});
it('refuses a nonleader and an inconsistent raid prefix without leaving a partial fence',async()=>{
 await expect(f.sql`insert into clan_charter_member_fences(clan_id,actor_wallet,idempotency_key) values(${clan},${member},${randomUUID()})`).rejects.toThrow('CLAN_CHARTER_MEMBER_LEADER');
 await raid();await f.sql.begin(async tx=>{await tx`alter table clan_charter_event_heads disable trigger clan_charter_event_heads_guard`;await tx`update clan_charter_event_heads set ordinal=ordinal+1 where clan_id=${clan}`;await tx`alter table clan_charter_event_heads enable trigger clan_charter_event_heads_guard`;});
 await expect(begin()).rejects.toThrow('CLAN_CHARTER_MEMBER_PREFIX');expect(await f.sql`select * from clan_charter_member_fences`).toHaveLength(0);expect(await f.sql`select * from clan_charter_member_roster`).toHaveLength(0);
});
it('rolls back failed roster capture and a forbidden later raid with its allocated ordinal',async()=>{
 const first=await raid();await f.sql`alter table clan_charter_member_roster add constraint fixture_no_members check(false)`;
 await expect(begin()).rejects.toMatchObject({code:'23514'});expect(await f.sql`select * from clan_charter_member_fences`).toHaveLength(0);
 await f.sql`alter table clan_charter_member_roster drop constraint fixture_no_members`;await begin();
 await expect(raid()).rejects.toThrow('CLAN_CHARTER_MEMBER_FENCED');
 expect(await f.sql`select raid_id from clan_charter_raid_events`).toEqual([{raid_id:first}]);expect(await f.sql`select ordinal from clan_charter_event_heads where clan_id=${clan}`).toEqual([{ordinal:'1'}]);
});
it('keeps the private header and roster immutable and rejects copied capture contexts',async()=>{
 const header=await begin();for(const t of ['clan_charter_member_fences','clan_charter_member_roster']){
  await expect(f.sql.unsafe(`delete from ${t}`)).rejects.toThrow('CLAN_CHARTER_MEMBER_IMMUTABLE');await expect(f.sql.unsafe(`truncate ${t} cascade`)).rejects.toThrow('CLAN_CHARTER_MEMBER_IMMUTABLE');
 }
 await expect(f.sql`update clan_charter_member_fences set chest_shards=chest_shards`).rejects.toThrow('CLAN_CHARTER_MEMBER_IMMUTABLE');await expect(f.sql`insert into clan_charter_member_roster select * from clan_charter_member_roster`).rejects.toMatchObject({code:'42501'});
 await f.sql`create table copied_charter_fences(like clan_charter_member_fences including defaults)`;
 await f.sql`create trigger clan_charter_member_fences_capture_roster after insert on copied_charter_fences for each row execute function shardkeep_clan_charter_capture_member_roster()`;
 await expect(f.sql`insert into copied_charter_fences select * from clan_charter_member_fences where id=${header.id}`).rejects.toThrow('CLAN_CHARTER_MEMBER_TRIGGER');
});
it('holds all fenced clan or membership rewrites while preserving chest-only positive updates',async()=>{
 await begin();await f.sql`update clans set chest_shards=chest_shards+10 where id=${clan}`;
 for(const statement of [`update clans set chest_shards=chest_shards-1 where id='${clan}'`,`update clans set name=name where id='${clan}'`,`delete from clans where id='${clan}'`,`delete from clan_members where player_wallet='${member}'`,`update clan_members set joined_at=joined_at where player_wallet='${member}'`,`truncate clans cascade`,`truncate clan_members cascade`])await expect(f.sql.unsafe(statement)).rejects.toThrow('CLAN_CHARTER_MEMBER_FENCED');
 const saved=await f.sql`select original_base,original_slot from clan_charter_member_roster where member_wallet=${actor}`;
 await f.sql`update bases set owner_wallet=${other},status='inactive' where id=${paid}`;await f.sql`delete from base_slots where base_id=${paid}`;
 expect(await f.sql`select original_base,original_slot from clan_charter_member_roster where member_wallet=${actor}`).toEqual(saved);
});
it('preserves the additive fence triggers and frozen history through old and new migration repeats',async()=>{
 await begin();const before=await f.sql`select to_jsonb(h) header,to_jsonb(r) roster from clan_charter_member_fences h join clan_charter_member_roster r on r.fence_id=h.id order by r.member_wallet`;
 for(const name of ['0215_clan_charter_raid_events.sql','0216_clan_charter_terminal_evidence.sql'])await repeat(new URL('../drizzle/'+name,import.meta.url));await repeat(migration);
 expect(await f.sql`select to_jsonb(h) header,to_jsonb(r) roster from clan_charter_member_fences h join clan_charter_member_roster r on r.fence_id=h.id order by r.member_wallet`).toEqual(before);
 await expect(raid()).rejects.toThrow('CLAN_CHARTER_MEMBER_FENCED');await expect(f.sql`delete from clan_members where player_wallet=${member}`).rejects.toThrow('CLAN_CHARTER_MEMBER_FENCED');
});
it('enforces boundaries for an ordinary LOGIN without private SELECT or accidental owner equivalence',async()=>{
 const role='charter_fence_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await f.sql.unsafe(`grant usage on schema public to ${role};grant select,insert,update,delete on clans,clan_members to ${role}`);const [database]=await f.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  await runtime.sql`insert into clan_members(player_wallet,clan_id) values(${other},${clan})`;await begin();
  await expect(runtime.sql`delete from clan_members where player_wallet=${other}`).rejects.toThrow('CLAN_CHARTER_MEMBER_FENCED');await runtime.sql`update clans set chest_shards=chest_shards+1 where id=${clan}`;
  for(const table of ['clan_charter_member_fences','clan_charter_member_roster'])await expect(runtime.sql.unsafe(`select * from ${table}`)).rejects.toMatchObject({code:'42501'});
  await f.sql.unsafe(`grant insert on clan_charter_member_fences,clan_charter_member_roster to ${role}`);
  await expect(runtime.sql`insert into clan_charter_member_fences(clan_id,actor_wallet,idempotency_key) values(${clan},${actor},${randomUUID()})`).rejects.toMatchObject({code:'42501'});
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});
