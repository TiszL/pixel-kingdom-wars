/** Actual quote reader/API + browser ports/controller/IDB. Only the quota case
 * starts with an available offer: winner and realm eligibility are immutable
 * within the fixture term. This is injected finalized evidence, not live proof. */
import {createRequire} from 'node:module';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';

type Refusal={status:number;code:string};
type Operation={request:{idempotencyKey:string;spot:number;realm:number};prepareAttempted:boolean;preparation:unknown;signingStarted:boolean;signed:unknown;submitAttempted:boolean;prepareRefusal?:Refusal;refusalConfirmedAbsent?:true};
type Journal={revision:number;operation:Operation|null;lastArchivedKey?:string};
type Store={read():Promise<Journal>;archive(revision:number):Promise<Journal>;archived(key:string):Promise<Journal|null>;close():Promise<void>};
type Controller={begin(spot:number,realm:number):Promise<void>;open():Promise<void>;archiveRefusal():Promise<void>;snapshot():{error:string|null}};
const {RealmSaleJournalStore}=await vi.importActual<{RealmSaleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/realmSales/journal');
const {RealmSaleController}=await vi.importActual<{RealmSaleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/realmSales/controller');
const {createRealmSaleBrowserPorts,realmSaleIdentity}=await vi.importActual<{createRealmSaleBrowserPorts(input:object):object;realmSaleIdentity(wallet:string):object}>('../../web/src/lib/realmSales/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=connectTestDb();
afterAll(()=>conn.sql.end());
afterEach(()=>{useApp.getState().setAuth(null);vi.unstubAllEnvs();vi.unstubAllGlobals();});

type Selection='quota'|'unsold'|'realm';
const codes={quota:'REALM_SALE_NO_QUOTA',unsold:'REALM_SALE_UNSOLD',realm:'REALM_SALE_REALM_UNAVAILABLE'} as const;
async function fixture(selection:Selection,run:(f:{
 client:()=>{store:Store;controller:Controller};pause:()=>Promise<void>;begin:()=>Promise<void>;
 responses:(mode:'normal'|'missing'|'malformed')=>void;posts:Refusal[];gets:string[];
 signTransaction:ReturnType<typeof vi.fn>;spot:number;realm:number;
})=>Promise<void>){
 vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');
 const chain=await realmSaleQuoteFixture(),wallet=chain.buyer.toBase58();
 let spot=0,realm=0;
 if(selection==='unsold')spot=PHASE_E_POLICY.seekerIsland.totalSpots-1;
 if(selection==='realm'){
  // Add a genuine fixture winner for a canonical regular spot. Its immutable
  // registry mask does not include the selected realm; no fake available offer.
  const auction=chain.models.auctions.find(row=>row.fields.spot.realm_mask!==chain.models.auctions[0]!.fields.spot.realm_mask)!;
  spot=auction.fields.spot.id;
  realm=Array.from({length:PHASE_E_POLICY.seekerIsland.realmCount},(_,i)=>i).find(i=>(auction.fields.spot.realm_mask&(1<<i))===0)!;
  auction.fields.high_bid=chain.models.config.opening_bid;
  auction.fields.high_bidder=chain.seller;auction.fields.result_owner=chain.seller;
  chain.models.term.winner_count++;await chain.repack();
 }
 const sources={connect:()=>chain.rpc,policy:{term:chain.termPolicy,access:chain.accessTrust,revision:'stale-offer-pair-r1'}};
 const factory=new IDBFactory(),stores:Store[]=[],posts:Refusal[]=[],gets:string[]=[];
 let app=await buildApp(TEST_CONFIG,conn.db,{realmSalePreparationSources:sources}),activeStore!:Store,activeController!:Controller,actionsEnabled=true,responseMode:'normal'|'missing'|'malformed'='normal';
 try{
  await conn.db.insert(players).values({wallet}).onConflictDoNothing();
  const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
  if(selection==='quota'){
   const offer=await app.inject({url:`/seeker/realm-sales/offer?spot=${spot}&realm=${realm}`,cookies});
   expect(offer.statusCode).toBe(200);expect(offer.json()).toMatchObject({wallet,status:'available',authorization:'none'});
   chain.models.quota.sales=PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax;await chain.repack();
  }
  vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});
  vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,work:(lock:{name:string})=>Promise<T>)=>work({name})}});
  useApp.getState().setAuth(wallet,true);
  vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
   const target=new URL(String(input)),method=init?.method??'GET';
   expect(target.origin).toBe(new URL(API_URL).origin);expect(init?.credentials).toBe('include');
   if(method!=='GET'&&method!=='POST')throw Error('Unexpected paired method');
   const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
   const journal=await activeStore.read(),key=journal.operation!.request.idempotencyKey;
   if(method==='POST'){
    expect(target.pathname).toBe('/seeker/realm-sales/prepare');
    expect(journal.operation).toMatchObject({prepareAttempted:true,preparation:null,signingStarted:false,signed:null,submitAttempted:false});
    expect(JSON.parse(String(init?.body))).toEqual({idempotencyKey:key,spot,realm});
   }else{
    expect([`/seeker/realm-sales/prepare/by-key/${key}`,`/seeker/realm-sales/by-key/${key}`]).toContain(target.pathname);
    gets.push(target.pathname);
   }
   const response=await app.inject({method,url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},cookies,...(init?.body==null?{}:{payload:String(init.body)})});
   expect(response.headers['cache-control']).toBe('private, no-store');
   if(method==='POST'){
    posts.push({status:response.statusCode,code:response.json().error?.code});
    // The first refusal occurs before any DB preparation, wire or payment row.
    expect(await conn.sql`select count(*)::int as count from seeker_realm_sale_preparations where idempotency_key=${key}`).toEqual([{count:0}]);
    expect(await conn.sql`select count(*)::int as count from seeker_realm_sale_signed_wires where idempotency_key=${key}`).toEqual([{count:0}]);
    expect(await conn.sql`select count(*)::int as count from seeker_realm_sale_receipts where idempotency_key=${key}`).toEqual([{count:0}]);
   }else{
    expect(response.statusCode).toBe(200);
    if(target.pathname===`/seeker/realm-sales/by-key/${key}`){
     if(responseMode==='missing')return new Response('',{status:404});
     if(responseMode==='malformed')return new Response(JSON.stringify({wallet,idempotencyKey:key,preparation:null}),{status:200,headers:{'content-type':'application/json'}});
    }
   }
   return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  });
  const trust={genesisHash:chain.accessTrust.expectedGenesisHash,programId:chain.accessTrust.programId.toBase58(),developer:chain.accessTrust.developer.toBase58(),reviewedProgramDataSha256:chain.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:chain.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision};
  const signTransaction=vi.fn(async()=>{throw Error('Refused selection cannot prompt the wallet');});
  const client=()=>{
   activeStore=new RealmSaleJournalStore(realmSaleIdentity(wallet),factory);stores.push(activeStore);
   activeController=new RealmSaleController(activeStore,createRealmSaleBrowserPorts({identity:realmSaleIdentity(wallet),trust:actionsEnabled?trust:null,wallet:()=>actionsEnabled?{publicKey:chain.buyer,signTransaction,sendTransaction:null,signMessage:null,isEmbedded:false}:null,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled})}));
   return {store:activeStore,controller:activeController};
  };
  await run({client,begin:()=>activeController.begin(spot,realm),pause:async()=>{actionsEnabled=false;vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,conn.db,{});},responses:mode=>{responseMode=mode;},posts,gets,signTransaction,spot,realm});
 }finally{await Promise.all(stores.map(store=>store.close()));await app.close();}
}

