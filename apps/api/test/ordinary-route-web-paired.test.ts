/** Normal browser controller/transport + authenticated API/SQL. The private
 * fixture supplies installed capacity and term evidence; no wallet burn repeats. */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {afterEach,it,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {AdvancedExpeditionEnvelope} from '@shardkeep/shared/advancedExpeditionApi';
import type {VehicleRoutes,VehicleActivityPage} from '@shardkeep/shared/vehicleClientApi';
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import {buildApp} from '../src/app';
import {TEST_CONFIG} from './helpers';
import {ordinaryRoutePairFixture} from './fixtures/ordinaryRoutePair';
type Operation={command:{kind:string;key:string;request:unknown};original:AdvancedExpeditionEnvelope|null};
type Store={read():Promise<{pending:Operation[];archive:Operation[]}>;close():Promise<void>};
type Controller={load():Promise<unknown>;fleet(baseId:string):Promise<unknown>;open(item:VehicleActivityPage['items'][number]):Promise<unknown>;begin(kind:string,request:object):Promise<unknown>;select(key:string):void;recover(retry?:boolean):Promise<unknown>;collect(baseId:string):Promise<unknown>;archive():Promise<unknown>;getSnapshot():{activity:VehicleActivityPage|null;routes:VehicleRoutes|null;fleet:{vehicles:{installationId:string;remainingUses:number}[]}|null}};
const {VehicleJournalStore}=await vi.importActual<{VehicleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/vehicles/journal');
const {VehicleController}=await vi.importActual<{VehicleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/vehicles/controller');
const {createVehicleBrowserPorts,browserVehicleIdentity}=await vi.importActual<{createVehicleBrowserPorts(input:object):object;browserVehicleIdentity(wallet:string):object}>('../../web/src/lib/vehicles/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void;setSelectedBaseId(baseId:string|null,reset?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory,IDBKeyRange}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown;IDBKeyRange:unknown};
afterEach(()=>{useApp.getState().setAuth(null);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('keeps v1 history, opts into v2 HOME, recovers lost named dispatch and explicitly collects once through restart and pause',async()=>{
 const f=await ordinaryRoutePairFixture(),stores:Store[]=[];let app:FastifyInstance|undefined;
 try{
  async function application(){const before=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';try{const next=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.f.conn.db,f.providers());await next.ready();return next;}finally{process.env['MULTI_BASE_ENABLED']=before;}}
  app=await application();vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});
  const factory=new IDBFactory(),key=randomUUID(),lose=new Set<string>(),posts:string[]=[],paths:string[]=[];let store!:Store,enabled=true;
  vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);paths.push(target.pathname+target.search);const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});if(method==='POST'){posts.push(target.pathname);if(target.pathname==='/advanced-expeditions'){const saved=await store.read();expect(saved.pending.some(o=>JSON.stringify(o.command.request)===String(init?.body))).toBe(true);}}
   const response=await app!.inject({method:method as 'GET'|'POST',url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies:f.cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});expect(response.statusCode,response.body).toBeLessThan(300);if(lose.delete(target.pathname))throw Error('paired lost reply');return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  });
  function client(){useApp.getState().setAuth(f.config.wallet,true);useApp.getState().setSelectedBaseId(f.config.baseId,false);store=new VehicleJournalStore(browserVehicleIdentity(f.config.wallet),factory);stores.push(store);const ports=createVehicleBrowserPorts({identity:browserVehicleIdentity(f.config.wallet),trust:null,wallet:()=>({publicKey:null,signVersionedTransaction:null,signMessage:null,sendTransaction:null,isEmbedded:false}),connection:{},lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:enabled})});return new VehicleController(store,{...ports,key:()=>key});}
  let c=client();await c.load();const old=c.getSnapshot().activity!.items.find(i=>i.kind==='expedition'&&i.idempotencyKey===f.config.v1IdempotencyKey)!;expect(old).toBeDefined();await c.open(old);expect((await store.read()).pending[0]?.original).toMatchObject({receipt:{route:{routeId:'coastal_survey',policyVersion:1}},return:{completedTotal:'1'}});await c.archive();
  await c.fleet(f.config.baseId);expect(paths).toContain(`/vehicles/client/routes?baseId=${f.config.baseId}&policyVersion=2`);const preview=c.getSnapshot().routes!.items.find(i=>i.installationId===f.config.installationId)!.previews.find(p=>p.routeId===f.config.routeId)!;expect(preview).toMatchObject({policyVersion:2,accessRequirement:'home',realmId:'crownlands'});
  lose.add('/advanced-expeditions');await expect(c.begin('expedition',{baseId:f.config.baseId,installationId:f.config.installationId,routeId:preview.routeId,policyVersion:preview.policyVersion})).rejects.toThrow('paired lost reply');expect((await store.read()).pending[0]!.original).toBeNull();c=client();c.select('expedition:'+key);await c.recover(true);expect(posts.filter(p=>p==='/advanced-expeditions')).toHaveLength(1);expect((await store.read()).pending[0]!.original).toMatchObject({receipt:{route:preview},return:null});
  await f.finishExpedition(key);f.state({paused:true,providerless:true});enabled=false;await app.close();app=await application();lose.add('/advanced-expeditions/collect');await expect(c.collect(f.config.baseId)).rejects.toThrow('paired lost reply');c=client();c.select('expedition:'+key);await c.recover();expect((await store.read()).pending[0]!.original).toMatchObject({receipt:{route:preview},return:{completedTotal:'2'}});await c.archive();
  const saved=await store.read();expect(saved.pending).toEqual([]);expect(saved.archive.map(o=>o.original?.receipt?.route.policyVersion)).toEqual([1,2]);expect(posts).toEqual(['/advanced-expeditions','/advanced-expeditions/collect']);const fleet=await f.providers().advancedFleetViewProvider.read(f.config.wallet,f.config.baseId);expect(fleet.vehicles.find(v=>v.installationId===f.config.installationId)?.remainingUses).toBe(PHASE_E_VEHICLES.completedUsesPerInstall-2);
 }finally{await Promise.all(stores.map(s=>s.close()));await app?.close();await f.dispose();}
},120000);
