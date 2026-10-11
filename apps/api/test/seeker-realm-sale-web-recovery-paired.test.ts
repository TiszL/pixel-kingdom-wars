/** Real authenticated HTTP -> browser crypto -> strict IndexedDB -> restart.
 * Finality is supplied only by the server's fixture verifier, never the browser. */
import {createRequire} from 'node:module';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createRealmSaleSettlement} from '../src/seeker/realmSaleSettlement';
import {retainRealmSaleSettlementFixture} from './fixtures/realmSaleSettlement';
import {connectTestDb,TEST_CONFIG} from './helpers';
type Operation={request:{idempotencyKey:string;spot:number;realm:number};prepareAttempted:boolean;preparation:unknown;signingStarted:boolean;signed:unknown;submitAttempted:boolean;settlementObserved?:true;settlement?:{value:unknown}};
type Journal={revision:number;operation:Operation|null;lastArchivedKey?:string};
type Store={read():Promise<Journal>;compareAndSet(revision:number,update:(row:Journal)=>Journal):Promise<Journal>;archived(key:string):Promise<Journal|null>;close():Promise<void>};
type Controller={open():Promise<void>;archive():Promise<void>;snapshot():{error:string|null;settlementHeld:boolean}};
const {RealmSaleJournalStore}=await vi.importActual<{RealmSaleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/realmSales/journal');
const {RealmSaleController}=await vi.importActual<{RealmSaleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/realmSales/controller');
const {createRealmSaleBrowserPorts,realmSaleIdentity}=await vi.importActual<{createRealmSaleBrowserPorts(input:object):object;realmSaleIdentity(wallet:string):object}>('../../web/src/lib/realmSales/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>{useApp.getState().setAuth(null);vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('paired browser settled purchase recovery and archival',()=>{
 it('recovers a lost reply while paused, then reopens and archives offline without losing evidence or invoking a wallet',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');const f=await retainRealmSaleSettlementFixture(conn.db);
  const finalized=await createRealmSaleSettlement(conn.db,{connect:()=>f.chain.rpc,trust:f.chain.trust})(f.key);
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const app=await buildApp(TEST_CONFIG,conn.db),factory=new IDBFactory(),stores:Store[]=[];
  try{
   await conn.db.insert(players).values({wallet:f.key.wallet}).onConflictDoNothing();const [session]=await conn.db.insert(sessions).values({wallet:f.key.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
   const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.key.wallet,session!.id)};
   vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});useApp.getState().setAuth(f.key.wallet,true);
   const wallet=vi.fn(()=>{throw Error('wallet unavailable');});let lost=true;
   const fetch=vi.fn(async(input:string|URL,init?:RequestInit)=>{
    const target=new URL(String(input));expect(target.origin).toBe(new URL(API_URL).origin);expect(init?.method??'GET').toBe('GET');
    const response=await app.inject({url:target.pathname+target.search,...(init?.credentials==='include'?{cookies}:{})});expect(response.statusCode).toBe(200);
    if(target.pathname.includes('/by-key/')&&!target.pathname.includes('/prepare/')&&lost){lost=false;throw Error('lost settlement reply');}
    return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
   });vi.stubGlobal('fetch',fetch);
   const client=()=>{const store=new RealmSaleJournalStore(realmSaleIdentity(f.key.wallet),factory);stores.push(store);const controller=new RealmSaleController(store,createRealmSaleBrowserPorts({identity:realmSaleIdentity(f.key.wallet),trust:null,wallet,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:false})}));return {store,controller};};
   let c=client(),j=await c.store.read();j=await c.store.compareAndSet(j.revision,row=>({...row,operation:{request:{idempotencyKey:f.key.idempotencyKey,spot:f.artifact.spot,realm:f.artifact.realm},prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));
   // Original intent/signing markers existed before the uncertain delivery.
   for(const patch of [{prepareAttempted:true},{preparation:f.artifact},{signingStarted:true}])j=await c.store.compareAndSet(j.revision,row=>({...row,operation:{...row.operation!,...patch}}));
   await c.controller.open();expect(c.controller.snapshot().error).toMatch(/lost settlement/);expect((await c.store.read()).operation?.settlement).toBeUndefined();
   c=client();await c.controller.open();expect(c.controller.snapshot().error).toBeNull();const settled=await c.store.read();expect(settled.operation?.settlement?.value).toEqual(finalized);expect(settled.operation?.settlementObserved).toBe(true);
   const requests=fetch.mock.calls.length;fetch.mockImplementation(async()=>{throw Error('offline');});c=client();await c.controller.open();expect(c.controller.snapshot().error).toBeNull();expect(fetch).toHaveBeenCalledTimes(requests);
   await c.controller.archive();expect(c.controller.snapshot().error).toBeNull();expect((await c.store.read()).operation).toBeNull();expect(await c.store.archived(f.key.idempotencyKey)).toEqual(settled);
   c=client();await c.controller.open();expect((await c.store.read()).lastArchivedKey).toBe(f.key.idempotencyKey);expect(await c.store.archived(f.key.idempotencyKey)).toEqual(settled);expect(wallet).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(requests);
  }finally{await Promise.all(stores.map(s=>s.close()));await app.close();}
 });
});
