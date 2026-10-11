/** D183 private R1 fixture composes accepted installed capacity and an actual
 * returned v1 departure before either new client opens the named catalogue. */
import {randomUUID} from 'node:crypto';
import {PHASE_E_ORDINARY_ROUTES} from '@shardkeep/shared';
import {createVehicleInstallations} from '../../src/game/vehicleInstallations';
import {vehicleClientPairFixture} from './vehicleClientPair';
export async function ordinaryRoutePairFixture(){
 const f=await vehicleClientPairFixture();
 try{
  f.f.finalizeBurn();await createVehicleInstallations(f.f.conn.db,{verifyBurn:f.f.reader.verify}).recover(f.f.actor,f.f.reservation.id);
  const installationId=f.f.reservation.id,v1IdempotencyKey=randomUUID();
  await f.expeditions().dispatch(f.config.wallet,{idempotencyKey:v1IdempotencyKey,baseId:f.config.baseId,installationId,routeId:'coastal_survey',policyVersion:1});
  await f.finishExpedition(v1IdempotencyKey);await f.expeditions().collect(f.config.wallet,f.config.baseId);
  return {...f,config:{...f.config,installationId,v1IdempotencyKey,routeId:'mintwake-1',policy:{...f.config.policy,ordinaryRoutes:PHASE_E_ORDINARY_ROUTES}}};
 }catch(error){await f.dispose();throw error;}
}
export type OrdinaryRoutePairFixture=Awaited<ReturnType<typeof ordinaryRoutePairFixture>>;
