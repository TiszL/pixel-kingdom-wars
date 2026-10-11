/** SQL identifier exclusion is a consistency boundary, not cryptographic proof:
 * signature/hash collisions below alter exactly one owner-supplied metadata field
 * after actual independent signed proofs have been verified. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type postgres from 'postgres';
import {vehicleServicePreparationFixture,vehicleServiceConsentFixture} from './fixtures/vehicleServicePreparation';
import {pendingInitialVehicleBurn,preServiceApplicationVehicleBurn} from './fixtures/vehicleConsumptionFence';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {runMigrations} from '../src/db/migrate';

type Side='initial'|'service';
type Identifier='asset'|'signature'|'wire';
let f:Awaited<ReturnType<typeof vehicleServicePreparationFixture>>;
const flags=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'];

async function candidates(identifier:Identifier){
 const preparation=await f.preparations.prepare(f.actor,f.intent.id),signed=f.finalizeService(preparation),service=await f.reader.verify({reservationId:f.intent.id,signedTransaction:signed.signedTransaction});
 const initial=await pendingInitialVehicleBurn(f.initial,identifier==='asset'?f.asset:undefined);
 expect(initial.baseId).not.toBe(f.baseId);expect(initial.reservation.id).not.toBe(f.reservation.id);expect(initial.berthId).not.toBe(f.berthId);
 if(identifier!=='asset')expect(initial.actor).not.toBe(f.actor);
 expect((await f.conn.sql`select tgenabled from pg_trigger where tgrelid='vehicle_activation_reservations'::regclass and tgname='vehicle_activation_asset_service_exclusion'`)[0]!.tgenabled).toBe('O');
 return {initial,service};
}
type Candidates=Awaited<ReturnType<typeof candidates>>;
function collisions(c:Candidates,identifier:Identifier,winner:Side){
 const initial={...c.initial.proof},service={...c.service};
 if(identifier==='signature'){if(winner==='initial')service.signature=initial.signature;else initial.signature=service.signature;}
 if(identifier==='wire'){if(winner==='initial')service.signedTransactionSha256=initial.signedTransactionSha256;else initial.signedTransactionSha256=service.signedTransactionSha256;}
 expect(initial.identity.assetId===service.identity.assetId).toBe(identifier==='asset');
 expect(initial.signature===service.signature).toBe(identifier==='signature');
 expect(initial.signedTransactionSha256===service.signedTransactionSha256).toBe(identifier==='wire');
 return {initial,service};
}
async function insertPair(tx:postgres.TransactionSql,side:Side,c:Candidates,proofs:ReturnType<typeof collisions>){
 if(side==='initial'){
  await tx`insert into vehicle_burn_consumptions(reservation_id,proof) values(${c.initial.reservation.id},${JSON.stringify(proofs.initial)}::jsonb)`;
  await tx`insert into advanced_vehicle_installations(reservation_id) values(${c.initial.reservation.id})`;
 }else{
  await tx`insert into vehicle_service_consumptions(intent_id,proof) values(${f.intent.id},${JSON.stringify(proofs.service)}::jsonb)`;
  await tx`insert into vehicle_service_applications(intent_id) values(${f.intent.id})`;
 }
 await tx`set constraints all immediate`;
}
async function counts(c:Candidates){
 const [row]=await f.conn.sql`select
  (select count(*)::int from vehicle_burn_consumptions where reservation_id=${c.initial.reservation.id}) initial_consumption,
  (select count(*)::int from advanced_vehicle_installations where reservation_id=${c.initial.reservation.id}) initial_installation,
  (select count(*)::int from vehicle_service_consumptions where intent_id=${f.intent.id}) service_consumption,
  (select count(*)::int from vehicle_service_applications where intent_id=${f.intent.id}) service_application`;
 return row;
}
const complete=(side:Side)=>({initial_consumption:side==='initial'?1:0,initial_installation:side==='initial'?1:0,service_consumption:side==='service'?1:0,service_application:side==='service'?1:0});

describe('cross-table consumption fence',()=>{
beforeEach(async()=>{for(const flag of flags)vi.stubEnv(flag,'true');f=await vehicleServicePreparationFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();},120_000);

it.each((['asset','signature','wire'] as const).flatMap(identifier=>(['initial','service'] as const).map(winner=>({identifier,winner}))))('rejects exactly $identifier across tables after $winner wins without committing either losing half',async({identifier,winner})=>{
 const c=await candidates(identifier),proofs=collisions(c,identifier,winner),loser=winner==='initial'?'service':'initial';
 await f.conn.sql.begin(tx=>insertPair(tx,winner,c,proofs));const before=await counts(c);expect(before).toEqual(complete(winner));
 await expect(f.conn.sql.begin(tx=>insertPair(tx,loser,c,proofs))).rejects.toMatchObject({code:'23505',message:'VEHICLE_CONSUMPTION_DUPLICATE'});
 expect(await counts(c)).toEqual(before);
});

it.each((['initial','service'] as const).flatMap(winner=>(['commit','rollback'] as const).map(outcome=>({winner,outcome}))))('returns the exact fence BUSY under independent $winner locks, then honors $outcome on retry',async({winner,outcome})=>{
 const identifier=winner==='initial'?'signature':'wire',c=await candidates(identifier),proofs=collisions(c,identifier,winner),loser=winner==='initial'?'service':'initial',observer=f.conn.reopen();
 let ready!:()=>void,rejectReady!:(e:unknown)=>void,release!:()=>void;
 const started=new Promise<void>((resolve,reject)=>{ready=resolve;rejectReady=reject;}),barrier=new Promise<void>(resolve=>{release=resolve;}),rollback=new Error('Deliberate candidate rollback');
 const holder=observer.sql.begin(async tx=>{await insertPair(tx,winner,c,proofs);ready();await barrier;if(outcome==='rollback')throw rollback;}).then(()=>null,error=>{rejectReady(error);return error as unknown;});
 try{
  await started;
  await expect(f.conn.sql.begin(tx=>insertPair(tx,loser,c,proofs))).rejects.toMatchObject({code:'55P03',message:'VEHICLE_CONSUMPTION_BUSY'});
  expect(await counts(c)).toEqual({initial_consumption:0,initial_installation:0,service_consumption:0,service_application:0});
  release();const result=await holder;
  if(outcome==='commit'){
   expect(result).toBeNull();await expect(f.conn.sql.begin(tx=>insertPair(tx,loser,c,proofs))).rejects.toMatchObject({code:'23505',message:'VEHICLE_CONSUMPTION_DUPLICATE'});expect(await counts(c)).toEqual(complete(winner));
  }else{
   expect(result).toBe(rollback);await f.conn.sql.begin(tx=>insertPair(tx,loser,c,proofs));expect(await counts(c)).toEqual(complete(loser));
  }
 }finally{release();await holder;await observer.sql.end();}
});
});

it('finds a committed pre0214 initial pair after real upgrade without changing or backfilling it',async()=>{
 for(const flag of flags)vi.stubEnv(flag,'true');const legacy=await preServiceApplicationVehicleBurn();
 try{
  expect((await legacy.conn.sql`select to_regclass('public.vehicle_service_consumptions') name`)[0]!.name).toBeNull();
  const signed=legacy.finalizeBurn(),installed=await createVehicleInstallations(legacy.conn.db,{verifyBurn:legacy.reader.verify}).recover(legacy.actor,legacy.reservation.id,signed.signedTransaction);
  const snapshot=()=>legacy.conn.sql`select to_jsonb(c) consumption,to_jsonb(i) installation,'vehicle_burn_consumptions'::regclass::oid::text consumption_oid,'advanced_vehicle_installations'::regclass::oid::text installation_oid from vehicle_burn_consumptions c join advanced_vehicle_installations i using(reservation_id) where c.reservation_id=${legacy.reservation.id}`;
  const before=await snapshot();await runMigrations(legacy.conn.db);expect(await snapshot()).toEqual(before);expect(await legacy.conn.sql`select * from vehicle_service_consumptions`).toHaveLength(0);expect(await legacy.conn.sql`select * from vehicle_service_applications`).toHaveLength(0);
  const service=await vehicleServiceConsentFixture(legacy),prepared=await service.preparations.prepare(legacy.actor,service.intent.id),packet=service.finalizeService(prepared),proof=await service.reader.verify({reservationId:service.intent.id,signedTransaction:packet.signedTransaction});
  expect(proof.identity.assetId).not.toBe(installed.proof.identity.assetId);expect(proof.signature).not.toBe(installed.proof.signature);expect(proof.signedTransactionSha256).not.toBe(installed.proof.signedTransactionSha256);
  for(const identifier of ['signature','signedTransactionSha256'] as const){
   const changed={...proof,[identifier]:installed.proof[identifier]};
   await expect(legacy.conn.sql.begin(async tx=>{await tx`insert into vehicle_service_consumptions(intent_id,proof) values(${service.intent.id},${JSON.stringify(changed)}::jsonb)`;await tx`insert into vehicle_service_applications(intent_id) values(${service.intent.id})`;})).rejects.toMatchObject({code:'23505',message:'VEHICLE_CONSUMPTION_DUPLICATE'});
   expect(await snapshot()).toEqual(before);expect(await legacy.conn.sql`select * from vehicle_service_consumptions`).toHaveLength(0);expect(await legacy.conn.sql`select * from vehicle_service_applications`).toHaveLength(0);
  }
  expect(await createVehicleInstallations(legacy.conn.db).get(legacy.actor,legacy.reservation.id)).toEqual(installed);
 }finally{vi.restoreAllMocks();vi.unstubAllEnvs();await legacy.dispose();}
},120_000);
