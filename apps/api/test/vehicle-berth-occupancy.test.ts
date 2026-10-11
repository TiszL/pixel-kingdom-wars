/** Current base views exclude permanent advanced reservations without exposing private journals. */
import {randomUUID} from 'node:crypto';
import {BUILD_COSTS,BuildingType} from '@shardkeep/shared';
import {Keypair} from '@solana/web3.js';
import type {FastifyInstance} from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {buildApp,type AppDeps} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createDb,type Db} from '../src/db/client';
import {buildings,deedOwnershipObservations,players,sessions} from '../src/db/schema';
import {assertFreshLockedBaseAuthority,registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {createVehicleActivationReservations} from '../src/game/vehicleActivationReservations';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {TEST_CONFIG} from './helpers';
import {provisionApiRuntimeLogin} from './fixtures/apiRuntimeLogin';
import {SEAL_BOUND_PAIRED_HTTP_CASE_MS} from './sealLatencyBudgets';
type Provider={occupiedBerthIds(wallet:string,baseId:string):Promise<readonly string[]>};
let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,cookies:Record<string,string>;const apps:FastifyInstance[]=[];
beforeEach(async()=>{
 f=await vehicleBurnDatabase();vi.stubEnv('FREE_ONBOARDING','true');vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','true');
 const level=BUILD_COSTS.berth.requiresKeepLevel;await f.conn.sql`update bases set keep_level=${level} where id=${f.baseId}`;
 await f.conn.db.insert(buildings).values({playerWallet:f.actor,baseId:f.baseId,type:BuildingType.Keep,level,tx:0,ty:0});
 const [session]=await f.conn.db.insert(sessions).values({wallet:f.actor,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.actor,session!.id)};
},120_000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function open(provider?:Provider,db:Db=f.conn.db){vi.stubEnv('MULTI_BASE_ENABLED','false');try{const deps={...(provider?{vehicleBerthOccupancyProvider:provider}:{})};const app=await buildApp(TEST_CONFIG,db,deps as AppDeps);apps.push(app);await app.ready();return app;}finally{vi.stubEnv('MULTI_BASE_ENABLED','true');}}
const get=(app:FastifyInstance,path='/base')=>app.inject({url:path+'?baseId='+f.baseId,cookies});
describe('advanced reservation visibility in starter views',()=>{
 it('filters the actual base and starter responses instead of advertising a reserved berth',async()=>{
  const provider={occupiedBerthIds:vi.fn(async()=>[f.berthId])},app=await open(provider);
  const base=await get(app),fleet=await get(app,'/starter-fleet');expect(base.statusCode,base.body).toBe(200);expect(fleet.statusCode,fleet.body).toBe(200);
  expect(base.json().starterFleet.eligibleBerths).toEqual([]);expect(fleet.json().eligibleBerths).toEqual([]);expect(provider.occupiedBerthIds).toHaveBeenCalledWith(f.actor,f.baseId);
  expect(base.body).not.toContain(f.reservation.id);expect(fleet.body).not.toContain(f.identity.assetId);
 });
 it('uses actual owner-only occupancy during pause and leaves the unconfigured response unchanged',async()=>{
  const {createVehicleBerthOccupancyProvider}=await import('../src/game/vehicleBerthOccupancy'),provider=createVehicleBerthOccupancyProvider(f.conn.db);
  expect(Object.keys(provider)).toEqual(['occupiedBerthIds']);expect(Object.isFrozen(provider)).toBe(true);expect(await provider.occupiedBerthIds(f.actor,f.baseId)).toEqual([f.berthId]);
  vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');const withProvider=await open(provider),absent=await open();
  expect((await get(withProvider)).json().starterFleet.eligibleBerths).toEqual([]);expect((await get(absent)).json().starterFleet.eligibleBerths).toEqual([expect.objectContaining({berthId:f.berthId})]);
 });
 it('does not invoke private reads for unauthenticated, failed, HEAD or unrelated routes',async()=>{
  const provider={occupiedBerthIds:vi.fn(async()=>[f.berthId])},app=await open(provider);
  expect((await app.inject({url:'/base?baseId='+f.baseId})).statusCode).toBe(401);
  expect((await app.inject({url:'/starter-fleet?baseId=invalid',cookies})).statusCode).toBe(400);
  expect((await app.inject({method:'HEAD',url:'/base?baseId='+f.baseId,cookies})).statusCode).toBe(200);
  await app.inject({url:'/bases',cookies});expect(provider.occupiedBerthIds).not.toHaveBeenCalled();
 });
 it('holds unavailable occupancy without changing any reservation or installation history',async()=>{
  const before=await f.conn.sql`select to_jsonb(t) value from vehicle_activation_reservations t`,app=await open({occupiedBerthIds:async()=>{throw Error('private reader offline');}});
  for(const path of ['/base','/starter-fleet']){const result=await get(app,path);expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('VEHICLE_BERTH_VIEW_HELD');}
  expect(await f.conn.sql`select to_jsonb(t) value from vehicle_activation_reservations t`).toEqual(before);expect(await f.conn.sql`select * from advanced_vehicle_installations`).toHaveLength(0);
 });
 it('authorizes the current stable owner, requires an active slot and rejects outer transactions',async()=>{
  const {createVehicleBerthOccupancyProvider}=await import('../src/game/vehicleBerthOccupancy'),provider=createVehicleBerthOccupancyProvider(f.conn.db);
  await expect(provider.occupiedBerthIds(Keypair.generate().publicKey.toBase58(),f.baseId)).rejects.toThrow();
  await expect(f.conn.db.transaction(async tx=>createVehicleBerthOccupancyProvider(tx as unknown as Db))).rejects.toMatchObject({code:'VEHICLE_BERTH_VIEW_TOP_LEVEL'});
  await f.conn.sql`update base_slots set active=false where base_id=${f.baseId}`;await expect(provider.occupiedBerthIds(f.actor,f.baseId)).rejects.toMatchObject({code:'BASE_NOT_OWNED'});
 });
 it('keeps the berth occupied for the actual buyer after deed transfer without requiring the original burn actor',async()=>{
  const {createVehicleBerthOccupancyProvider}=await import('../src/game/vehicleBerthOccupancy'),provider=createVehicleBerthOccupancyProvider(f.conn.db),mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();
  expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);
  await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:new Date(),status:'owned',source:'rpc-finalized',auditHash:randomUUID()});await f.conn.db.insert(players).values({wallet:buyer});
  await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});
  await expect(provider.occupiedBerthIds(f.actor,f.baseId)).rejects.toThrow();expect(await provider.occupiedBerthIds(buyer,f.baseId)).toEqual([f.berthId]);
  expect((await f.conn.sql`select wallet from vehicle_activation_reservations where id=${f.reservation.id}`)[0]!.wallet).toBe(f.actor);
 });
 it('serves through a non-owner gameplay LOGIN without granting private vehicle reads',async()=>{
  const {createVehicleBerthOccupancyProvider}=await import('../src/game/vehicleBerthOccupancy');let runtime:ReturnType<typeof createDb>|undefined;
  // 2026-10-10: the actual provisioned API runtime LOGIN (fixtures/apiRuntimeLogin.ts), not hand
  // grants on every table: the private-source seals read a direct session_user grant
  // as tampering, and the base read needs the provisioner's function EXECUTE grants.
  const login=await provisionApiRuntimeLogin(f.conn.sql,'vehicle_view');
  try{runtime=createDb(login.url);
   await expect(runtime.sql`select * from vehicle_activation_reservations`).rejects.toMatchObject({code:'42501'});await expect(createVehicleBerthOccupancyProvider(runtime.db).occupiedBerthIds(f.actor,f.baseId)).rejects.toMatchObject({code:'VEHICLE_BERTH_VIEW_OWNER'});
   const app=await open(createVehicleBerthOccupancyProvider(f.conn.db),runtime.db),result=await get(app);expect(result.statusCode,result.body).toBe(200);expect(result.json().starterFleet.eligibleBerths).toEqual([]);
   expect(await runtime.sql`select has_table_privilege(current_user,'vehicle_activation_reservations','SELECT') allowed`).toEqual([{allowed:false}]);
   await app.close();apps.splice(apps.indexOf(app),1);
  }finally{await runtime?.sql.end();await login.close();}
 },120_000);
 // Field 2026-10-06 (QA chain lane): every native cold start fires GET /base and
 // GET /starter-fleet together. The view re-read the player/base/slot rows `for
 // update nowait`, so the two READS refused each other and one answered 503
 // VEHICLE_BERTH_VIEW_HELD although its own data was fine. A read must never
 // fail because another read for the same wallet is in flight.
 it('answers concurrent Home and starter-fleet reads for one wallet with the same filtered view',async()=>{
  const {createVehicleBerthOccupancyProvider}=await import('../src/game/vehicleBerthOccupancy'),free=randomUUID();
  // A second, unreserved berth makes the compared content non-empty: the
  // reserved berth must stay hidden and the free one must stay advertised.
  await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${free},${f.actor},${f.baseId},'berth',8,8)`;
  await f.conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${randomUUID()},${f.actor},${f.baseId},${free},'build',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour')`;
  const app=await open(createVehicleBerthOccupancyProvider(f.conn.db));
  const alone=await get(app),view=alone.json().starterFleet.eligibleBerths;expect(alone.statusCode,alone.body).toBe(200);
  expect(view).toEqual([expect.objectContaining({berthId:free})]);expect((await get(app,'/starter-fleet')).json().eligibleBerths).toEqual(view);
  const failures:string[]=[];
  for(let round=0;round<20;round++){
   const [base,fleet]=await Promise.all([get(app),get(app,'/starter-fleet')]);
   for(const r of [base,fleet])if(r.statusCode!==200)failures.push(`round ${round} ${r.statusCode} ${r.body}`);
   if(base.statusCode===200)expect(base.json().starterFleet.eligibleBerths).toEqual(view);
   if(fleet.statusCode===200)expect(fleet.json().eligibleBerths).toEqual(view);
  }
  expect(failures).toEqual([]);
 },SEAL_BOUND_PAIRED_HTTP_CASE_MS);
 // The writers' serialization is theirs, not the view's: a new reservation still
 // takes the player root `for update nowait` and is refused while a writer holds
 // it, whereas the read-only view neither waits behind that writer nor fails.
 it('leaves the reservation writer lock unchanged while the view reads the committed set beside a held writer',async()=>{
  const {createVehicleBerthOccupancyProvider}=await import('../src/game/vehicleBerthOccupancy'),provider=createVehicleBerthOccupancyProvider(f.conn.db),reservations=createVehicleActivationReservations(f.conn.db);
  let release!:()=>void,locked!:()=>void;const hold=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{locked=r;});
  // Exactly the rows a transfer or reservation holds: player -> base -> slot.
  const writer=f.conn.sql.begin(async tx=>{
   await tx`select wallet from players where wallet=${f.actor} for update`;await tx`select id from bases where id=${f.baseId} for update`;
   await tx`select base_id from base_slots where base_id=${f.baseId} for update`;locked();await hold;
  });
  try{
   await ready;
   const waited=new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('berth view waited behind the writer')),5_000));
   expect(await Promise.race([provider.occupiedBerthIds(f.actor,f.baseId),waited])).toEqual([f.berthId]);
   await expect(reservations.reserve({wallet:f.actor,assetId:Keypair.generate().publicKey.toBase58(),berthId:randomUUID(),idempotencyKey:randomUUID()},
    {baseId:f.baseId,assertAuthority:async(tx,w,id)=>{await assertFreshLockedBaseAuthority(tx,w,id);}})).rejects.toMatchObject({statusCode:503,code:'VEHICLE_BUSY'});
  }finally{release();await writer;}
  expect(await f.conn.sql`select id from vehicle_activation_reservations`).toEqual([{id:f.reservation.id}]);
 });
});
