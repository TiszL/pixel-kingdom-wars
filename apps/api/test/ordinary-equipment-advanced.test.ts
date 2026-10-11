/** One real advanced installation and the base's starter share one tool. */
import {randomUUID} from 'node:crypto';
import {Keypair,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {it,expect,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {installStarterFleet} from '../src/game/starterFleet';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {dispatchAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {settleDueAdvancedExpeditions} from '../src/game/advancedExpeditionReturns';
import {settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {startOrdinaryEquipment} from '../src/game/ordinaryEquipment';
import {settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
it('races the last actual crafted Compass across starter/advanced, rolls back the loser and reuses only on actual return',async()=>{
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(flag,'true');
 const initial=new Date(Math.floor((Date.now()-3*86400000)/1000)*1000),f=await vehicleBurnDatabase('survey_balloon',1,{}, {completedAt:new Date(+initial-3600000)});
 try{
  f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
  const authority={baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
  const secondBerth=randomUUID(),completed=new Date(+initial-3_600_000).toISOString(),started=new Date(+initial-7_200_000).toISOString();for(const [type,id,x] of [['workshop',randomUUID(),5],['lodge',randomUUID(),8],['berth',secondBerth,11]] as const){
   await f.conn.sql`insert into buildings(id,base_id,player_wallet,type,tx,ty) values(${id},${f.baseId},${f.actor},${type},${x},5)`;
   await f.conn.sql`insert into builder_jobs(base_id,player_wallet,building_id,kind,started_at,finishes_at,completed_at) values(${f.baseId},${f.actor},${id},'build',${started},${completed},${completed})`;
  }
  const starter=await installStarterFleet(f.conn.db,f.actor,secondBerth,authority);
  for(const i of ordinaryEquipmentRecipe().inputs)await f.conn.sql`insert into crafting_stocks(base_id,item_id,available) values(${f.baseId},${i.itemId},${i.quantity})`;
  await f.conn.sql`insert into resource_stocks(base_id,resource_id,available) values(${f.baseId},'rough_prism',1000)`;
  let now=initial;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  const craft=await startOrdinaryEquipment(f.conn.db,f.actor,{idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:'craft_route_compass',recipeVersion:1,quantity:1},authority,{clock:()=>now});if(craft.status!=='accepted')throw Error('fixturecraft');
  now=new Date(craft.receipt.readyAt);vi.setSystemTime(now);await f.conn.db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,now));
  const bank=await createMiningTermFixture({day:initial.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
  const reader=async()=>{bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now/1000)),32);return prefetchExpeditionTermReader(bank.connect,bank.policy);};
  const fitting={itemId:'route_compass',policyVersion:1} as const,preview=starterRoutePreview('crownlands','coastal_survey');
  const a={id:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:'coastal_survey',policyVersion:1,fitting};
  const s={id:randomUUID(),baseId:f.baseId,installationId:starter.installationId,routeId:preview.routeId,routeVersion:preview.routeCatalogueVersion,rewardVersion:preview.rewardTableVersion,fitting};
  const goA=async()=>dispatchAdvancedExpedition(f.conn.db,f.actor,a,authority,{reader:await reader(),clock:()=>now});
  const goS=async()=>dispatchStarterExpedition(f.conn.db,f.actor,s,authority,{reader:await reader(),clock:()=>now});
  const attempts=await Promise.allSettled([goA(),goS()]);expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(r=>r.status==='rejected')).toHaveLength(1);
  const winner=attempts.find(r=>r.status==='fulfilled');if(winner?.status!=='fulfilled')throw Error('fixturewinner');now=winner.value.returnsAt;
  expect((await f.conn.sql`select available,reserved from ordinary_equipment_stocks where base_id=${f.baseId}`)[0]).toEqual({available:'0',reserved:'1'});
  await expect(f.conn.db.transaction(async tx=>{await settleDueStarterExpeditions(tx,f.baseId,now);await settleDueAdvancedExpeditions(tx,f.baseId,now);throw Error('outer rollback');})).rejects.toThrow('outer rollback');
  expect((await f.conn.sql`select available,reserved from ordinary_equipment_stocks where base_id=${f.baseId}`)[0]).toEqual({available:'0',reserved:'1'});
  await f.conn.db.transaction(async tx=>{await settleDueStarterExpeditions(tx,f.baseId,now);await settleDueAdvancedExpeditions(tx,f.baseId,now);});
  vi.setSystemTime(now);const second=attempts[0]!.status==='fulfilled'?await goS():await goA();
  await f.conn.db.transaction(async tx=>{await settleDueStarterExpeditions(tx,f.baseId,second.returnsAt);await settleDueAdvancedExpeditions(tx,f.baseId,second.returnsAt);});
  expect((await f.conn.sql`select available,reserved from ordinary_equipment_stocks where base_id=${f.baseId}`)[0]).toEqual({available:'1',reserved:'0'});
  expect((await f.conn.sql`select completed_total from advanced_expedition_returns`)[0]!.completed_total).toBe('1');
  expect(await f.conn.sql`select * from ordinary_equipment_reservations`).toHaveLength(2);expect(await f.conn.sql`select * from ordinary_equipment_releases`).toHaveLength(2);
  // Even explicit SQL grants cannot turn a restricted LOGIN into the writer.
  const role=`equipment_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role}`);
  try{await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);await f.conn.sql.unsafe(`grant all on ordinary_equipment_stocks,ordinary_equipment_jobs to ${role}`);
   await expect(f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));await tx.execute(sql`update ordinary_equipment_stocks set available=available+1 where base_id=${f.baseId}`);})).rejects.toThrow();
  }finally{await f.conn.sql.unsafe(`drop owned by ${role}`);await f.conn.sql.unsafe(`drop role ${role}`);}
 }finally{vi.useRealTimers();vi.unstubAllEnvs();await f.dispose();}
},120_000);
