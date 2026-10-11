/** B6b reads committed proof only; admission or a terminal label is insufficient. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {createClanCharterEvents} from '../src/game/clanCharterEvents';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {ADMIN_DATABASE_URL} from './db-url';
import {randomWallet} from './helpers';

let f:ReturnType<typeof resourceClaimsDatabase>,actor:string,target:string;
beforeEach(async()=>{vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');f=resourceClaimsDatabase();await f.setup();actor=randomWallet();target=randomWallet();await f.sql`insert into players(wallet) values(${actor}),(${target})`;},120_000);
afterEach(async()=>{vi.unstubAllEnvs();await f?.close();},120_000);
async function reader(db=f.db){const {createClanCharterReconciliation}=await import('../src/game/clanCharterReconciliation');return createClanCharterReconciliation(db);}
async function admit(){const id=randomUUID();await f.sql`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${id},${actor},${target},1,'{}','{}',now()+interval '1 minute')`;return id;}

it('distinguishes absent admission and incomplete tracked combat without granting zero obligations',async()=>{
 const r=await reader();expect(Object.isFrozen(r)).toBe(true);expect(Object.keys(r)).toEqual(['read']);expect(await r.read(randomUUID())).toEqual({status:'untracked'});
 await createClanCharterEvents(f.db).initialize();const id=await admit();expect(await r.read(id)).toEqual({status:'held',reason:'terminal_missing'});await expect(r.read('bad-id')).rejects.toThrow();
});
it('holds altered admission rather than reporting absent or settled history',async()=>{
 await createClanCharterEvents(f.db).initialize();const id=await admit();await f.sql`update raids set created_at=created_at+interval '1 millisecond' where id=${id}`;
 expect(await (await reader()).read(id)).toEqual({status:'held',reason:'admission_mismatch'});
});
it('rejects transaction facades before reading any history',async()=>{
 await expect(f.db.transaction(async tx=>reader(tx as unknown as Db))).rejects.toMatchObject({code:'CLAN_CHARTER_RECONCILIATION_TOP_LEVEL'});
});
it('rejects a real nonowner connection even for missing history and after private read grants',async()=>{
 const role='charter_reconcile_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await f.sql.unsafe(`grant usage on schema public to ${role};grant select on all tables in schema public to ${role}`);
  const [database]=await f.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);await expect((await reader(runtime.db)).read(randomUUID())).rejects.toMatchObject({code:'CLAN_CHARTER_RECONCILIATION_OWNER'});
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});
