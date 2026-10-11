/** Current lifecycle governs new actions; immutable consent and trip history
 * survive later services. Every use below comes from an actual return receipt. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {vehicleServiceAsset,vehicleServiceExpeditions} from './fixtures/vehicleService';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {createVehicleServiceIntents} from '../src/game/vehicleServiceIntents';
import {dispatchAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';

let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>;
beforeEach(async()=>{
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');
 // Since 790271776 (2026-09-29) advanced trips run on a PAST fixture clock (now-6d: 0256
 // refuses future return cutoffs), so the berth must complete before it, as the sibling
 // vehicle-service fixtures do; the default now-1h berth made every departure here refuse.
 f=await vehicleBurnDatabase('survey_balloon',1,{},{completedAt:new Date(Date.now()-7*86400000)});f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
},120_000);
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();},120_000);

it('checks strict parents after an optional intent restriction changes admission',async()=>{
 const asset=await vehicleServiceAsset(f),captureOwner=vi.fn(asset.reader.captureOwner);
 const intents=createVehicleServiceIntents(f.conn.db,{captureOwner,enabled:()=>{vi.stubEnv('MULTI_BASE_ENABLED','false');return true;}});
 await expect(intents.reserve({wallet:f.actor,installationId:f.reservation.id,assetId:asset.identity.assetId,operation:'upgrade',idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'VEHICLE_SERVICE_DISABLED'});
 expect(captureOwner).not.toHaveBeenCalled();expect(await f.conn.sql`select id from vehicle_service_intents`).toHaveLength(0);
});

it('checks strict parents after an optional departure restriction before taking gameplay authority',async()=>{
 const trips=await vehicleServiceExpeditions(f),assertAuthority=vi.fn(trips.authority.assertAuthority),reader=await trips.reader();
 await expect(dispatchAdvancedExpedition(f.conn.db,f.actor,trips.command(),{...trips.authority,assertAuthority},{reader,clock:trips.clock,assertAdmission:()=>{vi.stubEnv('MULTI_BASE_ENABLED','false');}})).rejects.toMatchObject({code:'ADVANCED_DISABLED'});
 expect(assertAuthority).not.toHaveBeenCalled();expect(await f.conn.sql`select id from advanced_expeditions`).toHaveLength(0);expect(await f.conn.sql`select id from resource_stock_operations`).toHaveLength(0);
});

async function lifecycleMigration(){
 await f.conn.sql.begin(async tx=>{for(const part of readFileSync(new URL('../drizzle/0214_vehicle_service_applications.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);});
}

it('requires a transaction for current projection and does not invent an unknown installation',async()=>{
 await lifecycleMigration();const {readLockedVehicleLifecycle}=await import('../src/game/vehicleLifecycle');
 // @ts-expect-error Deliberate caller boundary violation: a pool is not a mutex.
 await expect(readLockedVehicleLifecycle(f.conn.db,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_LIFECYCLE_TRANSACTION'});
 await f.conn.db.transaction(async tx=>{
  expect(await readLockedVehicleLifecycle(tx,randomUUID())).toBeNull();const state=await readLockedVehicleLifecycle(tx,f.reservation.id);
  expect(state).toMatchObject({installationId:f.reservation.id,baseId:f.baseId,berthId:f.berthId,family:f.identity.family,tier:1,revision:0,completedTotal:0n,allowanceStart:0n,pendingIntentId:null,away:false});
  expect(state!.berthCompletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);expect(Object.isFrozen(state)).toBe(true);
 });
});

it('uses an applied upgrade for new intent, preparation and departure while preserving original history',async()=>{
 await lifecycleMigration();const {vehicleServiceConsentFixture}=await import('./fixtures/vehicleServicePreparation');
 const {createVehicleServiceApplications}=await import('../src/game/vehicleServiceApplications');
 const {createVehicleServiceBurnPreparations}=await import('../src/game/vehicleServiceBurnPreparations');
 const {readLockedVehicleLifecycle}=await import('../src/game/vehicleLifecycle');
 const {readAdvancedExpedition}=await import('../src/game/advancedExpeditionDispatch');
 const trips=await vehicleServiceExpeditions(f),oldTrip=await trips.depart();await trips.complete(oldTrip);
 const first=await vehicleServiceConsentFixture(f),prepared=await first.preparations.prepare(f.actor,first.intent.id),signed=first.finalizeService(prepared);
 const applied=await createVehicleServiceApplications(f.conn.db,{verifyBurn:first.reader.verify}).recover(f.actor,first.intent.id,signed.signedTransaction);
 expect(applied).toMatchObject({tierAfter:2,revisionAfter:1,completedTotal:'1',allowanceStartAfter:'0'});
 const upgraded=await trips.depart();expect(upgraded.routeSnapshot.tier).toBe(2);expect(upgraded.completedBefore).toBe(1n);
 const [returned]=await trips.complete(upgraded);expect(returned!.receipt.completedTotal).toBe(2n);
 const second=await vehicleServiceConsentFixture(f,{tier:2}),nextPrepared=await second.preparations.prepare(f.actor,second.intent.id);
 expect(second.intent.state).toMatchObject({tier:2,revision:1,completedTotal:'2',allowanceStart:'0'});expect(nextPrepared.plan.service).toEqual(second.intent.state);expect(nextPrepared.plan.identity.tier).toBe(2);
 expect(await f.conn.db.transaction(tx=>readLockedVehicleLifecycle(tx,f.reservation.id))).toMatchObject({tier:2,revision:1,completedTotal:2n,allowanceStart:0n,pendingIntentId:second.intent.id,away:false});
 vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');f.setOnline(false);
 expect(await createVehicleServiceIntents(f.conn.db).get(f.actor,first.intent.id)).toEqual(first.intent);
 expect(await createVehicleServiceBurnPreparations(f.conn.db).prepare(f.actor,first.intent.id)).toEqual(prepared);
 expect(await createVehicleServiceApplications(f.conn.db).recover(f.actor,first.intent.id)).toEqual(applied);
 expect(await readAdvancedExpedition(f.conn.db,oldTrip.id)).toEqual(oldTrip);
 expect(await dispatchAdvancedExpedition(f.conn.db,f.actor,{id:oldTrip.id,baseId:oldTrip.baseId,installationId:oldTrip.installationId,routeId:oldTrip.routeId,policyVersion:oldTrip.policyVersion},trips.authority)).toEqual(oldTrip);
},120_000);

it('refuses an original-tier duplicate after an actual upgrade without reserving that asset',async()=>{
 await lifecycleMigration();const {vehicleServiceConsentFixture}=await import('./fixtures/vehicleServicePreparation');
 const {createVehicleServiceApplications}=await import('../src/game/vehicleServiceApplications');
 const first=await vehicleServiceConsentFixture(f),prepared=await first.preparations.prepare(f.actor,first.intent.id);first.finalizeService(prepared);
 await createVehicleServiceApplications(f.conn.db,{verifyBurn:first.reader.verify}).recover(f.actor,first.intent.id);
 const stale=await vehicleServiceAsset(f,{tier:1});
 await expect(createVehicleServiceIntents(f.conn.db,{captureOwner:stale.reader.captureOwner}).reserve({wallet:f.actor,installationId:f.reservation.id,assetId:stale.identity.assetId,operation:'upgrade',idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'VEHICLE_SERVICE_IDENTITY'});
 expect(await f.conn.sql`select id from vehicle_service_intents where asset_id=${stale.identity.assetId}`).toHaveLength(0);
});
