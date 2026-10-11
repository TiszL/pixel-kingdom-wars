/** Ordinary base reads collect accepted advanced earnings through a separate
 * owner capability. No elapsed-time use counter or caller receipt is trusted. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {Keypair} from '@solana/web3.js';
import {buildApp} from '../src/app';
import {createDb,type Db} from '../src/db/client';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createAdvancedExpeditionWorkflow} from '../src/game/advancedExpeditionWorkflow';
import {createAdvancedExpeditionGameplay,type AdvancedExpeditionGameplayProvider} from '../src/game/advancedExpeditionGameplay';
import {readAdvancedExpeditionReturn} from '../src/game/advancedExpeditionReturns';
import {registerOwnedDeed,requireFreshBaseAuthority,transferStableBase} from '../src/game/baseOwnership';
import {vehicleServiceInstalledFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceExpeditions} from './fixtures/vehicleService';
import {TEST_CONFIG} from './helpers';
import {provisionApiRuntimeLogin} from './fixtures/apiRuntimeLogin';

type Gameplay=AdvancedExpeditionGameplayProvider;
let f:Awaited<ReturnType<typeof vehicleServiceInstalledFixture>>,trips:Awaited<ReturnType<typeof vehicleServiceExpeditions>>,cookies:Record<string,string>;
const apps:FastifyInstance[]=[],flags=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'];
beforeEach(async()=>{for(const flag of flags)vi.stubEnv(flag,'true');vi.stubEnv('FREE_ONBOARDING','true');f=await vehicleServiceInstalledFixture();trips=await vehicleServiceExpeditions(f);cookies=await session(f.actor);},120_000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function session(wallet:string){const [s]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
const capability=(db:Db=f.conn.db)=>createAdvancedExpeditionGameplay(db);
async function open(provider?:Gameplay,db:Db=f.conn.db){const old=process.env.MULTI_BASE_ENABLED;vi.stubEnv('MULTI_BASE_ENABLED','false');try{const app=await buildApp(TEST_CONFIG,db,{...(provider?{advancedExpeditionGameplay:provider}:{}),advancedExpeditionWorkflowProvider:createAdvancedExpeditionWorkflow(f.conn.db)});apps.push(app);await app.ready();return app;}finally{vi.stubEnv('MULTI_BASE_ENABLED',old);}}
const read=(app:FastifyInstance,query='?baseId='+f.baseId,auth=cookies)=>app.inject({url:'/base'+query,cookies:auth});
async function due(){const trip=await trips.depart();vi.setSystemTime(trip.returnsAt);cookies=await session(f.actor);return trip;}
async function stock(resourceId:string,baseId=f.baseId){const [row]=await f.conn.sql`select available,reserved from resource_stocks where base_id=${baseId} and resource_id=${resourceId}`;return {available:BigInt(row?.available??0),reserved:BigInt(row?.reserved??0)};}
async function supplies(){return f.conn.sql`select to_jsonb(s)::text value from advanced_expedition_supplies s order by expedition_id,resource_id`;}
async function sourceSnapshot(){const result:Record<string,unknown>={};for(const table of ['advanced_expeditions','advanced_expedition_inflight','advanced_expedition_supplies','advanced_expedition_returns','advanced_expedition_entries','resource_stocks','resource_stock_operations','resource_stock_entries'])result[table]=await f.conn.sql.unsafe(`select to_jsonb(t)::text value from public.${table} t order by to_jsonb(t)::text`);return result;}
async function returned(trip:Awaited<ReturnType<typeof trips.depart>>,before:Awaited<ReturnType<typeof stock>>){const proof=await readAdvancedExpeditionReturn(f.conn.db,trip.id);expect(proof).not.toBeNull();expect(proof!.receipt.completedTotal).toBe(trip.completedBefore+1n);expect(proof!.entries).toHaveLength(3);expect(proof!.entries.reduce((n,e)=>n+e.delta,0n)).toBe(0n);expect(proof!.entries).toEqual(expect.arrayContaining([expect.objectContaining({bucket:'issued',delta:-trip.gross}),expect.objectContaining({bucket:'base_stock',delta:trip.net}),expect.objectContaining({bucket:'island_pool',delta:trip.tax})]));expect(await stock(trip.resourceId)).toEqual({...before,available:before.available+trip.net});expect(await f.conn.sql`select * from advanced_expedition_returns where expedition_id=${trip.id}`).toHaveLength(1);expect(await f.conn.sql`select * from advanced_expedition_inflight where expedition_id=${trip.id}`).toHaveLength(0);return proof!;}

describe('ordinary base reads collect accepted advanced expeditions',()=>{
 it('credits a due real expedition before returning base stock, without an explicit collect request',async()=>{
  const trip=await due(),before=await stock(trip.resourceId),provisions=await supplies(),app=await open(capability()),response=await read(app);
  expect(response.statusCode,response.body).toBe(200);await returned(trip,before);expect(response.json().rawStock).toEqual(expect.arrayContaining([expect.objectContaining({resourceId:trip.resourceId,available:(before.available+trip.net).toString()})]));expect(await supplies()).toEqual(provisions);
 });
 it('serializes repeated base reads and an explicit collection race into one credit and one completed use',async()=>{
  const trip=await due(),before=await stock(trip.resourceId),provisions=await supplies(),app=await open(capability());
  const responses=await Promise.all([read(app),read(app),app.inject({method:'POST',url:'/advanced-expeditions/collect',cookies,payload:{baseId:f.baseId}})]);
  for(const response of responses)expect(response.statusCode,response.body).toBe(200);await returned(trip,before);const saved=await sourceSnapshot();
  for(let i=0;i<2;i++)expect((await read(app)).statusCode).toBe(200);expect(await sourceSnapshot()).toEqual(saved);expect(await supplies()).toEqual(provisions);
 });
 it('leaves an unclosed trip away, then collects at its exact due boundary while new admissions are paused and providers are offline',async()=>{
  const trip=await trips.depart(),before=await stock(trip.resourceId),app=await open(capability());vi.setSystemTime(new Date(+trip.returnsAt-1));cookies=await session(f.actor);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','false');f.setOnline(false);
  const notDue=await sourceSnapshot(),early=await read(app);expect(early.statusCode,early.body).toBe(200);expect(await sourceSnapshot()).toEqual(notDue);
  const rpc=vi.spyOn(f.rpc,'getGenesisHash');rpc.mockClear();vi.setSystemTime(trip.returnsAt);const response=await read(app);expect(response.statusCode,response.body).toBe(200);await returned(trip,before);expect(rpc).not.toHaveBeenCalled();
 });
 it('keeps canonical optional-query behavior and resolves the single existing base without accepting malformed selection',async()=>{
  const trip=await due(),before=await stock(trip.resourceId),app=await open(capability()),saved=await sourceSnapshot();
  for(const query of ['?baseId=invalid','?baseId='+f.baseId+'&baseId='+f.baseId])expect((await read(app,query)).statusCode).toBe(400);
  const missing=await read(app,'?baseId='+randomUUID());expect(missing.statusCode,missing.body).toBe(404);expect(await sourceSnapshot()).toEqual(saved);
  // Existing /base strips unrelated query keys. The appended hook must agree.
  const response=await read(app,'?presentation=unchanged');expect(response.statusCode,response.body).toBe(200);expect(response.json().baseId).toBe(f.baseId);await returned(trip,before);
 });
 it('preserves the multi-base selection error and only collects the explicitly selected existing base',async()=>{
  const trip=await due(),before=await stock(trip.resourceId),second=randomUUID();await f.conn.sql`insert into bases(id,owner_wallet) values(${second},${f.actor})`;await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.actor},2,${second})`;
  const app=await open(capability()),saved=await sourceSnapshot(),ambiguous=await read(app,'');expect(ambiguous.statusCode,ambiguous.body).toBe(426);expect(ambiguous.json().error.code).toBe('BASE_CLIENT_UPGRADE_REQUIRED');expect(await sourceSnapshot()).toEqual(saved);
  const other=await read(app,'?baseId='+second);expect(other.statusCode,other.body).toBe(200);expect(other.json().baseId).toBe(second);expect(await sourceSnapshot()).toEqual(saved);
  const selected=await read(app);expect(selected.statusCode,selected.body).toBe(200);expect(selected.json().baseId).toBe(f.baseId);await returned(trip,before);
 });
 it('leaves first-base creation to the ordinary handler and keeps repeated first reads idempotent',async()=>{
  const wallet=Keypair.generate().publicKey.toBase58();await f.conn.db.insert(players).values({wallet});const auth=await session(wallet),owner=capability(),observed:string[]=[];
  const provider:Gameplay={collectForBaseRead:async(w,id)=>{expect(await f.conn.sql`select id from bases where owner_wallet=${wallet}`).toHaveLength(observed.length?1:0);const selected=await owner.collectForBaseRead(w,id);observed.push(selected??'none');return selected;}};
  const app=await open(provider),first=await read(app,'',auth);expect(first.statusCode,first.body).toBe(200);const baseId=first.json().baseId;expect(first.json().buildings).toEqual(expect.arrayContaining([expect.objectContaining({type:'keep'})]));expect(observed).toEqual(['none']);
  const again=await read(app,'',auth);expect(again.statusCode,again.body).toBe(200);expect(again.json().baseId).toBe(baseId);expect(observed).toEqual(['none',baseId]);expect(await f.conn.sql`select id from bases where owner_wallet=${wallet}`).toHaveLength(1);expect(await f.conn.sql`select id from ledger_transactions where idempotency_key=${'starter:base:'+baseId}`).toHaveLength(1);expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(0);
 });
 it('does not collect without a capability, before authentication, on HEAD, or in the legacy rollout path',async()=>{
  await due();const owner=capability(),call=vi.fn(owner.collectForBaseRead),app=await open({collectForBaseRead:call}),without=await open(),saved=await sourceSnapshot();
  expect((await app.inject({url:'/base?baseId='+f.baseId})).statusCode).toBe(401);const head=await app.inject({method:'HEAD',url:'/base?baseId='+f.baseId,cookies});expect(head.statusCode,head.body).toBe(200);expect(head.body).toBe('');
  const dark=await read(without);expect(dark.statusCode,dark.body).toBe(200);vi.stubEnv('MULTI_BASE_ENABLED','false');const legacy=await read(app);expect(legacy.statusCode,legacy.body).toBe(200);expect(call).not.toHaveBeenCalled();expect(await sourceSnapshot()).toEqual(saved);
 });
 it('runs only after the existing land gate accepts the caller',async()=>{
  await due();vi.stubEnv('FREE_ONBOARDING','false');const owner=capability(),call=vi.fn(owner.collectForBaseRead),app=await open({collectForBaseRead:call}),saved=await sourceSnapshot(),response=await read(app);
  expect(response.statusCode,response.body).toBe(402);expect(response.json().error.code).toBe('LAND_NOT_OWNED');expect(call).not.toHaveBeenCalled();expect(await sourceSnapshot()).toEqual(saved);
 });
 it('credits the actual buyer after a stable transfer while the seller cannot collect or read that base',async()=>{
  const trip=await trips.depart(),mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);await f.conn.db.insert(players).values({wallet:buyer});await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});expect(Date.now()).toBeLessThan(+trip.returnsAt);expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(0);
  vi.setSystemTime(trip.returnsAt);await requireFreshBaseAuthority(f.conn.db,buyer,f.baseId,async(asset,minSlot)=>{expect(asset).toBe(mint);expect(minSlot).toBe(101);return {owner:buyer,collection:'test',frozen:false,delegate:null,slot:102};},'test');cookies=await session(f.actor);const buyerAuth=await session(buyer),before=await stock(trip.resourceId),app=await open(capability()),saved=await sourceSnapshot();
  const seller=await read(app);expect(seller.statusCode,seller.body).toBe(404);expect(await sourceSnapshot()).toEqual(saved);const response=await read(app,'?baseId='+f.baseId,buyerAuth);expect(response.statusCode,response.body).toBe(200);const proof=await returned(trip,before);expect(proof.receipt.custodyWallet).toBe(buyer);expect(proof.expedition.actorWallet).toBe(f.actor);
 });
 it('collects through the separate owner capability with no advanced or vehicle table grants on the ordinary LOGIN',async()=>{
  const trip=await due(),before=await stock(trip.resourceId);let runtime:ReturnType<typeof createDb>|undefined,app:FastifyInstance|undefined;
  // 2026-10-10: the actual provisioned API runtime LOGIN (fixtures/apiRuntimeLogin.ts), not hand
  // grants on every table: the private-source seals read a direct session_user grant
  // as tampering, and the base read needs the provisioner's function EXECUTE grants.
  const login=await provisionApiRuntimeLogin(f.conn.sql,'advanced_gameplay'),role=login.login;
  try{runtime=createDb(login.url,{max:4});expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);
   for(const table of ['advanced_expeditions','advanced_expedition_returns','advanced_vehicle_installations','vehicle_service_intents'])await expect(runtime.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({code:'42501'});
   app=await open(capability(),runtime.db);const response=await read(app);expect(response.statusCode,response.body).toBe(200);await returned(trip,before);expect(response.json().rawStock).toEqual(expect.arrayContaining([expect.objectContaining({resourceId:trip.resourceId,available:(before.available+trip.net).toString()})]));
   expect(await runtime.sql`select has_table_privilege(current_user,'advanced_expedition_returns','SELECT') reads,has_table_privilege(current_user,'advanced_expedition_returns','INSERT') writes`).toEqual([{reads:false,writes:false}]);
  }finally{if(app){await app.close();apps.splice(apps.indexOf(app),1);}await runtime?.sql.end();await login.close();}
 },120_000);
});
