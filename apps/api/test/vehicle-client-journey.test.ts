/** Fresh normal commands exercise irreversible consent, actual uses and reset.
 * Calendar/finality are private R1 inputs, never a caller completion assertion. */
import {randomUUID} from 'node:crypto';
import {afterEach,it,expect,vi} from 'vitest';
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import {vehicleReference,type VehicleClient} from '@shardkeep/shared/vehicleClientApi';
import {vehicleClientPairFixture} from './fixtures/vehicleClientPair';
import {SEAL_BOUND_100_TRIP_MS} from './sealLatencyBudgets';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it('installs, upgrades, completes100 real trips and restores original capacity exactly once',async()=>{
 const f=await vehicleClientPairFixture();try{
  const c=f.client(),wallet=f.config.wallet;
  async function burn(original:VehicleClient){const ref=vehicleReference(original),prepared=await c.prepare(wallet,ref),wire=await f.sign(prepared);expect(await c.review(wallet,ref)).toMatchObject({status:'ready'});await c.retainSigned(wallet,ref,Buffer.from(wire.signedTransactionHex,'hex'));expect(await c.deliver(wallet,ref)).toMatchObject({status:'submitted'});await f.finalize(ref);return c.recover(wallet,ref);}
  const initial=await c.reserve(wallet,'installation',{baseId:f.config.baseId,berthId:f.config.berthId,assetId:f.config.initialAssetId,idempotencyKey:randomUUID()}),installed=await burn(initial),installationId=vehicleReference(installed).id;
  expect(installed).toMatchObject({kind:'installation',record:{status:'installed'}});
  const upgrade=await c.reserve(wallet,'service',{installationId,assetId:f.config.upgradeAssetId,operation:'upgrade',idempotencyKey:randomUUID()});expect(await burn(upgrade)).toMatchObject({record:{application:{tierAfter:2,revisionAfter:1}}});
  const before=await c.routes(wallet,f.config.baseId);expect(before.items).toHaveLength(1);await f.exhaust(installationId);
  expect(await f.f.conn.sql`select count(*)::int n from advanced_expedition_returns`).toEqual([{n:PHASE_E_VEHICLES.completedUsesPerInstall}]);
  const request={baseId:f.config.baseId,installationId,routeId:f.config.routeId,policyVersion:1,idempotencyKey:randomUUID()};await expect(f.expeditions().dispatch(wallet,request)).rejects.toThrow();
  const restore=await c.reserve(wallet,'service',{installationId,assetId:f.config.restoreAssetId,operation:'restore_uses',idempotencyKey:randomUUID()}),restored=await burn(restore);expect(restored).toMatchObject({record:{application:{tierAfter:2,revisionAfter:2,allowanceStartAfter:String(PHASE_E_VEHICLES.completedUsesPerInstall)}}});
  const discovered=[];let cursor:string|undefined;do{const page=await c.activity(wallet,cursor);discovered.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);
  expect(discovered).toHaveLength(PHASE_E_VEHICLES.completedUsesPerInstall+4);expect(new Set(discovered.map(v=>v.kind+':'+v.id)).size).toBe(discovered.length);
  f.state({paused:true,providerless:true});expect(await f.client().recover(wallet,vehicleReference(restored))).toMatchObject({record:{status:'applied'}});
  expect((await f.providers().advancedFleetViewProvider.read(wallet,f.config.baseId)).vehicles).toMatchObject([{installationId,tier:2,remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall}]);
  expect(await f.f.conn.sql`select count(*)::int n from vehicle_service_applications`).toEqual([{n:2}]);expect(await f.f.conn.sql`select count(*)::int n from vehicle_burn_consumptions`).toEqual([{n:1}]);
 }finally{await f.dispose();}
},SEAL_BOUND_100_TRIP_MS);
