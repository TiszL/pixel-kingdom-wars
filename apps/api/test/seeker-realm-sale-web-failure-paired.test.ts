/** Actual HTTP/owner history, browser transport/crypto and cold IndexedDB.
 * The only transaction finality source is the injected encoded chain fixture. */
import {createRequire} from 'node:module';
import {Keypair,Message,type Transaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {afterAll,afterEach,beforeAll,describe,it,expect,vi} from 'vitest';
import type {RealmSalePreparationView,RealmSalePrepareRequest} from '@shardkeep/shared/realmSalesApi';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createRealmSaleFailure,getRealmSaleFailure} from '../src/seeker/realmSaleFailure';
import {getRealmSaleSigned} from '../src/seeker/realmSaleSignedStore';
import {getRealmSaleSettlement} from '../src/seeker/realmSaleSettlement';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {TEST_CONFIG} from './helpers';
// Keep browser-only IDB types behind this fixture boundary; API tsconfig has no DOM library.
type LocalRequest<T>={result:T;error:unknown;onsuccess:(()=>void)|null;onerror:(()=>void)|null};
type LocalCursor={key:string;value:unknown;continue():void};
type LocalTransaction={objectStore(name:string):{openCursor():LocalRequest<LocalCursor|null>;put(value:unknown,key:string):unknown};oncomplete:(()=>void)|null;onerror:(()=>void)|null;error:unknown};
type LocalDatabase={createObjectStore(name:string):unknown;transaction(name:string,mode?:'readwrite'):LocalTransaction;close():void};
type LocalFactory={open(name:string,version:number):LocalRequest<LocalDatabase>&{onupgradeneeded:(()=>void)|null}};
type Signed={wire:string;signature:string};
type Operation={request:RealmSalePrepareRequest;prepareAttempted:boolean;preparation:RealmSalePreparationView|null;signingStarted:boolean;signed:Signed|null;submitAttempted:boolean;failureObserved?:true;failure?:{value:unknown};settlementObserved?:true};
type Journal={revision:number;operation:Operation|null;lastArchivedKey?:string};
type Store={read():Promise<Journal>;compareAndSet(revision:number,update:(row:Journal)=>Journal):Promise<Journal>;archived(key:string):Promise<Journal|null>;close():Promise<void>};
type Controller={begin(spot:number,realm:number):Promise<void>;open():Promise<void>;review():Promise<void>;sign():Promise<void>;submit():Promise<void>;archiveFailed():Promise<void>;snapshot():{error:string|null;settlementHeld:boolean}};
const {RealmSaleJournalStore}=await vi.importActual<{RealmSaleJournalStore:new(identity:object,factory:LocalFactory,name:string,trust:object)=>Store}>('../../web/src/lib/realmSales/journal');
const {RealmSaleController}=await vi.importActual<{RealmSaleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/realmSales/controller');
const {createRealmSaleBrowserPorts,realmSaleIdentity}=await vi.importActual<{createRealmSaleBrowserPorts(input:object):object;realmSaleIdentity(wallet:string):object}>('../../web/src/lib/realmSales/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory:FakeIDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>LocalFactory};
const conn=resourceClaimsDatabase();beforeAll(()=>conn.setup());afterAll(()=>conn.close());afterEach(()=>{useApp.getState().setAuth(null);vi.unstubAllEnvs();vi.unstubAllGlobals();});
async function copyDatabase(backing:LocalFactory,name:string):Promise<LocalFactory>{
 const open=(factory:LocalFactory)=>new Promise<LocalDatabase>((resolve,reject)=>{const q=factory.open(name,1);q.onupgradeneeded=()=>q.result.createObjectStore('commands');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 const old=await open(backing),rows=await new Promise<[string,unknown][]>((resolve,reject)=>{const tx=old.transaction('commands'),q=tx.objectStore('commands').openCursor(),values:[string,unknown][]=[];q.onsuccess=()=>{const c=q.result;if(c){values.push([c.key,c.value]);c.continue();}};tx.oncomplete=()=>resolve(values);tx.onerror=()=>reject(tx.error);});old.close();
 const next=new FakeIDBFactory(),db=await open(next);await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite');for(const [key,value]of rows)tx.objectStore('commands').put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();return next;
}
async function fixture(){
 vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');const f=await realmSaleQuoteFixture(),wallet=f.buyer.toBase58();
 const sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'failure-web-pair-r1'}};
 let app=await buildApp(TEST_CONFIG,conn.db,{realmSalePreparationSources:sources}),factory=new FakeIDBFactory(),active!:Store,actionsEnabled=true,lostSubmit=true;
 const stores:Store[]=[],requests:{method:string;path:string}[]=[],database='realm-failure-web-pair';
 await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
 vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});useApp.getState().setAuth(wallet,true);
 const trust={genesisHash:f.accessTrust.expectedGenesisHash,programId:f.accessTrust.programId.toBase58(),developer:f.accessTrust.developer.toBase58(),reviewedProgramDataSha256:f.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision,upgradeAuthority:f.upgradeAuthority.toBase58()};
 const signTransaction=vi.fn(async(tx:Transaction)=>{expect((await active.read()).operation?.signingStarted).toBe(true);tx.partialSign(Keypair.fromSeed(Buffer.alloc(32,1)));return tx;});
 let corruptFailure=false,contradictSaved=false;
 const fetch=vi.fn<typeof globalThis.fetch>(async(input,init)=>{
  const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);requests.push({method,path:target.pathname});
  const r=await app.inject({method:method as 'GET'|'POST',url:target.pathname+target.search,...(init?.credentials==='include'?{cookies}:{}),...(method==='POST'?{payload:JSON.parse(String(init?.body))}:{})});
  if(target.pathname.endsWith('/submit')&&lostSubmit){expect(r.statusCode).toBe(202);lostSubmit=false;throw Error('lost submit reply');}
  let raw:unknown=r.json();if(corruptFailure&&target.pathname.includes('/failures/by-key/'))raw={...raw as object,failure:{malformed:'positive'}};
  if(contradictSaved&&target.pathname.startsWith('/seeker/realm-sales/by-key/'))raw={...raw as object,settlement:{malformed:'positive'}};
  return new Response(JSON.stringify(raw),{status:r.statusCode,headers:{'content-type':'application/json'}});
 });vi.stubGlobal('fetch',fetch);
 const client=()=>{active=new RealmSaleJournalStore(realmSaleIdentity(wallet),factory,database,trust);stores.push(active);return {store:active,controller:new RealmSaleController(active,createRealmSaleBrowserPorts({identity:realmSaleIdentity(wallet),trust,wallet:()=>({publicKey:f.buyer,signTransaction,sendTransaction:null,signMessage:null,isEmbedded:false}),lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled}),clock:()=>0}))};};
 const fail=async(op:Operation)=>{
  const p=op.preparation!,wire=(await getRealmSaleSigned(conn.db,{wallet,idempotencyKey:op.request.idempotencyKey}))!.wire!,message=Message.from(Buffer.from(p.quote.messageHex,'hex')),fee=Number(p.quote.feeLamports)+1,preBalances=message.accountKeys.map(()=>100_000_000);
  const transaction:VersionedTransactionResponse={slot:f.controls.slot+1,blockTime:null,version:'legacy',transaction:{message,signatures:[wire.signature]},meta:{err:{InstructionError:[message.instructions.length-1,{Custom:9}]},fee,preBalances,postBalances:preBalances.map((n,i)=>n-(i===0?fee:0)),preTokenBalances:[],postTokenBalances:[]}};
  f.controls.slot+=2;await f.repack();return createRealmSaleFailure(conn.db,{connect:()=>({...f.rpc,getTransaction:async()=>transaction}),trust:f.accessTrust})({wallet,idempotencyKey:op.request.idempotencyKey});
 };
 return {f,wallet,requests,signTransaction,client,fail,corrupt:(v:boolean)=>{corruptFailure=v;},contradict:()=>{contradictSaved=true;},
  cold:async()=>{factory=await copyDatabase(factory,database);return client();},pause:async()=>{actionsEnabled=false;vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,conn.db);},
  close:async()=>{await Promise.all(stores.map(s=>s.close()));await app.close();}};
}
async function signedOriginal(x:Awaited<ReturnType<typeof fixture>>){
 const c=x.client();await c.controller.begin(0,0);expect(c.controller.snapshot().error).toBeNull();x.f.controls.now+=10n;x.f.controls.slot++;
 await c.controller.review();expect(c.controller.snapshot().error).toBeNull();await c.controller.sign();expect(c.controller.snapshot().error).toBeNull();await c.controller.submit();expect(c.controller.snapshot().error).toMatch(/lost submit reply/);
 const original=(await c.store.read()).operation!;expect(original.submitAttempted).toBe(true);expect(original.signed).not.toBeNull();expect(x.signTransaction).toHaveBeenCalledOnce();return {c,original};
}
describe('paired browser finalized failed realm purchase recovery',()=>{
 it('keeps one prepare/sign/submit through loss, cold paused GET recovery and fresh archival without reusing the key',async()=>{
  const x=await fixture();try{
   const {original}=await signedOriginal(x),failed=await x.fail(original),posts=x.requests.filter(r=>r.method==='POST');expect(posts.map(r=>r.path)).toEqual(['/seeker/realm-sales/prepare','/seeker/realm-sales/submit']);
   expect(failed.receipt).toMatchObject({feeLamports:(BigInt(original.preparation!.quote.feeLamports)+1n).toString(),actualRentLamports:'0',buyerNetPaymentLamports:'0',quotaConsumed:false,accessChanged:false});expect(x.f.models.quota.sales).toBe(0);expect(x.f.models.access.expires_at).toBe(0n);
   await x.pause();const before=x.requests.length,c=await x.cold();await c.controller.open();expect(c.controller.snapshot().error).toBeNull();const recovered=await c.store.read();expect(recovered.operation?.failure?.value).toEqual(failed);expect(recovered.operation?.signed).toEqual(original.signed);
   expect(x.requests.slice(before).every(r=>r.method==='GET')).toBe(true);const failureGets=x.requests.filter(r=>r.path.includes('/failures/by-key/')).length;
   await c.controller.archiveFailed();expect(c.controller.snapshot().error).toBeNull();const archived=await c.store.archived(original.request.idempotencyKey);expect(archived).toEqual(recovered);expect((await c.store.read()).operation).toBeNull();expect(x.requests.filter(r=>r.path.includes('/failures/by-key/'))).toHaveLength(failureGets+1);
   const next=await x.cold(),empty=await next.store.read();expect(await next.store.archived(original.request.idempotencyKey)).toEqual(recovered);
   await expect(next.store.compareAndSet(empty.revision,j=>({...j,operation:{request:original.request,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}))).rejects.toThrow();
   expect(x.requests.filter(r=>r.method==='POST')).toEqual(posts);expect(x.signTransaction).toHaveBeenCalledOnce();expect(await getRealmSaleSettlement(conn.db,{wallet:x.wallet,idempotencyKey:original.request.idempotencyKey})).toBeNull();expect(await getRealmSaleFailure(conn.db,{wallet:x.wallet,idempotencyKey:original.request.idempotencyKey})).toEqual(failed);
  }finally{await x.close();}
 });
 it('preserves malformed positive and contradictory saved observations around actual owner failure without granting another action',async()=>{
  const x=await fixture();try{
   const {original}=await signedOriginal(x),failed=await x.fail(original);await x.pause();x.corrupt(true);let c=await x.cold();await c.controller.open();expect(c.controller.snapshot().error).not.toBeNull();expect((await c.store.read()).operation).toMatchObject({failureObserved:true,signed:original.signed});expect((await c.store.read()).operation?.failure).toBeUndefined();
   x.corrupt(false);c=await x.cold();await c.controller.open();expect(c.controller.snapshot().error).toBeNull();expect((await c.store.read()).operation?.failure?.value).toEqual(failed);
   x.contradict();await c.controller.archiveFailed();expect(c.controller.snapshot().error).not.toBeNull();expect((await c.store.read()).operation).toMatchObject({settlementObserved:true,failureObserved:true,failure:{value:failed},signed:original.signed});expect(await c.store.archived(original.request.idempotencyKey)).toBeNull();
   c=await x.cold();await c.controller.open();expect(c.controller.snapshot().settlementHeld).toBe(true);expect(x.requests.filter(r=>r.method==='POST')).toHaveLength(2);expect(x.signTransaction).toHaveBeenCalledOnce();
  }finally{await x.close();}
 });
});
