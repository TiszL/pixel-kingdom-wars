/** Private facade boundaries; raw headers here exercise stored-read integrity.
 * Actual gameplay and money conservation live in clan-charter-events.test.ts. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {createClanCharterEvents} from '../src/game/clanCharterEvents';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {ADMIN_DATABASE_URL} from './db-url';
import {randomWallet} from './helpers';

let f:ReturnType<typeof resourceClaimsDatabase>,actor:string,defender:string,clanId:string;
beforeEach(async()=>{vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');f=resourceClaimsDatabase();await f.setup();actor=randomWallet();defender=randomWallet();clanId=randomUUID();await f.sql`insert into players(wallet) values(${actor}),(${defender})`;await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clanId},${clanId},${clanId},${actor})`;},120_000);
afterEach(async()=>{vi.unstubAllEnvs();await f?.close();},120_000);
async function admit(member=false){if(member)await f.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clanId})`;const id=randomUUID();await f.sql`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${id},${actor},${defender},1,'{}','{}',now()+interval '1 minute')`;return id;}
async function ownerUrl(){const [database]=await f.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;return url;}

it('requires both exact initial flags, replays its committed source while paused, and returns only copied admission facts',async()=>{
 const events=createClanCharterEvents(f.db);expect(Object.isFrozen(events)).toBe(true);expect(Object.keys(events).sort()).toEqual(['initialize','read']);
 for(const [multi,charter] of [['false','true'],['true','false'],['true','TRUE'],['true','1'],['TRUE','true']]){vi.stubEnv('MULTI_BASE_ENABLED',multi);vi.stubEnv('PHASE_E_CHARTER_ENABLED',charter);await expect(events.initialize()).rejects.toMatchObject({code:'CLAN_CHARTER_EVENT_DISABLED'});expect(await f.sql`select * from clan_charter_event_source`).toHaveLength(0);}
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');const source=await events.initialize();expect(Object.keys(source).sort()).toEqual(['sourceId','startedAt']);expect(source.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
 vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');expect(await events.initialize()).toEqual(source);expect(await events.read(randomUUID())).toEqual({status:'untracked',event:null});const id=await admit(),first=await events.read(id);expect(first.status).toBe('captured');if(first.status!=='captured')throw Error('expected captured admission');
 expect(Object.keys(first.event).sort()).toEqual(['raidId','sourceId','actorWallet','attackerBaseId','defenderWallet','defenderBaseId','pveCampId','campaignStage','kind','originalClanId','originalLeaderWallet','clanOrdinal','admittedAt'].sort());expect(first.event.admittedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);expect(first.event.originalClanId).toBeNull();const saved=structuredClone(first);first.event.actorWallet=defender;source.sourceId=randomUUID();expect(await events.read(id)).toEqual(saved);expect(await events.initialize()).toMatchObject({sourceId:saved.event.sourceId});await expect(events.read('not-a-raid')).rejects.toThrow();
});

it('rejects an outer transaction and a nonowner facade even after accidental private table and function grants',async()=>{
 await expect(f.db.transaction(async tx=>createClanCharterEvents(tx as unknown as Db))).rejects.toMatchObject({code:'CLAN_CHARTER_EVENT_TOP_LEVEL'});
 const source=await createClanCharterEvents(f.db).initialize(),id=await admit(),role='charter_reader_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{await f.sql.unsafe(`grant usage on schema public to ${role};grant all on clan_charter_event_source,clan_charter_event_heads,clan_charter_raid_events to ${role};grant execute on function shardkeep_clan_charter_event_source_initialize() to ${role}`);const url=await ownerUrl();url.username=role;url.password=password;runtime=createDb(url.toString());const denied=createClanCharterEvents(runtime.db);
  expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);await expect(denied.initialize()).rejects.toMatchObject({code:'CLAN_CHARTER_EVENT_OWNER'});await expect(denied.read(id)).rejects.toMatchObject({code:'CLAN_CHARTER_EVENT_OWNER'});await expect(denied.read(randomUUID())).rejects.toMatchObject({code:'CLAN_CHARTER_EVENT_OWNER'});expect(await createClanCharterEvents(f.db).initialize()).toEqual(source);
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});

it('opens initialization at READ COMMITTED even when its actual owner connection defaults to a stale-snapshot isolation',async()=>{
 const owner=createDb((await ownerUrl()).toString(),{max:1});try{await owner.sql`set default_transaction_isolation='repeatable read'`;expect((await owner.sql`show default_transaction_isolation`)[0]!.default_transaction_isolation).toBe('repeatable read');const source=await createClanCharterEvents(owner.db).initialize();expect(source.sourceId).toEqual(expect.any(String));const id=await admit();expect(await createClanCharterEvents(owner.db).read(id)).toMatchObject({status:'captured',event:{sourceId:source.sourceId}});}finally{await owner.sql.end();}
});

it('holds a captured record whose original persisted raid identity no longer agrees, rather than downgrading it to untracked',async()=>{
 const events=createClanCharterEvents(f.db);await events.initialize();const id=await admit();expect((await events.read(id)).status).toBe('captured');
 // Explicit owner storage corruption: this is not a runtime permission bypass.
 await f.sql`update raids set created_at=created_at+interval '1 millisecond' where id=${id}`;
 await expect(events.read(id)).rejects.toMatchObject({code:'CLAN_CHARTER_EVENT_HELD'});expect(await events.read(randomUUID())).toEqual({status:'untracked',event:null});expect(await f.sql`select * from clan_charter_raid_events where raid_id=${id}`).toHaveLength(1);
});

it('holds a captured clan event with a missing committed counter graph instead of treating it as clanless or untracked',async()=>{
 const events=createClanCharterEvents(f.db);await events.initialize();const id=await admit(true);expect(await events.read(id)).toMatchObject({status:'captured',event:{originalClanId:clanId,clanOrdinal:'1'}});
 // Simulate owner-level storage damage only; restore every guard before read.
 await f.sql`alter table clan_charter_event_heads disable trigger clan_charter_event_heads_guard`;try{await f.sql`delete from clan_charter_event_heads where clan_id=${clanId}`;}finally{await f.sql`alter table clan_charter_event_heads enable trigger clan_charter_event_heads_guard`;}
 await expect(events.read(id)).rejects.toMatchObject({code:'CLAN_CHARTER_EVENT_HELD'});expect(await f.sql`select * from clan_charter_raid_events where raid_id=${id}`).toHaveLength(1);
});
