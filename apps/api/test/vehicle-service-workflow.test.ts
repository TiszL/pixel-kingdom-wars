/** Authenticated redacted service history over actual Core fixtures and signed
 * packets. Registry membership is owner-attested; this does not relay or sign. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {buildApp,type AppDeps} from '../src/app';
import {createDb,type Db} from '../src/db/client';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions,players} from '../src/db/schema';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import type {VehicleServicePreparation} from '@shardkeep/shared/vehicleServiceApi';
import {vehicleServicePreparationFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceAsset} from './fixtures/vehicleService';
import {ADMIN_DATABASE_URL} from './db-url';
import {TEST_CONFIG} from './helpers';

type Fixture=Awaited<ReturnType<typeof vehicleServicePreparationFixture>>;
type Provider=ReturnType<typeof import('../src/game/vehicleServiceWorkflow')['createVehicleServiceWorkflow']>;
let f:Fixture,cookies:Record<string,string>;
const apps:FastifyInstance[]=[],flags=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'];
const privateTables=['vehicle_mint_registry','vehicle_activation_reservations','vehicle_burn_preparations','vehicle_burn_signed_wires','vehicle_burn_consumptions','advanced_vehicle_installations','vehicle_service_intents','vehicle_service_burn_preparations','vehicle_service_signed_wires','vehicle_service_consumptions','vehicle_service_applications'];
function enabled(){for(const flag of flags)vi.stubEnv(flag,'true');}
beforeEach(async()=>{enabled();f=await vehicleServicePreparationFixture();cookies=await session(f.actor);},120_000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function session(wallet:string){const [s]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
async function workflow(providers=true,rpc=f.rpc){
 const {createVehicleServiceWorkflow}=await import('../src/game/vehicleServiceWorkflow');
 return createVehicleServiceWorkflow(f.conn.db,providers?{connect:()=>rpc,trust:f.trust,getBlockhash:async()=>f.blockhash}:{});
}
async function open(provider?:Provider,db:Db=f.conn.db){
 // Existing app setup pattern avoids starting unrelated multi-base background work.
 // Restore the caller's gate; opening an app must not silently unpause admission.
 const old=process.env.MULTI_BASE_ENABLED;vi.stubEnv('MULTI_BASE_ENABLED','false');
 try{const app=await buildApp(TEST_CONFIG,db,{...(provider?{vehicleServiceWorkflowProvider:provider}:{})} as AppDeps);apps.push(app);await app.ready();return app;}
 finally{vi.stubEnv('MULTI_BASE_ENABLED',old);}
}
const path=(id=f.intent.id,suffix='')=>'/vehicles/services/'+id+suffix;
const command=()=>({installationId:f.reservation.id,assetId:f.asset.identity.assetId,operation:'upgrade' as const,idempotencyKey:f.intent.idempotencyKey});
function redacted(value:unknown):void{
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){expect(['anchor','owner_anchor','assetDataHex','collectionDataHex','proof','history','signedTransactionHex','signedTransaction']).not.toContain(key);redacted(child);}
}
async function post(app:FastifyInstance,url:string,payload:Record<string,unknown>={},auth=cookies){const response=await app.inject({method:'POST',url,cookies:auth,payload});if(response.statusCode===200)redacted(response.json());return response;}
async function get(app:FastifyInstance,url=path(),auth=cookies){const response=await app.inject({url,cookies:auth});if(response.statusCode===200)redacted(response.json());return response;}
function saved(value:Record<string,unknown>){const {serverNow:ignored,...rest}=value;return rest;}
async function finalizeService(prepared:VehicleServicePreparation){
 const original=await f.preparations.get(f.actor,f.intent.id);expect(original).not.toBeNull();expect(original!.messageHex).toBe(prepared.messageHex);expect(original!.messageSha256).toBe(prepared.messageSha256);
 return f.finalizeService(original!);
}
async function prepare(app:FastifyInstance){
 const replay=await post(app,'/vehicles/services',command());expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().intent.intentId).toBe(f.intent.id);
 const response=await post(app,path(f.intent.id,'/prepare'));expect(response.statusCode,response.body).toBe(200);
 const prepared=response.json().preparation as VehicleServicePreparation;
 expect(response.json()).toMatchObject({version:1,purpose:'vehicle_service',wallet:f.actor,intent:{intentId:f.intent.id},signingAuthorized:false,broadcastAuthorized:false,serviceAuthorized:false,reservationReleaseAuthorized:false});return prepared;
}
async function recover(app:FastifyInstance){const response=await post(app,path(f.intent.id,'/recover'));expect(response.statusCode,response.body).toBe(200);return response.json();}
async function domainSnapshot(){
 const result:Record<string,unknown>={};
 for(const table of [...privateTables,'accounts'])result[table]=await f.conn.sql.unsafe(`select to_jsonb(t)::text value from public."${table}" t order by to_jsonb(t)::text`);
 return result;
}

describe('authenticated vehicle service workflow',()=>{
 it('authenticates saved history and holds an absent owner capability without touching private state',async()=>{
  const app=await open(),before=await domainSnapshot();
  expect((await app.inject({url:path()})).statusCode).toBe(401);
  const result=await get(app);expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('VEHICLE_SERVICE_WORKFLOW_UNAVAILABLE');
  expect(await domainSnapshot()).toEqual(before);
 });

 it('commits exact service artifacts and one actual upgrade, then admits a new current-tier intent through HTTP',async()=>{
  const app=await open(await workflow()),accounts=await f.conn.sql`select to_jsonb(a)::text value from accounts a order by id`,initial=await f.conn.sql`select to_jsonb(i)::text value from advanced_vehicle_installations i order by reservation_id`;
  const prepared=await prepare(app),observer=f.conn.reopen();
  try{const [saved]=await observer.sql`select encode(message_bytes,'hex') message from vehicle_service_burn_preparations where intent_id=${f.intent.id}`;expect(saved!.message).toBe(prepared.messageHex);}finally{await observer.sql.end();}
  const signed=await finalizeService(prepared),retained=await post(app,path(f.intent.id,'/signed'),{signedTransaction:Buffer.from(signed.signedTransaction).toString('base64')});
  expect(retained.statusCode,retained.body).toBe(200);expect(retained.json().signed).toMatchObject({signature:signed.signature,messageSha256:prepared.messageSha256});
  const applied=await recover(app);expect(applied).toMatchObject({status:'applied',intent:{intentId:f.intent.id},application:{tierAfter:2,revisionAfter:1,completedTotal:'0',allowanceStartAfter:'0'},signingAuthorized:false,broadcastAuthorized:false,serviceAuthorized:false,reservationReleaseAuthorized:false});
  expect((await recover(app)).application).toEqual(applied.application);
  expect(saved((await get(app,'/vehicles/services/by-key/'+f.intent.idempotencyKey)).json())).toEqual(saved(applied));
  expect(await f.conn.sql`select intent_id from vehicle_service_consumptions`).toEqual([{intent_id:f.intent.id}]);expect(await f.conn.sql`select intent_id from vehicle_service_applications`).toEqual([{intent_id:f.intent.id}]);
  // This is a NEW HTTP reservation, not the fixture's pre-existing intent replay.
  const nextAsset=await vehicleServiceAsset(f.initial,{tier:2}),nextApp=await open(await workflow(true,nextAsset.rpc)),next={installationId:f.reservation.id,assetId:nextAsset.identity.assetId,operation:'upgrade',idempotencyKey:randomUUID()};
  expect(await f.conn.sql`select id from vehicle_service_intents where asset_id=${next.assetId}`).toHaveLength(0);
  const conflict=await post(nextApp,'/vehicles/services',{...next,idempotencyKey:f.intent.idempotencyKey});expect(conflict.statusCode,conflict.body).toBe(409);expect(conflict.json().error.code).toBe('VEHICLE_SERVICE_CONFLICT');
  const admitted=await post(nextApp,'/vehicles/services',next);expect(admitted.statusCode,admitted.body).toBe(200);expect(admitted.json().intent.state).toMatchObject({installationId:f.reservation.id,tier:2,revision:1,completedTotal:'0',allowanceStart:'0'});
  const nextId=admitted.json().intent.intentId,nextPrepared=await post(nextApp,path(nextId,'/prepare'));expect(nextPrepared.statusCode,nextPrepared.body).toBe(200);expect(nextPrepared.json().intent.state).toMatchObject({tier:2,revision:1});expect(nextPrepared.json().preparation.messageSha256).toMatch(/^[0-9a-f]{64}$/);
  expect((await get(nextApp)).json().application).toEqual(applied.application);expect((await get(nextApp)).json().preparation).toEqual(prepared);
  expect(await f.conn.sql`select to_jsonb(i)::text value from advanced_vehicle_installations i order by reservation_id`).toEqual(initial);expect(await f.conn.sql`select to_jsonb(a)::text value from accounts a order by id`).toEqual(accounts);
 });

 it('recovers a finalized service with lost local wire after pause/reopen, then replays all original artifacts providerless',async()=>{
  const app=await open(await workflow()),prepared=await prepare(app);await finalizeService(prepared);
  vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');const reopened=await open(await workflow()),applied=await recover(reopened);
  expect(applied.status).toBe('applied');expect(await f.conn.sql`select intent_id from vehicle_service_signed_wires`).toHaveLength(0);
  f.setOnline(false);const offline=await open(await workflow(false)),before=await domainSnapshot();
  expect(saved((await post(offline,'/vehicles/services',command())).json())).toEqual(saved(applied));
  expect((await post(offline,path(f.intent.id,'/prepare'))).json().preparation).toEqual(prepared);
  expect(saved((await get(offline)).json())).toEqual(saved(applied));expect((await recover(offline)).application).toEqual(applied.application);
  expect(await domainSnapshot()).toEqual(before);
 });

 it('retains signed consent while paused, keeps original identity held on source outage, and performs providerless GET without writes',async()=>{
  const app=await open(await workflow()),prepared=await prepare(app),signed=await finalizeService(prepared);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
  const retained=await post(app,path(f.intent.id,'/signed'),{signedTransaction:Buffer.from(signed.signedTransaction).toString('base64')});expect(retained.statusCode,retained.body).toBe(200);
  f.setOnline(false);const held=await post(app,path(f.intent.id,'/recover'));expect(held.statusCode,held.body).toBe(503);expect(held.json().error).toMatchObject({code:'VEHICLE_SERVICE_RECOVERY_HELD',intentId:f.intent.id,status:'held',serviceAuthorized:false,reservationReleaseAuthorized:false});
  const before=await domainSnapshot(),offline=await open(await workflow(false)),genesis=vi.spyOn(f.rpc,'getGenesisHash');genesis.mockClear();
  for(const url of [path(),'/vehicles/services/by-key/'+f.intent.idempotencyKey]){const history=await get(offline,url);expect(history.statusCode,history.body).toBe(200);expect(history.json()).toMatchObject({status:'signed',intent:{intentId:f.intent.id},application:null});expect(history.headers['cache-control']).toBe('private, no-store');}
  expect(genesis).not.toHaveBeenCalled();expect(await domainSnapshot()).toEqual(before);
  f.setOnline(true);expect((await recover(app)).status).toBe('applied');
 });

 it('preserves original seller consent after stable-base transfer while the buyer cannot read or recover it',async()=>{
  const app=await open(await workflow()),mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();
  expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);await f.conn.db.insert(players).values({wallet:buyer});
  await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});const buyerCookies=await session(buyer);
  // Original committed intent may still be prepared by its actor after transfer.
  const prepared=await prepare(app),signed=await finalizeService(prepared);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
  expect((await post(app,path(f.intent.id,'/signed'),{signedTransaction:Buffer.from(signed.signedTransaction).toString('base64')})).statusCode).toBe(200);
  const applied=await recover(app);expect(applied).toMatchObject({wallet:f.actor,intent:{state:{baseId:f.baseId,berthId:f.berthId,installationId:f.reservation.id}},application:{tierAfter:2}});
  for(const suffix of ['', '/prepare','/signed','/recover']){
   const payload=suffix==='/signed'?{signedTransaction:Buffer.from(signed.signedTransaction).toString('base64')}:{},a=suffix?await post(app,path(f.intent.id,suffix),payload,buyerCookies):await get(app,path(),buyerCookies),b=suffix?await post(app,path(randomUUID(),suffix),payload,buyerCookies):await get(app,path(randomUUID()),buyerCookies);
   expect(a.statusCode,a.body).toBe(404);expect(a.json()).toEqual(b.json());
  }
  const foreignKey=await get(app,'/vehicles/services/by-key/'+f.intent.idempotencyKey,buyerCookies),unknownKey=await get(app,'/vehicles/services/by-key/'+randomUUID(),buyerCookies);expect(foreignKey.statusCode).toBe(404);expect(foreignKey.json()).toEqual(unknownKey.json());
  expect((await get(app)).body).not.toContain(buyer);expect((await f.conn.sql`select owner_wallet from bases where id=${f.baseId}`)[0]!.owner_wallet).toBe(buyer);
  enabled();const fresh=await vehicleServiceAsset(f.initial,{tier:2}),connect=vi.fn(()=>fresh.rpc),{createVehicleServiceWorkflow}=await import('../src/game/vehicleServiceWorkflow'),sellerApp=await open(createVehicleServiceWorkflow(f.conn.db,{connect,trust:f.trust,getBlockhash:async()=>f.blockhash})),request={installationId:f.reservation.id,assetId:fresh.identity.assetId,operation:'upgrade',idempotencyKey:randomUUID()},denied=await post(sellerApp,'/vehicles/services',request),unknown=await post(sellerApp,'/vehicles/services',{...request,installationId:randomUUID()});expect(denied.statusCode,denied.body).toBe(404);expect(denied.json()).toEqual(unknown.json());expect(connect).not.toHaveBeenCalled();expect(await f.conn.sql`select id from vehicle_service_intents where asset_id=${fresh.identity.assetId}`).toHaveLength(0);
 });

 it('rejects caller authority and non-service or invalid signed packets without retaining another consent',async()=>{
  const app=await open(await workflow());
  for(const extra of [{wallet:Keypair.generate().publicKey.toBase58()},{tier:4},{state:{revision:99}},{proof:{finalityVerified:true}},{serviceAuthorized:true}])expect((await post(app,'/vehicles/services',{...command(),...extra})).statusCode).toBe(400);
  const prepared=await prepare(app),signed=await finalizeService(prepared),initial=f.initial.finalizeBurn(),bad=Uint8Array.from(signed.signedTransaction);bad[4]=bad[4]!^1;
  for(const bytes of [initial.signedTransaction,bad]){const result=await post(app,path(f.intent.id,'/signed'),{signedTransaction:Buffer.from(bytes).toString('base64')});expect(result.statusCode,result.body).toBe(400);expect(result.json().error.code).toBe('VEHICLE_SERVICE_SIGNED_WIRE');}
  for(const value of ['not-base64',Buffer.from(signed.signedTransaction).toString('base64')+'\n',Buffer.alloc(1233).toString('base64')])expect((await post(app,path(f.intent.id,'/signed'),{signedTransaction:value})).statusCode).toBe(400);
  expect((await post(app,path(f.intent.id,'/signed'),{signedTransaction:'x'.repeat(5000)})).statusCode).toBe(413);
  for(const suffix of ['/prepare','/recover'])expect((await post(app,path(f.intent.id,suffix),{proof:{finalityVerified:true}})).statusCode).toBe(400);
  expect((await get(app,path()+'?wallet='+f.actor)).statusCode).toBe(400);
  expect(await f.conn.sql`select intent_id from vehicle_service_signed_wires`).toHaveLength(0);expect(await f.conn.sql`select intent_id from vehicle_service_applications`).toHaveLength(0);
 });

 it('enforces every strict parent for new work before calling providers while exact original intent replay stays available',async()=>{
  const connect=vi.fn(()=>f.rpc),{createVehicleServiceWorkflow}=await import('../src/game/vehicleServiceWorkflow'),provider=createVehicleServiceWorkflow(f.conn.db,{connect,trust:f.trust,getBlockhash:async()=>f.blockhash}),app=await open(provider);
  for(const flag of flags){vi.stubEnv(flag,'false');const result=await post(app,'/vehicles/services',{...command(),idempotencyKey:randomUUID()});expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('VEHICLE_SERVICE_DISABLED');expect((await post(app,'/vehicles/services',command())).json().intent.intentId).toBe(f.intent.id);vi.stubEnv(flag,'true');}
  expect(connect).not.toHaveBeenCalled();expect(await f.conn.sql`select id from vehicle_service_intents`).toEqual([{id:f.intent.id}]);
 });

 it('executes the closed owner workflow through a real nonowner LOGIN without granting private tables',async()=>{
  const provider=await workflow(),role='service_http_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined,app:FastifyInstance|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{
   await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant select on sessions,players,alpha_access to ${role}`);const [database]=await f.conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
   for(const table of privateTables)await expect(runtime.sql.unsafe(`select * from public."${table}"`)).rejects.toMatchObject({code:'42501'});
   app=await open(provider,runtime.db);const prepared=await prepare(app),signed=await finalizeService(prepared);expect((await post(app,path(f.intent.id,'/signed'),{signedTransaction:Buffer.from(signed.signedTransaction).toString('base64')})).statusCode).toBe(200);expect((await recover(app)).application.tierAfter).toBe(2);
   expect((await get(app)).json().status).toBe('applied');for(const table of privateTables)expect(await runtime.sql`select has_table_privilege(current_user,${'public.'+table},'SELECT') allowed`).toEqual([{allowed:false}]);
  }finally{if(app){await app.close();apps.splice(apps.indexOf(app),1);}await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 });
});
