/** Original authenticated HTTP refusal -> browser ports -> strict IndexedDB.
 * Recovery absence alone never releases ambiguous or possibly signed intent. */
import {createRequire} from 'node:module';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
type Operation={request:{idempotencyKey:string;spot:number;realm:number};prepareAttempted:boolean;preparation:unknown;signingStarted:boolean;signed:unknown;submitAttempted:boolean;prepareRefusal?:{status:number;code:string};refusalConfirmedAbsent?:true;settlementObserved?:true;settlement?:unknown};
type Journal={revision:number;operation:Operation|null;lastArchivedKey?:string};
type Store={read():Promise<Journal>;archive(revision:number):Promise<Journal>;archived(key:string):Promise<Journal|null>;close():Promise<void>};
type Controller={begin(spot:number,realm:number):Promise<void>;open():Promise<void>;archiveRefusal():Promise<void>;snapshot():{error:string|null}};
const {RealmSaleJournalStore}=await vi.importActual<{RealmSaleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/realmSales/journal');
const {RealmSaleController}=await vi.importActual<{RealmSaleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/realmSales/controller');
const {createRealmSaleBrowserPorts,realmSaleIdentity}=await vi.importActual<{createRealmSaleBrowserPorts(input:object):object;realmSaleIdentity(wallet:string):object}>('../../web/src/lib/realmSales/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>{useApp.getState().setAuth(null);vi.unstubAllEnvs();vi.unstubAllGlobals();});
async function fixture(mode:'insufficient'|'unavailable'|'lost',run:(f:{client:(trusted?:boolean)=>{store:Store;controller:Controller};restart:(provider:boolean)=>Promise<void>;actions:(enabled:boolean)=>void;fund:()=>void;posts:Array<{key:string;status:number;code:string|undefined}>;gets:string[];signTransaction:ReturnType<typeof vi.fn>})=>Promise<void>){
 vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');const chain=await realmSaleQuoteFixture(),wallet=chain.buyer.toBase58(),balance=chain.controls.balance;
 if(mode==='insufficient')chain.controls.balance=1;
 const sources={connect:()=>chain.rpc,policy:{term:chain.termPolicy,access:chain.accessTrust,revision:'refusal-pair-r1'}},factory=new IDBFactory(),stores:Store[]=[];
 let app=await buildApp(TEST_CONFIG,conn.db,mode==='unavailable'?{}:{realmSalePreparationSources:sources}),activeStore!:Store,actionsEnabled=true,lost=mode==='lost';
 try{
  await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
  vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,work:(lock:{name:string})=>Promise<T>)=>work({name})}});useApp.getState().setAuth(wallet,true);
  const posts:Array<{key:string;status:number;code:string|undefined}>=[],gets:string[]=[];
  vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
   const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);if(method!=='GET'&&method!=='POST')throw Error('Unexpected paired method');
   const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
   const journal=method==='POST'?await activeStore.read():null;
   if(method==='POST'){expect(target.pathname).toBe('/seeker/realm-sales/prepare');expect(journal?.operation).toMatchObject({prepareAttempted:true,preparation:null,signingStarted:false,signed:null,submitAttempted:false});}
   else gets.push(target.pathname);
   const response=await app.inject({method,url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});
   expect(response.headers['cache-control']).toBe('private, no-store');
   if(method==='POST'){
    const key=journal!.operation!.request.idempotencyKey;expect(JSON.parse(String(init?.body)).idempotencyKey).toBe(key);posts.push({key,status:response.statusCode,code:response.json().error?.code});
    if(lost){lost=false;expect(response.statusCode).toBe(201);throw Error('lost original prepare reply');}
   }else expect(response.statusCode).toBe(200);
   return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  });
  const trust={genesisHash:chain.accessTrust.expectedGenesisHash,programId:chain.accessTrust.programId.toBase58(),developer:chain.accessTrust.developer.toBase58(),reviewedProgramDataSha256:chain.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:chain.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision};
  const signTransaction=vi.fn(async()=>{throw Error('No wallet signature belongs to this refusal fixture');});
  const client=(trusted=true)=>{activeStore=new RealmSaleJournalStore(realmSaleIdentity(wallet),factory);stores.push(activeStore);return {store:activeStore,controller:new RealmSaleController(activeStore,createRealmSaleBrowserPorts({identity:realmSaleIdentity(wallet),trust:trusted?trust:null,wallet:()=>({publicKey:chain.buyer,signTransaction,sendTransaction:null,signMessage:null,isEmbedded:false}),lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled})}))};};
  await run({client,restart:async(provider)=>{await app.close();app=await buildApp(TEST_CONFIG,conn.db,provider?{realmSalePreparationSources:sources}:{});},actions:enabled=>{actionsEnabled=enabled;},fund:()=>{chain.controls.balance=balance;},posts,gets,signTransaction});
 }finally{await Promise.all(stores.map(store=>store.close()));await app.close();}
}
describe('paired durable first-prepare refusal recovery',()=>{
 it('archives explicit insufficient SOL only after fresh paused providerless absence, then allows one new explicit key',async()=>fixture('insufficient',async f=>{
  let c=f.client();await c.controller.begin(0,0);const refused=await c.store.read(),key=refused.operation!.request.idempotencyKey;
  expect(f.posts).toEqual([{key,status:422,code:'INSUFFICIENT_SOL'}]);expect(refused.operation).toMatchObject({prepareAttempted:true,preparation:null,signingStarted:false,signed:null,submitAttempted:false,prepareRefusal:{status:422,code:'INSUFFICIENT_SOL'}});
  await expect(c.store.archive(refused.revision)).rejects.toThrow();expect(await c.store.archived(key)).toBeNull();
  f.actions(false);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await f.restart(false);c=f.client(false);await c.controller.open();
  expect(c.controller.snapshot().error).toBeNull();expect((await c.store.read()).operation?.prepareRefusal).toEqual({status:422,code:'INSUFFICIENT_SOL'});expect(await c.store.archived(key)).toBeNull();expect(f.posts).toHaveLength(1);
  const before=f.gets.length;await c.controller.archiveRefusal();expect(c.controller.snapshot().error).toBeNull();expect(f.gets.slice(before)).toEqual([`/seeker/realm-sales/prepare/by-key/${key}`,`/seeker/realm-sales/by-key/${key}`]);
  expect((await c.store.read()).operation).toBeNull();const archived=await c.store.archived(key);expect(archived?.operation).toMatchObject({...refused.operation,refusalConfirmedAbsent:true});
  c=f.client(false);await c.controller.open();expect((await c.store.read()).lastArchivedKey).toBe(key);expect(await c.store.archived(key)).toEqual(archived);expect(f.posts).toHaveLength(1);
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');f.actions(true);f.fund();await f.restart(true);c=f.client();await c.controller.begin(0,0);
  const next=(await c.store.read()).operation!;expect(next.request.idempotencyKey).not.toBe(key);expect(next.preparation).not.toBeNull();expect(f.posts).toEqual([{key,status:422,code:'INSUFFICIENT_SOL'},{key:next.request.idempotencyKey,status:201,code:undefined}]);
  await c.controller.open();await c.controller.begin(0,0);expect(f.posts).toHaveLength(2);expect(await c.store.archived(key)).toEqual(archived);expect(f.signTransaction).not.toHaveBeenCalled();
 }));
 it.each(['unavailable','lost'] as const)('keeps %s original replies held despite providerless recovery and explicit archival attempts',async mode=>fixture(mode,async f=>{
  let c=f.client();await c.controller.begin(0,0);const original=await c.store.read(),key=original.operation!.request.idempotencyKey;
  expect(original.operation?.prepareAttempted).toBe(true);expect(original.operation?.prepareRefusal).toBeUndefined();expect(f.posts).toEqual([{key,status:mode==='lost'?201:503,code:mode==='lost'?undefined:'REALM_SALE_UNAVAILABLE'}]);
  f.actions(false);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await f.restart(false);c=f.client(false);await c.controller.open();await c.controller.archiveRefusal();
  const held=await c.store.read();expect(held.operation?.request).toEqual(original.operation?.request);expect(held.operation?.prepareRefusal).toBeUndefined();expect(held.operation?.refusalConfirmedAbsent).toBeUndefined();expect(await c.store.archived(key)).toBeNull();
  if(mode==='lost')expect(held.operation?.preparation).not.toBeNull();else expect(held.operation?.preparation).toBeNull();
  f.actions(true);vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');c=f.client();await c.controller.begin(0,0);expect(f.posts).toHaveLength(1);expect(f.signTransaction).not.toHaveBeenCalled();
 }));
});
