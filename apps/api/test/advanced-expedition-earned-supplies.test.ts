/** Earned-material composition. Extra completed fixture berth does not claim
 * ordinary five-berth construction (K-201); mint provenance is still attested. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Keypair,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {PHASE_E_ADVANCED_EXPEDITIONS} from '@shardkeep/shared';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {advancedExpeditionPreview} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {installStarterFleet} from '../src/game/starterFleet';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {settleDueStarterExpeditions,readStarterExpeditionReturn} from '../src/game/starterExpeditionReturns';
import {dispatchAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';
import {settleDueAdvancedExpeditions,readAdvancedExpeditionReturn} from '../src/game/advancedExpeditionReturns';
let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,start:Date;
// 2026-10-10: 0256/0279 refuse a settlement cutoff later than Postgres clock_timestamp(), which no test can fake, so this
// calendar sits in the real past (the 790271776 convention) and every facility completes an hour before it.
beforeEach(async()=>{start=new Date(Math.floor((Date.now()-3*86400000)/1000)*1000);f=await vehicleBurnDatabase('expedition_barge',1,{},{completedAt:new Date(+start-3600000)});},120_000);
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
it('earns all barge provisions with the free starter, runs both fleets, then conserves cargo and one completed use through paused restart',async()=>{
 f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 const authority={baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
 const berth=randomUUID(),lodge=randomUUID();
 for(const [id,type,x] of [[berth,'berth',8],[lodge,'lodge',12]] as const){
  await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${id},${f.actor},${f.baseId},${type},${x},2)`;
  await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${id},'build',${new Date(+start-7200000).toISOString()},${new Date(+start-3600000).toISOString()},${new Date(+start-3600000).toISOString()})`;
 }
 const starter=await installStarterFleet(f.conn.db,f.actor,berth,authority);
 let now=new Date(start);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED','STARTER_FLEET_ENABLED','STARTER_EXPEDITIONS_ENABLED'])vi.stubEnv(flag,'true');
 const bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
 async function reader(){bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now/1000),32);return prefetchExpeditionTermReader(bank.connect,bank.policy);}
 const command=()=>({id:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:'long_survey',policyVersion:PHASE_E_ADVANCED_EXPEDITIONS.currentPolicyVersion});
 const profile=advancedExpeditionPreview({family:f.identity.family,tier:f.identity.tier,homeRealmId:'crownlands',routeId:'long_survey'});
 expect(await f.conn.sql`select * from resource_stocks`).toHaveLength(0);
 await expect(dispatchAdvancedExpedition(f.conn.db,f.actor,command(),authority,{reader:await reader(),clock:()=>now})).rejects.toMatchObject({code:'INSUFFICIENT_RAW_STOCK'});
 expect(await f.conn.sql`select * from resource_stock_operations`).toHaveLength(0);expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(0);
 const savedStarter=[];
 async function startFree(routeId:'common_elderwood'|'common_crownlands'){
  const p=starterRoutePreview('crownlands',routeId);
  return dispatchStarterExpedition(f.conn.db,f.actor,{id:randomUUID(),baseId:f.baseId,installationId:starter.installationId,routeId,routeVersion:p.routeCatalogueVersion,rewardVersion:p.rewardTableVersion},authority,{reader:await reader(),clock:()=>now});
 }
 for(const route of ['common_elderwood','common_crownlands'] as const){
  const trip=await startFree(route);now=trip.returnsAt;vi.setSystemTime(now);
  await f.conn.db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,now));
  const proof=(await readStarterExpeditionReturn(f.conn.db,trip.id))!;expect(proof.entries.reduce((sum,e)=>sum+e.delta,0n)).toBe(0n);savedStarter.push(proof);
 }
 const acceptedCommand=command(),advanced=await dispatchAdvancedExpedition(f.conn.db,f.actor,acceptedCommand,authority,{reader:await reader(),clock:()=>now});
 expect(advanced.completedBefore).toBe(0n);expect(advanced.gross).toBe(BigInt(profile.grossQuantity));
 const suppliesBefore=await f.conn.sql`select * from resource_stock_operations order by id`;
 await expect(dispatchAdvancedExpedition(f.conn.db,f.actor,command(),authority,{reader:await reader(),clock:()=>now})).rejects.toMatchObject({code:'ADVANCED_INFLIGHT'});
 expect(await f.conn.sql`select * from resource_stock_operations order by id`).toEqual(suppliesBefore);
 const alongside=await startFree('common_elderwood');expect(+alongside.departedAt).toBe(+advanced.departedAt);expect(+alongside.returnsAt).toBeLessThan(+advanced.returnsAt);
 now=alongside.returnsAt;vi.setSystemTime(now);await f.conn.db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,now));savedStarter.push((await readStarterExpeditionReturn(f.conn.db,alongside.id))!);
 expect(await f.conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,new Date(+advanced.returnsAt-1)))).toEqual([]);
 expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(0);
 vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');now=advanced.returnsAt;vi.setSystemTime(now);
 const reopened=f.conn.reopen();
 try{
  const [proof]=await reopened.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,now));
  expect(proof!.receipt.completedTotal).toBe(1n);expect(proof!.entries.reduce((sum,e)=>sum+e.delta,0n)).toBe(0n);
  expect(await readAdvancedExpeditionReturn(reopened.db,advanced.id)).toEqual(proof);
  expect(await dispatchAdvancedExpedition(reopened.db,f.actor,acceptedCommand,authority)).toEqual(advanced);
  expect(await reopened.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,now))).toEqual([]);
  const stock=await reopened.sql`select resource_id,available,reserved from resource_stocks where base_id=${f.baseId} order by resource_id`;
  const netByResource=new Map<string,bigint>();for(const trip of [...savedStarter.map(p=>p.expedition),advanced])netByResource.set(trip.resourceId,(netByResource.get(trip.resourceId)??0n)+trip.net);
  for(const supply of profile.supplies)netByResource.set(supply.resourceId,netByResource.get(supply.resourceId)!-BigInt(supply.quantity));
  expect(stock).toEqual([...netByResource].sort(([a],[b])=>a.localeCompare(b)).map(([resource_id,available])=>({resource_id,available:String(available),reserved:'0'})));
  const gross=savedStarter.reduce((n,p)=>n+p.expedition.gross,advanced.gross),tax=savedStarter.reduce((n,p)=>n+p.expedition.tax,advanced.tax);
  expect(gross).toBe(tax+[...netByResource.values()].reduce((n,v)=>n+v,0n)+profile.supplies.reduce((n,s)=>n+BigInt(s.quantity),0n));
  expect(await reopened.sql`select * from advanced_expedition_returns`).toHaveLength(1);
  expect(await reopened.sql`select * from advanced_expedition_inflight`).toHaveLength(0);
 }finally{await reopened.sql.end();}
},120_000);
