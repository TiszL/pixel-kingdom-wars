/** Authenticated HTTP + real SQL originals + browser journal, independent legacy
 * signer and independent current account parser. Encoded finalized RPC fixtures
 * are explicit; actual Core execution is the separate root-owned acceptance. */
import {createRequire} from 'node:module';
import {PublicKey,type VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {afterEach,it,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import type {VehicleClient,VehicleWire} from '@shardkeep/shared/vehicleClientApi';
import {buildApp} from '../src/app';
import {createAdvancedFleetView} from '../src/game/advancedFleetView';
import {createVehicleClient,type VehicleClientDependencies} from '../src/game/vehicleClient';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions} from '../src/db/schema';
import {TEST_CONFIG} from './helpers';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {vehicleServiceConsentFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceBuilding} from './fixtures/vehicleService';
type Operation={command:{kind:string;key:string;request:object|null};original:VehicleClient|null;signingStarted:boolean;signed:VehicleWire|null};
type Store={read():Promise<{pending:Operation[];archive:Operation[]}>;close():Promise<void>};
type Controller={begin(kind:string,request:object):Promise<unknown>;select(key:string):void;recover(retry?:boolean):Promise<unknown>;prepare():Promise<unknown>;review():Promise<unknown>;sign():Promise<unknown>;upload():Promise<unknown>;deliver():Promise<unknown>;archive():Promise<unknown>;fleet(baseId:string):Promise<unknown>;getSnapshot():{fleet:{vehicles:object[]}|null;routes:{items:object[]}|null}};
const {VehicleJournalStore}=await vi.importActual<{VehicleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/vehicles/journal');
const {VehicleController}=await vi.importActual<{VehicleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/vehicles/controller');
const {createVehicleBrowserPorts,browserVehicleIdentity}=await vi.importActual<{createVehicleBrowserPorts(input:object):{key:()=>string};browserVehicleIdentity(wallet:string):object}>('../../web/src/lib/vehicles/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory,IDBKeyRange}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown;IDBKeyRange:unknown};
afterEach(()=>{useApp.getState().setAuth(null);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('recovers lost original/install upload/send responses, upgrades through actual service API, then reads actual fleet/routes and paused immutable history',async()=>{
 const f=await vehicleBurnDatabase();let app:FastifyInstance|undefined;const stores:Store[]=[];
 try{
  for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');
  const [session]=await f.conn.db.insert(sessions).values({wallet:f.actor,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning(),cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.actor,session!.id)};
  let rpc=f.rpc;const sent:Uint8Array[]=[];const current={getGenesisHash:()=>rpc.getGenesisHash(),getSlot:(...a:Parameters<typeof rpc.getSlot>)=>rpc.getSlot(...a),getMultipleAccountsInfoAndContext:(...a:Parameters<typeof rpc.getMultipleAccountsInfoAndContext>)=>rpc.getMultipleAccountsInfoAndContext(...a),getFeeForMessage:async()=>({context:{slot:await rpc.getSlot('finalized')},value:5000}),getBalanceAndContext:async()=>({context:{slot:await rpc.getSlot('finalized')},value:100000}),isBlockhashValid:async()=>({context:{slot:await rpc.getSlot('finalized')},value:true}),getBlockHeight:async()=>999,getSignatureStatuses:async()=>({context:{slot:await rpc.getSlot('finalized')},value:[null]}),sendRawTransaction:async(bytes:Uint8Array)=>{sent.push(Uint8Array.from(bytes));return bs58.encode(bytes.subarray(1,65));}};
  let deps:VehicleClientDependencies={installation:{connect:()=>f.rpc,trust:f.trust},current:{connect:()=>current,trust:f.trust}};
  async function application(){const old=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';try{const next=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.conn.db,{vehicleClientProvider:createVehicleClient(f.conn.db,deps),advancedFleetViewProvider:createAdvancedFleetView(f.conn.db)});await next.ready();return next;}finally{process.env['MULTI_BASE_ENABLED']=old;}}
  app=await application();vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});
  const factory=new IDBFactory(),lose=new Set<string>(),posts:string[]=[];let store!:Store,enabled=true,signatures=0;
  vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});if(method==='POST'){const saved=await store.read();expect(saved.pending.length).toBeGreaterThan(0);posts.push(target.pathname);if(target.pathname.endsWith('/installations')||target.pathname.endsWith('/services'))expect(saved.pending.some(o=>o.command.request&&JSON.stringify(o.command.request)===String(init?.body))).toBe(true);}const response=await app!.inject({method:method as 'GET'|'POST',url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});expect(response.statusCode,response.body).toBeLessThan(300);if(lose.delete(target.pathname))throw Error('paired lost response');return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});});
  const trust={version:1,revision:'paired-D182',core:f.trust,operationalPolicyVersion:1};
  function client(key:string,pins:object|null=trust){useApp.getState().setAuth(f.actor,true);store=new VehicleJournalStore(browserVehicleIdentity(f.actor),factory);stores.push(store);const wallet={publicKey:f.wallet.publicKey,signVersionedTransaction:async(tx:VersionedTransaction)=>{expect((await store.read()).pending.some(o=>o.command.key===key&&o.signingStarted)).toBe(true);signatures++;tx.sign([f.wallet]);return tx;},sendTransaction:vi.fn(()=>{throw Error('Wallet cannot send');}),signMessage:null,isEmbedded:false},ports=createVehicleBrowserPorts({identity:browserVehicleIdentity(f.actor),trust:pins,wallet:()=>wallet,connection:current,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:enabled})});const controller=new VehicleController(store,{...ports,key:()=>key});controller.select('installation:'+key);return controller;}
  // Existing helper owns the immutable original reservation. The actual POST is
  // its exact idempotent replay, explicitly not a new mint/provenance fixture.
  let c=client(f.reservation.idempotencyKey);lose.add('/vehicles/client/installations');await expect(c.begin('installation',{baseId:f.baseId,berthId:f.berthId,assetId:f.identity.assetId})).rejects.toThrow('lost response');expect((await store.read()).pending[0]!.original).toBeNull();c=client(f.reservation.idempotencyKey);await c.recover();await c.review();await c.sign();const signed=(await store.read()).pending[0]!.signed!;lose.add(`/vehicles/client/installations/${f.reservation.id}/signed`);await expect(c.upload()).rejects.toThrow('lost response');expect((await store.read()).pending[0]!.signed).toEqual(signed);
  // Read the exact original after the lost upload; no second wallet prompt.
  await c.recover(true);lose.add(`/vehicles/client/installations/${f.reservation.id}/deliver`);await expect(c.deliver()).rejects.toThrow('lost response');expect(sent).toHaveLength(1);expect(Buffer.from(sent[0]!).toString('hex')).toBe(signed.signedTransactionHex);f.finalizeBurn();await c.recover();expect((await store.read()).pending[0]!.original).toMatchObject({record:{status:'installed'}});await c.archive();expect(signatures).toBe(1);
  const service=await vehicleServiceConsentFixture(f);rpc=service.rpc;deps={...deps,service:{connect:()=>service.rpc,trust:f.trust,getBlockhash:async()=>service.blockhash}};await app.close();app=await application();c=client(service.intent.idempotencyKey);await c.begin('service',{installationId:f.reservation.id,assetId:service.asset.identity.assetId,operation:'upgrade'});await c.prepare();await c.review();await c.sign();await c.upload();await c.deliver();const preparation=await service.preparations.get(f.actor,service.intent.id);expect(preparation).not.toBeNull();service.finalizeService(preparation!);await c.recover();expect((await store.read()).pending[0]!.original).toMatchObject({record:{status:'applied',application:{tierAfter:2,completedTotal:'0',remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall}}});await c.archive();expect(signatures).toBe(2);expect(sent).toHaveLength(2);
  await vehicleServiceBuilding(f,'lodge');await c.fleet(f.baseId);expect(c.getSnapshot().fleet?.vehicles).toMatchObject([{installationId:f.reservation.id,tier:2,remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall}]);expect(c.getSnapshot().routes?.items).toMatchObject([{installationId:f.reservation.id}]);expect(c.getSnapshot().routes?.items.length).toBeGreaterThan(0);
  await app.close();deps={};app=await application();enabled=false;vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');f.setOnline(false);c=client(service.intent.idempotencyKey,null);expect((await store.read()).archive).toHaveLength(2);await expect(c.sign()).rejects.toThrow();expect(signatures).toBe(2);expect(posts.filter(p=>p.endsWith('/signed'))).toHaveLength(2);expect(posts.filter(p=>p.endsWith('/deliver'))).toHaveLength(2);
 }finally{await Promise.all(stores.map(s=>s.close()));await app?.close();await f.dispose();}
},120000);
