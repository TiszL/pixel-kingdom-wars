import {existsSync,readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {vehicleServicePreparationFixture,vehicleServiceInstalledFixture,vehicleServiceConsentFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceExpeditions} from './fixtures/vehicleService';
import {createVehicleServiceApplications} from '../src/game/vehicleServiceApplications';

let f:Awaited<ReturnType<typeof vehicleServicePreparationFixture>>;
const migration=new URL('../drizzle/0214_vehicle_service_applications.sql',import.meta.url);
async function migrate(file:URL){await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(file,'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});}
beforeEach(async()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');f=await vehicleServicePreparationFixture();if(existsSync(migration))await migrate(migration);},120_000);
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function proof(){const p=await f.preparations.prepare(f.actor,f.intent.id),signed=f.finalizeService(p);return f.reader.verify({reservationId:f.intent.id,signedTransaction:signed.signedTransaction});}
async function apply(){const evidence=await proof();await f.conn.sql.begin(async tx=>{await tx`insert into vehicle_service_consumptions(intent_id,proof) values(${f.intent.id},${JSON.stringify(evidence)}::jsonb)`;await tx`insert into vehicle_service_applications(intent_id) values(${f.intent.id})`;});return evidence;}
async function expectActiveGuards(){
 const bindings:[string,string][]=[...['advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies'].map((table):[string,string]=>[table,'shardkeep_advanced_expedition_guard_v214']),['vehicle_service_intents','shardkeep_vehicle_service_intent_guard_v214'],['vehicle_service_burn_preparations','shardkeep_vehicle_service_preparation_guard_v214'],...['vehicle_service_consumptions','vehicle_service_applications'].map((table):[string,string]=>[table,'shardkeep_vehicle_service_application_guard_v214'])];
 const expected=bindings.flatMap(([table,fn])=>['_guard','_no_truncate'].map(suffix=>({table_name:table,tgname:table+suffix,proname:fn,tgenabled:'O'})));
 expected.push({table_name:'advanced_expeditions',tgname:'advanced_vehicle_service_exclusion',proname:'shardkeep_vehicle_service_departure_exclusion_v214',tgenabled:'O'});
 const rows=await f.conn.sql`select c.relname table_name,t.tgname,p.proname,t.tgenabled from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and t.tgname=any(${expected.map(row=>row.tgname)})`;
 expect(rows.sort((a,b)=>a.tgname.localeCompare(b.tgname))).toEqual(expected.sort((a,b)=>a.tgname.localeCompare(b.tgname)));
}

it('projects an actual signed upgrade from its immutable complete service pair',async()=>{
 const original=await f.conn.sql`select * from advanced_vehicle_installations`,evidence=await apply();
 const [state]=await f.conn.sql`select * from shardkeep_vehicle_lifecycle(${f.reservation.id}::uuid)`;
 expect(state).toMatchObject({installation_id:f.reservation.id,base_id:f.baseId,berth_id:f.intent.state.berthId,family:f.intent.state.family,tier:f.intent.state.tier+1,revision:'1',completed_total:'0',allowance_start:'0',pending_intent_id:null,away:false});
 expect(await f.conn.sql`select proof from vehicle_service_consumptions`).toEqual([{proof:evidence}]);expect(await f.conn.sql`select * from advanced_vehicle_installations`).toEqual(original);
});
it.each(['consumption','application'])('rolls back an incomplete %s half without resolving original consent',async half=>{
 const evidence=await proof(),attempt=f.conn.sql.begin(async tx=>{if(half==='consumption')await tx`insert into vehicle_service_consumptions(intent_id,proof) values(${f.intent.id},${JSON.stringify(evidence)}::jsonb)`;else await tx`insert into vehicle_service_applications(intent_id) values(${f.intent.id})`;});
 if(half==='consumption')await expect(attempt).rejects.toThrow('VEHICLE_SERVICE_APPLICATION_INCOMPLETE');else await expect(attempt).rejects.toMatchObject({code:'P0002'});
 expect(await f.conn.sql`select * from vehicle_service_consumptions`).toHaveLength(0);expect(await f.conn.sql`select * from vehicle_service_applications`).toHaveLength(0);
 expect((await f.conn.sql`select pending_intent_id from shardkeep_vehicle_lifecycle(${f.reservation.id}::uuid)`)[0]!.pending_intent_id).toBe(f.intent.id);
});
it('retains immutable complete history after early constraint flush',async()=>{
 const evidence=await proof();await f.conn.sql.begin(async tx=>{await tx`insert into vehicle_service_consumptions(intent_id,proof) values(${f.intent.id},${JSON.stringify(evidence)}::jsonb)`;await tx`insert into vehicle_service_applications(intent_id) values(${f.intent.id})`;await tx`set constraints all immediate`;
  await expect(tx.savepoint(async save=>{await save`update vehicle_service_applications set tier_after=tier_after where intent_id=${f.intent.id}`;})).rejects.toThrow('VEHICLE_SERVICE_APPLICATION_IMMUTABLE');
  await expect(tx.savepoint(async save=>{await save`delete from vehicle_service_consumptions where intent_id=${f.intent.id}`;})).rejects.toThrow('VEHICLE_SERVICE_APPLICATION_IMMUTABLE');
 });
 for(const table of ['vehicle_service_consumptions','vehicle_service_applications'])for(const statement of [`update ${table} set intent_id=intent_id`,`delete from ${table}`,`truncate ${table} cascade`])await expect(f.conn.sql.unsafe(statement)).rejects.toThrow('VEHICLE_SERVICE_APPLICATION_IMMUTABLE');
 expect((await f.conn.sql`select revision from shardkeep_vehicle_lifecycle(${f.reservation.id}::uuid)`)[0]!.revision).toBe('1');
});
it('binds all active lifecycle guards to exact versioned trigger identities',async()=>{
 await expectActiveGuards();
 await f.conn.sql`create table copied_service_application(like vehicle_service_applications including defaults)`;
 await f.conn.sql`create trigger vehicle_service_applications_guard before insert on copied_service_application for each row execute function shardkeep_vehicle_service_application_guard_v214()`;
 await expect(f.conn.sql`insert into copied_service_application(intent_id) values(${f.intent.id})`).rejects.toThrow('VEHICLE_SERVICE_APPLICATION_TRIGGER');
 expect((await f.conn.sql`select exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where p.oid='shardkeep_vehicle_lifecycle(uuid)'::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE') allowed`)[0]!.allowed).toBe(false);
});
it('preserves applied receipts and active projected guards across old and new migration repeats',async()=>{
 await apply();const before=await f.conn.sql`select to_jsonb(c) consumption,to_jsonb(a) application from vehicle_service_consumptions c join vehicle_service_applications a using(intent_id)`;
 for(const file of ['0209_advanced_expeditions.sql','0211_vehicle_service_intents.sql','0212_vehicle_service_burn_preparations.sql'])await migrate(new URL('../drizzle/'+file,import.meta.url));
 expect((await f.conn.sql`select revision,tier from shardkeep_vehicle_lifecycle(${f.reservation.id}::uuid)`)[0]).toEqual({revision:'1',tier:f.intent.state.tier+1});
 await expectActiveGuards();
 await migrate(migration);await expectActiveGuards();expect(await f.conn.sql`select to_jsonb(c) consumption,to_jsonb(a) application from vehicle_service_consumptions c join vehicle_service_applications a using(intent_id)`).toEqual(before);
});
it('binds each historical return to its actual tier before or after an upgrade',async()=>{
 // The ordinary six-case fixture already has permanent consent. This separate
 // owned installation earns its first return before accepting service consent.
 const g=await vehicleServiceInstalledFixture();
 try{
  const trips=await vehicleServiceExpeditions(g),first=await trips.depart();await trips.complete(first);
  const consent=await vehicleServiceConsentFixture(g),prepared=await consent.preparations.prepare(g.actor,consent.intent.id),signed=consent.finalizeService(prepared),evidence=await consent.reader.verify({reservationId:consent.intent.id,signedTransaction:signed.signedTransaction});
  await g.conn.sql.begin(async tx=>{await tx`insert into vehicle_service_consumptions(intent_id,proof) values(${consent.intent.id},${JSON.stringify(evidence)}::jsonb)`;await tx`insert into vehicle_service_applications(intent_id) values(${consent.intent.id})`;});
  const second=await trips.depart();await trips.complete(second);
  expect(first.routeSnapshot.tier).toBe(1);expect(second.routeSnapshot.tier).toBe(2);
  const before=await g.conn.sql`select * from shardkeep_vehicle_lifecycle(${g.reservation.id}::uuid)`,originals=await g.conn.sql`select id,route_snapshot from advanced_expeditions order by id`,saved=await createVehicleServiceApplications(g.conn.db).get(g.actor,consent.intent.id);
  expect(before[0]).toMatchObject({tier:2,revision:'1',completed_total:'2',allowance_start:'0',pending_intent_id:null,away:false});
  const original=originals.find(row=>row.id===first.id)!;
  try{
   // Explicit owner-storage corruption, not a supported writer. Restore the
   // exact row guard before asking the production projection to validate it.
   await g.conn.sql.begin(async tx=>{await tx`alter table advanced_expeditions disable trigger advanced_expeditions_guard`;await tx`update advanced_expeditions set route_snapshot=jsonb_set(route_snapshot,'{tier}','2'::jsonb) where id=${first.id}`;await tx`alter table advanced_expeditions enable trigger advanced_expeditions_guard`;});
   await expect(g.conn.sql`select * from shardkeep_vehicle_lifecycle(${g.reservation.id}::uuid)`).rejects.toThrow('VEHICLE_LIFECYCLE_RETURNS');
  }finally{
   await g.conn.sql.begin(async tx=>{await tx`alter table advanced_expeditions disable trigger advanced_expeditions_guard`;await tx`update advanced_expeditions set route_snapshot=${JSON.stringify(original.route_snapshot)}::jsonb where id=${first.id}`;await tx`alter table advanced_expeditions enable trigger advanced_expeditions_guard`;});
  }
  expect(await g.conn.sql`select * from shardkeep_vehicle_lifecycle(${g.reservation.id}::uuid)`).toEqual(before);
  expect(await g.conn.sql`select id,route_snapshot from advanced_expeditions order by id`).toEqual(originals);
  expect(await createVehicleServiceApplications(g.conn.db).get(g.actor,consent.intent.id)).toEqual(saved);
 }finally{await g.dispose();}
},120_000);
