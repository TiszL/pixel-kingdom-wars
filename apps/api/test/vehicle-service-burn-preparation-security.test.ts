/** Remaining B5r adversarial boundaries. Actual Core/source fixtures; storage
 * corruption is explicitly owner-only damage, never a runtime-role exploit. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Keypair,Message,VersionedTransaction} from '@solana/web3.js';
import {buildVehicleBurnMessage} from '@shardkeep/chain/vehicle-burn-message';
import {vehicleServicePreparationFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceExpeditions} from './fixtures/vehicleService';
import {createVehicleServiceBurnPreparations} from '../src/game/vehicleServiceBurnPreparations';
let f:Awaited<ReturnType<typeof vehicleServicePreparationFixture>>;
const flags=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'];
beforeEach(async()=>{for(const flag of flags)vi.stubEnv(flag,'true');f=await vehicleServicePreparationFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);

it('rechecks a strict pause after an observed independent installation-row lock wait',async()=>{
 const blocker=f.conn.reopen();let ready!:()=>void,release!:()=>void,pid=0;
 const start=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const holder=blocker.sql.begin(async tx=>{await tx`select reservation_id from advanced_vehicle_installations where reservation_id=${f.reservation.id} for update`;pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;ready();await gate;});
 const captureOwner=vi.fn(f.reader.captureOwner),getBlockhash=vi.fn(async()=>f.blockhash),service=createVehicleServiceBurnPreparations(f.conn.db,{captureOwner,getBlockhash});let pending:Promise<unknown>|undefined;
 try{await start;pending=service.prepare(f.actor,f.intent.id).then(value=>({value}),error=>({error}));
  await expect.poll(async()=>(await f.conn.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) and query like '%advanced_vehicle_installations%') waiting`)[0]!.waiting).toBe(true);
  expect(captureOwner).toHaveBeenCalledTimes(1);expect(getBlockhash).toHaveBeenCalledTimes(1);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');release();
  expect(await pending).toMatchObject({error:{code:'VEHICLE_SERVICE_PREPARATION_DISABLED'}});expect(await f.conn.sql`select * from vehicle_service_burn_preparations`).toHaveLength(0);expect(await f.conn.sql`select id from vehicle_service_intents`).toEqual([{id:f.intent.id}]);
  vi.stubEnv('PHASE_E_VEHICLES_ENABLED','true');expect((await service.prepare(f.actor,f.intent.id)).intentId).toBe(f.intent.id);
 }finally{release();await holder;await pending;await blocker.sql.end();}
});

it('rejects an actual initial-installation signature and a recomputed installation-message substitution',async()=>{
 const p=await f.preparations.prepare(f.actor,f.intent.id),valid=f.finalizeService(p);
 const installation=buildVehicleBurnMessage({wallet:f.actor,reservationId:f.intent.id,identity:f.intent.identity,blockhash:p.plan.blockhash});
 const wrong=new VersionedTransaction(Message.from(installation.messageBytes));wrong.sign([f.wallet]);
 const rpc=vi.spyOn(f.rpc,'getGenesisHash');await expect(f.reader.verify({reservationId:f.intent.id,signedTransaction:wrong.serialize()})).rejects.toMatchObject({code:'UNAVAILABLE'});expect(rpc).not.toHaveBeenCalled();
 expect(await f.reader.verify({reservationId:f.intent.id,signedTransaction:valid.signedTransaction})).toMatchObject({purpose:'vehicle_service',finalityVerified:true,serviceAuthorized:false});
 // Privileged damaged storage: retain the service plan but substitute a valid
 // initial-purpose message and its matching SHA. Hash consistency is insufficient.
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update vehicle_service_burn_preparations set message_bytes=${Buffer.from(installation.messageBytes)},message_sha256=${installation.messageSha256} where intent_id=${f.intent.id}`;});
 await expect(f.preparations.get(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_SOURCE'});await expect(f.preparations.loadSavedReservation(f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_SOURCE'});
 expect(await f.conn.sql`select * from vehicle_burn_consumptions`).toHaveLength(1);expect(await f.conn.sql`select id from vehicle_service_intents`).toEqual([{id:f.intent.id}]);
});

it('refuses fresh preparation after actual return-count drift while preserving an already retained original',async()=>{
 const p=await f.preparations.prepare(f.actor,f.intent.id),[intent]=await f.conn.sql`select to_jsonb(i) row from vehicle_service_intents i where id=${f.intent.id}`,[saved]=await f.conn.sql`select to_jsonb(p) row from vehicle_service_burn_preparations p where intent_id=${f.intent.id}`;
 // Explicit damaged owner storage removes the hold to create one genuine,
 // conserved departure+return. No fabricated completed counter is inserted.
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`delete from vehicle_service_burn_preparations where intent_id=${f.intent.id}`;await tx`delete from vehicle_service_intents where id=${f.intent.id}`;});
 const trips=await vehicleServiceExpeditions(f),trip=await trips.depart(),[returned]=await trips.complete(trip);expect(returned!.receipt.completedTotal).toBe(1n);expect(returned!.entries.reduce((n,e)=>n+e.delta,0n)).toBe(0n);
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`insert into vehicle_service_intents select * from jsonb_populate_record(null::vehicle_service_intents,${JSON.stringify(intent!.row)}::jsonb)`;});
 // The shared lifecycle now rejects the corrupted pending checkpoint before preparation.
 await expect(f.preparations.prepare(f.actor,f.intent.id)).rejects.toMatchObject({cause:{code:'P0001',message:'VEHICLE_LIFECYCLE_PENDING'}});expect(await f.conn.sql`select * from vehicle_service_burn_preparations`).toHaveLength(0);
 // Restoring the exact original saved artifact must preserve its historical
 // zero-use consent even though the current installation now has one real use.
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`insert into vehicle_service_burn_preparations select * from jsonb_populate_record(null::vehicle_service_burn_preparations,${JSON.stringify(saved!.row)}::jsonb)`;});
 const offline=createVehicleServiceBurnPreparations(f.conn.db);for(const flag of flags)vi.stubEnv(flag,'false');expect(await offline.prepare(f.actor,f.intent.id)).toEqual(p);expect(await offline.get(f.actor,f.intent.id)).toEqual(p);expect((await offline.loadSavedReservation(f.intent.id))!.plan.service.completedTotal).toBe('0');expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(1);
});

it('retains the first exact lifetime after modeled expiry without consulting replacement providers',async()=>{
 const p=await f.preparations.prepare(f.actor,f.intent.id),currentFinalizedHeight=p.lastValidBlockHeight+1,reopened=f.conn.reopen();expect(currentFinalizedHeight).toBeGreaterThan(p.lastValidBlockHeight);
 // Height belongs only to this simulated later provider. No elapsed wall clock
 // or missing wire is treated as evidence that the original burn did not land.
 const replacement=vi.fn(async()=>{expect(currentFinalizedHeight).toBeGreaterThan(p.lastValidBlockHeight);return {blockhash:Keypair.generate().publicKey.toBase58(),contextSlot:f.blockhash.contextSlot+1,lastValidBlockHeight:currentFinalizedHeight+100};}),capture=vi.fn(async()=>{throw Error('Archive unavailable after original preparation');});
 try{for(const flag of flags)vi.stubEnv(flag,'false');const offline=createVehicleServiceBurnPreparations(reopened.db,{captureOwner:capture,getBlockhash:replacement});expect(await offline.prepare(f.actor,f.intent.id)).toEqual(p);expect(await offline.get(f.actor,f.intent.id)).toEqual(p);expect(capture).not.toHaveBeenCalled();expect(replacement).not.toHaveBeenCalled();expect(p.reservationReleaseAuthorized).toBe(false);expect(await reopened.sql`select intent_id,last_valid_block_height from vehicle_service_burn_preparations`).toEqual([{intent_id:f.intent.id,last_valid_block_height:String(p.lastValidBlockHeight)}]);
 }finally{await reopened.sql.end();}
});