describe('paired exact unsigned selection refusals',()=>{
 it.each(['quota','unsold','realm'] as const)('archives %s only after explicit paused providerless original-key recovery',async selection=>fixture(selection,async f=>{
  let c=f.client();await f.begin();const original=await c.store.read(),key=original.operation!.request.idempotencyKey,refusal={status:422,code:codes[selection]};
  expect(f.posts).toEqual([refusal]);expect(original.operation?.prepareRefusal).toEqual(refusal);
  await expect(c.store.archive(original.revision)).rejects.toThrow();expect(await c.store.archived(key)).toBeNull();
  await f.pause();c=f.client();await c.controller.open();
  expect(c.controller.snapshot().error).toBeNull();expect((await c.store.read()).operation?.prepareRefusal).toEqual(refusal);expect(await c.store.archived(key)).toBeNull();
  const before=f.gets.length;await c.controller.archiveRefusal();expect(c.controller.snapshot().error).toBeNull();
  expect(f.gets.slice(before)).toEqual([`/seeker/realm-sales/prepare/by-key/${key}`,`/seeker/realm-sales/by-key/${key}`]);
  expect((await c.store.read()).operation).toBeNull();const archived=await c.store.archived(key);
  expect(archived?.operation).toMatchObject({...original.operation,refusalConfirmedAbsent:true});
  c=f.client();await c.controller.open();expect((await c.store.read()).lastArchivedKey).toBe(key);expect(await c.store.archived(key)).toEqual(archived);
  expect(f.posts).toEqual([refusal]);expect(f.signTransaction).not.toHaveBeenCalled();
 }));
 it.each(['missing','malformed'] as const)('keeps a stale quota refusal held when the fresh saved GET is %s',async mode=>fixture('quota',async f=>{
  let c=f.client();await f.begin();const original=await c.store.read(),key=original.operation!.request.idempotencyKey;
  expect(original.operation?.prepareRefusal).toEqual({status:422,code:codes.quota});
  await f.pause();f.responses(mode);c=f.client();await c.controller.archiveRefusal();
  expect((await c.store.read()).operation?.request).toEqual(original.operation?.request);expect((await c.store.read()).operation?.refusalConfirmedAbsent).toBeUndefined();
  expect(await c.store.archived(key)).toBeNull();expect(c.controller.snapshot().error).not.toBeNull();expect(f.posts).toHaveLength(1);expect(f.signTransaction).not.toHaveBeenCalled();
 }));
});
