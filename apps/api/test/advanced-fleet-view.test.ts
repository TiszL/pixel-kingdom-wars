/** Current-owner fleet state from actual installation, service and return
 * receipts. Reading this view never creates a return or exposes seller consent. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {Keypair} from '@solana/web3.js';
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import {buildApp,type AppDeps} from '../src/app';
import {createDb,type Db} from '../src/db/client';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions,players,raids,baseRaidLocks} from '../src/db/schema';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {createVehicleServiceApplications} from '../src/game/vehicleServiceApplications';
import {vehicleServiceInstalledFixture,vehicleServiceConsentFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceExpeditions,vehicleServiceInstallation} from './fixtures/vehicleService';
import {ADMIN_DATABASE_URL} from './db-url';
import {TEST_CONFIG} from './helpers';

type Provider=ReturnType<typeof import('../src/game/advancedFleetView')['createAdvancedFleetView']>;
let f:Awaited<ReturnType<typeof vehicleServiceInstalledFixture>>,cookies:Record<string,string>;
const apps:FastifyInstance[]=[],flags=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'];
const privateTables=['vehicle_mint_registry','vehicle_activation_reservations','vehicle_burn_preparations','vehicle_burn_signed_wires','vehicle_burn_consumptions','advanced_vehicle_installations','vehicle_service_intents','vehicle_service_burn_preparations','vehicle_service_signed_wires','vehicle_service_consumptions','vehicle_service_applications','advanced_expeditions','advanced_expedition_inflight','advanced_expedition_supplies','advanced_expedition_returns','advanced_expedition_entries'];
const rootKeys=['version','wallet','baseId','serverNow','acceptingNewActions','vehicles'].sort(),vehicleKeys=['installationId','berthId','family','tier','revision','completedTotal','allowanceStart','remainingUses','away','pendingService'].sort();
function enabled(){for(const flag of flags)vi.stubEnv(flag,'true');}
beforeEach(async()=>{enabled();f=await vehicleServiceInstalledFixture();cookies=await session(f.actor);},120_000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function session(wallet:string){const [s]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
async function capability(){const {createAdvancedFleetView}=await import('../src/game/advancedFleetView');return createAdvancedFleetView(f.conn.db);}
async function open(provider?:Provider,db:Db=f.conn.db){const old=process.env.MULTI_BASE_ENABLED;vi.stubEnv('MULTI_BASE_ENABLED','false');try{const app=await buildApp(TEST_CONFIG,db,{...(provider?{advancedFleetViewProvider:provider}:{})} as AppDeps);apps.push(app);await app.ready();return app;}finally{vi.stubEnv('MULTI_BASE_ENABLED',old);}}
const url=(baseId=f.baseId)=>'/vehicles/fleet?baseId='+baseId;
async function get(app:FastifyInstance,baseId=f.baseId,auth=cookies){const response=await app.inject({url:url(baseId),cookies:auth});if(response.statusCode===200){const view=response.json();expect(Object.keys(view).sort()).toEqual(rootKeys);for(const vehicle of view.vehicles)expect(Object.keys(vehicle).sort()).toEqual(vehicleKeys);expect(response.headers['cache-control']).toBe('private, no-store');}return response;}
async function snapshot(){const values:Record<string,unknown>={};for(const table of [...privateTables,'resource_stocks','resource_stock_operations','resource_stock_entries','accounts'])values[table]=await f.conn.sql.unsafe(`select to_jsonb(t)::text value from public."${table}" t order by to_jsonb(t)::text`);return values;}
function installed(extra:Record<string,unknown>={}){return {installationId:f.reservation.id,berthId:f.berthId,family:f.identity.family,tier:f.identity.tier,revision:0,completedTotal:'0',allowanceStart:'0',remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall,away:false,pendingService:false,...extra};}

describe('authenticated current advanced fleet view',()=>{
 it('requires authentication and holds an absent private capability without reading or changing lifecycle',async()=>{
  const app=await open(),before=await snapshot();expect((await app.inject({url:url()})).statusCode).toBe(401);const result=await get(app);expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('ADVANCED_FLEET_UNAVAILABLE');expect(result.headers['cache-control']).toBe('private, no-store');expect(await snapshot()).toEqual(before);
 });

 it('requires a strict explicit base query and makes unknown and foreign bases indistinguishable',async()=>{
  const app=await open(await capability());for(const query of ['', '?baseId=invalid', '?baseId='+f.baseId+'&wallet='+f.actor, '?baseId='+f.baseId+'&baseId='+f.baseId])expect((await app.inject({url:'/vehicles/fleet'+query,cookies})).statusCode).toBe(400);
  const other=Keypair.generate().publicKey.toBase58();await f.conn.db.insert(players).values({wallet:other});const foreign=await session(other),a=await get(app,f.baseId,foreign),b=await get(app,randomUUID(),foreign);expect(a.statusCode,a.body).toBe(404);expect(a.json()).toEqual(b.json());
  await f.conn.sql`update base_slots set active=false where base_id=${f.baseId}`;const inactive=await get(app);expect(inactive.statusCode,inactive.body).toBe(404);
 });

 it('returns an empty fleet for a legitimate current-owner base that has never admitted or burned a vehicle',async()=>{
  const wallet=Keypair.generate().publicKey.toBase58(),baseId=randomUUID();
  await f.conn.db.insert(players).values({wallet});await f.conn.sql`insert into bases(id,owner_wallet) values(${baseId},${wallet})`;await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  const auth=await session(wallet),app=await open(await capability()),before=await snapshot();
  expect(await f.conn.sql`select id from vehicle_activation_reservations where base_id=${baseId}`).toHaveLength(0);expect(await f.conn.sql`select reservation_id from advanced_vehicle_installations where base_id=${baseId}`).toHaveLength(0);
  const response=await get(app,baseId,auth);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({version:1,wallet,baseId,acceptingNewActions:true,vehicles:[]});expect(await snapshot()).toEqual(before);
 });

 it('projects an actual return and upgrade without rewriting the original installation, and exposes only pending status for the next service',async()=>{
  const trips=await vehicleServiceExpeditions(f),trip=await trips.depart();await trips.complete(trip);cookies=await session(f.actor);
  const original=await f.conn.sql`select to_jsonb(i)::text value from advanced_vehicle_installations i`,consent=await vehicleServiceConsentFixture(f),prepared=await consent.preparations.prepare(f.actor,consent.intent.id);consent.finalizeService(prepared);await createVehicleServiceApplications(f.conn.db,{verifyBurn:consent.reader.verify}).recover(f.actor,consent.intent.id);
  const app=await open(await capability()),before=await snapshot(),response=await get(app);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({version:1,wallet:f.actor,baseId:f.baseId,acceptingNewActions:true,vehicles:[installed({tier:2,revision:1,completedTotal:'1',remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall-1})]});expect(await snapshot()).toEqual(before);
  const next=await vehicleServiceConsentFixture(f,{tier:2}),pendingBefore=await snapshot(),pending=await get(app);expect(pending.statusCode,pending.body).toBe(200);expect(pending.json().vehicles).toEqual([installed({tier:2,revision:1,completedTotal:'1',remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall-1,pendingService:true})]);for(const secret of [next.intent.id,next.asset.identity.assetId,next.intent.idempotencyKey,consent.intent.id,consent.asset.identity.assetId])expect(pending.body).not.toContain(secret);
  expect(await snapshot()).toEqual(pendingBefore);expect(await f.conn.sql`select to_jsonb(i)::text value from advanced_vehicle_installations i`).toEqual(original);
 });

 it('keeps a due expedition away until a real return receipt exists, even while paused and with chain providers offline',async()=>{
  const trips=await vehicleServiceExpeditions(f),trip=await trips.depart();vi.setSystemTime(new Date(+trip.returnsAt+1));cookies=await session(f.actor);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');f.setOnline(false);
  const app=await open(await capability()),before=await snapshot(),source=vi.spyOn(f.rpc,'getGenesisHash');source.mockClear();
  for(let n=0;n<2;n++){const response=await get(app);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({acceptingNewActions:false,vehicles:[installed({away:true})]});}
  expect(source).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(0);
  await trips.complete(trip);const returned=await get(app);expect(returned.statusCode,returned.body).toBe(200);expect(returned.json().vehicles).toEqual([installed({completedTotal:'1',remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall-1})]);expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(1);
 });

 it('follows the actual transferred base to its buyer while hiding the seller and original pending service consent',async()=>{
  const pending=await vehicleServiceConsentFixture(f),mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);await f.conn.db.insert(players).values({wallet:buyer});await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});const buyerAuth=await session(buyer);
  for(const flag of flags)vi.stubEnv(flag,'false');const app=await open(await capability()),before=await snapshot(),response=await get(app,f.baseId,buyerAuth);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({wallet:buyer,baseId:f.baseId,acceptingNewActions:false,vehicles:[installed({pendingService:true})]});for(const secret of [f.actor,f.identity.assetId,pending.intent.id,pending.asset.identity.assetId,pending.intent.idempotencyKey])expect(response.body).not.toContain(secret);
  const former=await get(app),unknown=await get(app,randomUUID());expect(former.statusCode,former.body).toBe(404);expect(former.json()).toEqual(unknown.json());expect(await snapshot()).toEqual(before);
 });

 it('continues current-owner reads during a real incoming raid lock and reports strict parent pauses without releasing anything',async()=>{
  const attacker=Keypair.generate().publicKey.toBase58(),attackerBase=randomUUID();await f.conn.db.insert(players).values({wallet:attacker});await f.conn.sql`insert into bases(id,owner_wallet) values(${attackerBase},${attacker})`;
  const [raid]=await f.conn.db.insert(raids).values({idempotencyKey:randomUUID(),attackerWallet:attacker,attackerBaseId:attackerBase,defenderWallet:f.actor,defenderBaseId:f.baseId,seed:1n,snapshot:{fixture:'fleet read must not alter frozen raid'},armySnapshot:{},ordersDeadlineAt:new Date(Date.now()+60_000)}).returning();await f.conn.db.insert(baseRaidLocks).values({baseId:f.baseId,raidId:raid!.id,expiresAt:raid!.ordersDeadlineAt});
  const app=await open(await capability()),before=await snapshot(),locks=await f.conn.sql`select to_jsonb(l)::text value from base_raid_locks l`;
  const raided=await get(app);expect(raided.statusCode,raided.body).toBe(200);expect(raided.json().acceptingNewActions).toBe(false);
  for(const flag of flags){vi.stubEnv(flag,'false');const response=await get(app);expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({acceptingNewActions:false,vehicles:[installed()]});vi.stubEnv(flag,'true');}
  expect(await snapshot()).toEqual(before);expect(await f.conn.sql`select to_jsonb(l)::text value from base_raid_locks l`).toEqual(locks);
 });

 it('lists separately installed families from real burn receipts',async()=>{
  // Additional fixture berth is not proof of ordinary K-201 construction.
  const other=await vehicleServiceInstallation(f,'cargo_cutter'),app=await open(await capability()),before=await snapshot(),response=await get(app);expect(response.statusCode,response.body).toBe(200);expect(response.json().vehicles).toHaveLength(2);expect(response.json().vehicles).toEqual(expect.arrayContaining([installed(),{...installed(),installationId:other.reservation.id,berthId:other.reservation.berthId,family:'cargo_cutter'}]));expect(await snapshot()).toEqual(before);
 });

 it('serves the owner projection through a restricted LOGIN without exposing private lifecycle tables',async()=>{
  const provider=await capability(),role='advanced_fleet_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined,app:FastifyInstance|undefined;await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant select on sessions,players,alpha_access to ${role}`);const [database]=await f.conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());for(const table of privateTables)await expect(runtime.sql.unsafe(`select * from public."${table}"`)).rejects.toMatchObject({code:'42501'});
   app=await open(provider,runtime.db);const before=await snapshot(),response=await get(app);expect(response.statusCode,response.body).toBe(200);expect(response.json().vehicles).toEqual([installed()]);expect(await snapshot()).toEqual(before);for(const table of privateTables)expect(await runtime.sql`select has_table_privilege(current_user,${'public.'+table},'SELECT') allowed`).toEqual([{allowed:false}]);
  }finally{if(app){await app.close();apps.splice(apps.indexOf(app),1);}await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 });
});
