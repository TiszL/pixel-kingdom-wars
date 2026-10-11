import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
let f:ReturnType<typeof resourceClaimsDatabase>;
beforeEach(async()=>{f=resourceClaimsDatabase();await f.setup();vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');},120000);
afterEach(async()=>{try{await f?.close();}finally{vi.unstubAllEnvs();}},120000);

it('default-off legacy LOGIN preserves ordinary raid and stock writes without new private grants',async()=>{
 const actor=randomUUID(),defender=randomUUID(),base=randomUUID(),raid=randomUUID(),clan=randomUUID();
 await f.sql`insert into players(wallet) values(${actor}),(${defender})`;
 await f.sql`insert into bases(id,owner_wallet) values(${base},${actor})`;
 const role='tournament_old_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await f.sql.unsafe(`grant usage on schema public to ${role}; grant select,insert,update,delete on crafting_stocks to ${role}; grant insert,select,update on raids,clans,clan_members to ${role}; grant select on deed_economy_cutover_state to ${role}`);
  const [database]=await f.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  await runtime.sql`insert into clans(id,name,tag,leader_wallet) values(${clan},${clan},${clan},${actor})`;
  await runtime.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clan})`;
  await runtime.sql`insert into crafting_stocks(base_id,item_id,available) values(${base},'thornsilk',4)`;
  await runtime.sql`update crafting_stocks set available=3 where base_id=${base}`;
  await runtime.sql`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${raid},${actor},${defender},1,'{}','{}',now())`;
  await runtime.sql`update raids set status='expired' where id=${raid}`;
  expect(await f.sql`select available::text available from crafting_stocks where base_id=${base}`).toEqual([{available:'3'}]);
  expect(await f.sql`select status from raids where id=${raid}`).toEqual([{status:'expired'}]);
  for(const table of ['charter_tournament_events','charter_tournament_prize_claims','charter_tournament_raid_requests','charter_tournament_raid_admissions']){
   await expect(runtime.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({code:'42501'});
   await expect(runtime.sql.unsafe(`insert into public.${table} default values`)).rejects.toMatchObject({code:'42501'});
  }
  await expect(runtime.sql`select public.shardkeep_charter_tournament_stock_guard()`).rejects.toMatchObject({code:'42501'});
  await expect(runtime.sql`select public.shardkeep_charter_tournament_raid_capture()`).rejects.toMatchObject({code:'42501'});
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});

it('copied definer triggers cannot operate on substitute stock or raid tables',async()=>{
 await f.sql`create table copied_tournament_stock(like public.crafting_stocks including all)`;
 await f.sql`create trigger crafting_stocks_charter_tournament_guard before insert on copied_tournament_stock for each row execute function public.shardkeep_charter_tournament_stock_guard()`;
 await expect(f.sql`insert into copied_tournament_stock(base_id,item_id) values(${randomUUID()},'thornsilk')`).rejects.toThrow('CHARTER_TOURNAMENT_STOCK_TRIGGER');
 await f.sql`create table copied_tournament_raid(like public.raids including all)`;
 await f.sql`create trigger raids_charter_tournament_capture after insert on copied_tournament_raid for each row execute function public.shardkeep_charter_tournament_raid_capture()`;
 await expect(f.sql`insert into copied_tournament_raid(attacker_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${randomUUID()},1,'{}','{}',now())`).rejects.toThrow('CHARTER_TOURNAMENT_RAID_TRIGGER');
});
