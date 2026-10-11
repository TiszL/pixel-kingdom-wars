/** Actual completed returns, not fabricated counters, determine restoration. */
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import {vehicleServiceInstalledFixture,vehicleServiceConsentFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceExpeditions,vehicleServiceAsset} from './fixtures/vehicleService';
import {createVehicleServiceApplications} from '../src/game/vehicleServiceApplications';
import {createVehicleServiceIntents} from '../src/game/vehicleServiceIntents';
import {createVehicleServiceBurnPreparations} from '../src/game/vehicleServiceBurnPreparations';
import {captureLatestBoundary,restoreLatestBoundary} from './fixtures/latestBoundary';
import {SEAL_BOUND_100_TRIP_MS} from './sealLatencyBudgets';
let f:Awaited<ReturnType<typeof vehicleServiceInstalledFixture>>;
beforeEach(async()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');f=await vehicleServiceInstalledFixture();await f.conn.sql.begin(async tx=>{for(const part of readFileSync(new URL('../drizzle/0214_vehicle_service_applications.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);});},120_000);
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function apply(options:Parameters<typeof vehicleServiceConsentFixture>[1]){const consent=await vehicleServiceConsentFixture(f,options),prepared=await consent.preparations.prepare(f.actor,consent.intent.id),signed=consent.finalizeService(prepared),receipt=await createVehicleServiceApplications(f.conn.db,{verifyBurn:consent.reader.verify}).recover(f.actor,consent.intent.id,signed.signedTransaction);return {consent,prepared,receipt};}
it('preserves exhaustion through upgrade then restores from actual100 and200 returns without resetting lifetime ordinals',async()=>{
 const trips=await vehicleServiceExpeditions(f),limit=PHASE_E_VEHICLES.completedUsesPerInstall;
 for(let n=0;n<limit;n++)await trips.complete(await trips.depart());
 const original=await f.conn.sql`select id,completed_before,route_snapshot from advanced_expeditions order by id`,upgraded=await apply({operation:'upgrade'});
 expect(upgraded.receipt).toMatchObject({tierAfter:2,revisionAfter:1,completedTotal:String(limit),allowanceStartAfter:'0'});await expect(trips.depart()).rejects.toThrow();
 const restored=await apply({operation:'restore_uses',tier:2});expect(restored.receipt).toMatchObject({tierAfter:2,revisionAfter:2,completedTotal:String(limit),allowanceStartAfter:String(limit)});
 const next=await trips.depart();expect(next.completedBefore).toBe(BigInt(limit));expect(next.routeSnapshot.tier).toBe(2);await trips.complete(next);
 expect((await f.conn.sql`select completed_total from advanced_expedition_returns where expedition_id=${next.id}`)[0]!.completed_total).toBe(String(limit+1));
 for(let n=1;n<limit;n++)await trips.complete(await trips.depart());await expect(trips.depart()).rejects.toThrow();
 const again=await apply({operation:'restore_uses',tier:2});expect(again.receipt).toMatchObject({revisionAfter:3,completedTotal:String(2*limit),allowanceStartAfter:String(2*limit)});
 // Old migration replay must not restore zero-origin tier or allowance logic.
 // 2026-10-10 (CI 37503885235, cluster F): this case used to time out before reaching the replay, which hid
 // that 0256 is no longer the restoring boundary: 0278 added the workshop trigger to its sealed relations and
 // 0279 superseded its seal, so replaying 0256 is itself a refused downgrade (dd92d0f16). Same rule as
 // ordinary-equipment and survey-lens (fixtures/latestBoundary.ts): prove the refusal, put back the exact
 // catalog this case found, and prove the newest whole-system seal accepts it; never reseal downgraded code.
 const boundary=await captureLatestBoundary(f.conn.sql),replay=(file:string)=>f.conn.sql.begin(async tx=>{for(const part of readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8').split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);});
 const restoreBoundary=async()=>{await restoreLatestBoundary(f.conn.sql,boundary);expect(await captureLatestBoundary(f.conn.sql)).toEqual(boundary);await f.conn.sql`select public.shardkeep_divine_fragment_source()`;};
 for(const file of ['0209_advanced_expeditions.sql','0211_vehicle_service_intents.sql','0212_vehicle_service_burn_preparations.sql'])await replay(file);
 await expect(f.conn.db.transaction(async tx=>{const {settleDueAdvancedExpeditions}=await import('../src/game/advancedExpeditionReturns');await settleDueAdvancedExpeditions(tx,f.baseId,trips.clock());})).rejects.toThrow();
 await expect(replay('0256_advanced_return_capability.sql')).rejects.toThrow('ADVANCED_RETURN_SOURCE_CHANGED');await restoreBoundary();
 const after=await trips.depart();expect(after.completedBefore).toBe(BigInt(2*limit));await trips.complete(after);
 const afterReplayUpgrade=await apply({operation:'upgrade',tier:2});expect(afterReplayUpgrade.receipt).toMatchObject({tierAfter:3,revisionAfter:4,completedTotal:String(2*limit+1),allowanceStartAfter:String(2*limit)});
 await replay('0214_vehicle_service_applications.sql');
 expect(await f.conn.sql`select id,completed_before,route_snapshot from advanced_expeditions where completed_before<${limit} order by id`).toEqual(original);
 expect((await f.conn.sql`select count(*)::integer n,min(completed_total)::text first,max(completed_total)::text last from advanced_expedition_returns`)[0]).toEqual({n:2*limit+1,first:'1',last:String(2*limit+1)});
 for(const saved of [upgraded,restored,again,afterReplayUpgrade]){expect(await createVehicleServiceApplications(f.conn.db).get(f.actor,saved.consent.intent.id)).toEqual(saved.receipt);expect(await createVehicleServiceBurnPreparations(f.conn.db).get(f.actor,saved.consent.intent.id)).toEqual(saved.prepared);}
 // The 0214 replay's bodies must not leak into later files sharing this database.
 await restoreBoundary();
// All201 real trips revalidate retained history; this is a correctness check,
// not a two-minute performance budget. Keep every transition and assertion.
},SEAL_BOUND_100_TRIP_MS);
it('applies successive upgrades through the locked maximum tier and rejects further upgrade without consuming a new asset',async()=>{
 for(const tier of PHASE_E_VEHICLES.tiers.slice(0,-1)){const saved=await apply({operation:'upgrade',tier});expect(saved.receipt).toMatchObject({tierAfter:tier+1,revisionAfter:tier,completedTotal:'0',allowanceStartAfter:'0'});}
 const tier=PHASE_E_VEHICLES.tiers.at(-1)!,asset=await vehicleServiceAsset(f,{tier});await expect(createVehicleServiceIntents(f.conn.db,{captureOwner:asset.reader.captureOwner}).reserve({wallet:f.actor,installationId:f.reservation.id,assetId:asset.identity.assetId,operation:'upgrade',idempotencyKey:'past-maximum'})).rejects.toThrow();
 expect(await f.conn.sql`select * from vehicle_service_applications`).toHaveLength(PHASE_E_VEHICLES.tiers.length-1);expect(await f.conn.sql`select * from vehicle_service_intents where asset_id=${asset.identity.assetId}`).toHaveLength(0);
},30_000);
it('holds departure while a complete service transaction is uncommitted and retries using the committed tier',async()=>{
 const trips=await vehicleServiceExpeditions(f),consent=await vehicleServiceConsentFixture(f),prepared=await consent.preparations.prepare(f.actor,consent.intent.id);consent.finalizeService(prepared);const proof=await consent.reader.verify({reservationId:consent.intent.id}),other=f.conn.reopen();
 let ready!:()=>void,release!:()=>void;const locked=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r),holder=other.sql.begin(async tx=>{await tx`insert into vehicle_service_consumptions(intent_id,proof) values(${consent.intent.id},${JSON.stringify(proof)}::jsonb)`;await tx`insert into vehicle_service_applications(intent_id) values(${consent.intent.id})`;ready();await gate;});
 try{await locked;expect(await createVehicleServiceApplications(f.conn.db).get(f.actor,consent.intent.id)).toBeNull();let code:unknown;try{await trips.depart();}catch(error){let cause:unknown=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){if('code'in cause)code=cause.code;cause='cause'in cause?cause.cause:undefined;}}expect(code).toBe('55P03');expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(0);expect(await f.conn.sql`select * from resource_stock_operations`).toHaveLength(0);}finally{release();await holder;await other.sql.end();}
 const after=await trips.depart();expect(after.routeSnapshot.tier).toBe(2);expect(after.completedBefore).toBe(0n);await trips.complete(after);
},30_000);
