/** Actual browser purchase and starter journals -> authenticated API -> finalized
 * sale bank -> renewed access -> paid trip. RPC observations are local fixtures. */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,type Transaction} from '@solana/web3.js';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import type {RealmSalePreparationView} from '@shardkeep/shared/realmSalesApi';
import type {RealmSaleSettlementView} from '@shardkeep/shared/realmSaleSettlementApi';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {StarterExpeditionEnvelopeSchema,type StarterExpeditionEnvelope,type StarterExpeditionRequest} from '@shardkeep/shared/starterExpeditionApi';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {decodeSpotSalesQuota,spotSalesQuotaPda} from '../../../packages/chain/src/seekerRealmSaleProtocol';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {players,sessions} from '../src/db/schema';
import {prefetchExpeditionRealmAccessReader} from '../src/game/expeditionRealmAccess';
import {readStarterExpeditionReturn,settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {createRealmSaleSettlement,getRealmSaleSettlement} from '../src/seeker/realmSaleSettlement';
import {isolateDeedTestFixtures} from './deed-fixtures';
import {createRealmSaleRenewalPair} from './fixtures/realmSaleRenewalPair';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {connectTestDb,TEST_CONFIG} from './helpers';
import {SEAL_BOUND_SHARED_DB_CASE_MS} from './sealLatencyBudgets';
type Signed={wire:string;signature:string};
type Journal={operation:null|{request:{idempotencyKey:string};prepareAttempted:boolean;preparation:RealmSalePreparationView|null;signingStarted:boolean;signed:Signed|null;submitAttempted:boolean;settlement?:{value:RealmSaleSettlementView}}};
type Store={read():Promise<Journal>;close():Promise<void>};
type Controller={begin(spot:number,realm:number):Promise<void>;open():Promise<void>;review():Promise<void>;sign():Promise<void>;submit():Promise<void>;archive():Promise<void>;snapshot():{error:string|null}};
type StarterJournal={revision:number;operation:null|{command:{request:StarterExpeditionRequest};attemptRevision:number|null;proof:StarterExpeditionEnvelope|null};archives:Array<{operation:{proof:StarterExpeditionEnvelope|null}}>};
type StarterStore={read():Promise<StarterJournal>;close():Promise<void>};
type StarterController={beginPaidDeparture(baseId:string,realm:number):Promise<void>;confirm():Promise<void>;open():Promise<void>;finish(hydrate:(guard:()=>void)=>Promise<void>):Promise<void>;snapshot():{error:string|null;review:unknown}};
const {RealmSaleJournalStore}=await vi.importActual<{RealmSaleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/realmSales/journal');
const {RealmSaleController}=await vi.importActual<{RealmSaleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/realmSales/controller');
const {createRealmSaleBrowserPorts,realmSaleIdentity}=await vi.importActual<{createRealmSaleBrowserPorts(input:object):object;realmSaleIdentity(wallet:string):object}>('../../web/src/lib/realmSales/browser');
const {StarterExpeditionJournalStore}=await vi.importActual<{StarterExpeditionJournalStore:new(identity:object,factory:unknown)=>StarterStore}>('../../web/src/lib/starterExpedition/journal');
const {StarterExpeditionController}=await vi.importActual<{StarterExpeditionController:new(store:StarterStore,ports:object)=>StarterController}>('../../web/src/lib/starterExpedition/controller');
const {createStarterExpeditionBrowserPorts,starterExpeditionIdentity}=await vi.importActual<{createStarterExpeditionBrowserPorts(input:object):object;starterExpeditionIdentity(wallet:string):object}>('../../web/src/lib/starterExpedition/browser');
const {refreshStarterExpeditionSnapshot}=await vi.importActual<{refreshStarterExpeditionSnapshot(identity:object,ports:object,guard:()=>void,baseId:string):Promise<unknown>}>('../../web/src/lib/starterExpedition/snapshot');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void;setSelectedBaseId(baseId:string|null,reset?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=connectTestDb(),db=conn.db;let restoreDeeds=async()=>{};
beforeAll(async()=>{restoreDeeds=await isolateDeedTestFixtures(db,{observerQueue:true});});
afterAll(async()=>{await restoreDeeds();await conn.sql.end();});
afterEach(()=>{useApp.getState().setAuth(null);vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();});
describe('paired browser permit renewal and paid departure',()=>{
 it('preserves original receipts and quota days while the exact renewed permit admits a trip returning after expiry',async()=>{
  vi.useFakeTimers({toFake:['Date']});
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');
  const pair=await createRealmSaleRenewalPair(),f=pair.bank,wallet=f.buyer.toBase58();
  const time=(unix:bigint)=>{pair.setTime(unix);vi.setSystemTime(new Date(Number(unix)*1000));};time(pair.firstAt);
  const sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'renewal-pair-r1'}};
  let app=await buildApp(TEST_CONFIG,db,{realmSalePreparationSources:sources}),cookies:Record<string,string>={},actionsEnabled=true,activeStore!:Store,activeStarterStore!:StarterStore;
  const stores:Array<{close():Promise<void>}>=[],factory=new IDBFactory(),posts:string[]=[],gets:string[]=[],departurePosts:StarterExpeditionRequest[]=[],departureStatuses:number[]=[];
  const session=async()=>{const [s]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};};
  const ownedGet=async(path:string)=>{const r=await app.inject({method:'GET',url:path,cookies});expect(r.statusCode,r.body).toBe(200);return r.json();};
  try{
   await db.insert(players).values({wallet}).onConflictDoNothing();await session();
   vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});
   vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,work:(lock:{name:string})=>Promise<T>)=>work({name})}});useApp.getState().setAuth(wallet,true);
   vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
    const url=new URL(String(input)),method=init?.method??'GET';expect(url.origin).toBe(new URL(API_URL).origin);if(method!=='GET'&&method!=='POST')throw Error('Unexpected paired request');
    const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
    if(method==='POST'){
     posts.push(url.pathname);
     if(url.pathname==='/starter-expeditions'){const journal=await activeStarterStore.read(),request=JSON.parse(String(init?.body)) as StarterExpeditionRequest;expect(journal.operation?.attemptRevision).toBe(journal.revision);expect(request).toEqual(journal.operation?.command.request);departurePosts.push(request);}
     else{expect(url.pathname.startsWith('/seeker/realm-sales/')).toBe(true);const journal=await activeStore.read();expect(journal.operation?.prepareAttempted).toBe(true);if(url.pathname.endsWith('/submit'))expect(journal.operation).toMatchObject({signingStarted:true,submitAttempted:true,signed:expect.any(Object)});}
    }else gets.push(url.pathname);
    const r=await app.inject({method,url:url.pathname+url.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});
    if(method==='POST'&&url.pathname.endsWith('/submit')){expect(r.statusCode,r.body).toBe(202);throw Error('Lost response after original signed wire was retained');}
    if(method==='POST'&&url.pathname==='/starter-expeditions'){departureStatuses.push(r.statusCode);expect(r.statusCode,r.body).toBe(201);throw Error('Lost response after committed paid departure');}
    return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});
   });
   const trust={genesisHash:f.accessTrust.expectedGenesisHash,programId:f.accessTrust.programId.toBase58(),developer:f.accessTrust.developer.toBase58(),reviewedProgramDataSha256:f.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision};
   const signTransaction=vi.fn(async(tx:Transaction)=>{expect((await activeStore.read()).operation?.signingStarted).toBe(true);tx.partialSign(Keypair.fromSeed(Buffer.alloc(32,1)));return tx;});
   const client=()=>{activeStore=new RealmSaleJournalStore(realmSaleIdentity(wallet),factory);stores.push(activeStore);return new RealmSaleController(activeStore,createRealmSaleBrowserPorts({identity:realmSaleIdentity(wallet),trust:actionsEnabled?trust:null,wallet:()=>({publicKey:f.buyer,signTransaction,sendTransaction:null,signMessage:null,isEmbedded:false}),lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled}),clock:()=>0}));};
   const purchase=async()=>{
    const c=client();await c.begin(0,0);expect(c.snapshot().error).toBeNull();await c.review();expect(c.snapshot().error).toBeNull();await c.sign();expect(c.snapshot().error).toBeNull();
    const original=(await activeStore.read()).operation!;expect(original.preparation).not.toBeNull();expect(original.signed).not.toBeNull();
    await c.submit();expect(c.snapshot().error).not.toBeNull();expect((await activeStore.read()).operation?.settlement).toBeUndefined();
    await pair.settle(original.preparation!,Buffer.from(original.signed!.wire,'base64'));time(f.controls.now);
    const saved=await createRealmSaleSettlement(db,{connect:()=>f.rpc,trust:f.accessTrust})({wallet,idempotencyKey:original.request.idempotencyKey});
    return {preparation:original.preparation!,signed:original.signed!,saved};
   };
   const quota=(p:RealmSalePreparationView)=>{const address=spotSalesQuotaPda(f.accessTrust.programId,p.spot,BigInt(p.terms.day)),row=f.store.get(address.toBase58())!;return {address:address.toBase58(),bytes:Buffer.from(row.data),value:decodeSpotSalesQuota({address,owner:row.owner,executable:row.executable,data:row.data},{programId:f.accessTrust.programId,spot:p.spot,day:BigInt(p.terms.day)})};};
   const first=await purchase(),oldQuota=quota(first.preparation),oldReceipt=Buffer.from(f.store.get(first.saved.purchase.address)!.data);
   expect(oldQuota.value.sales).toBe(1);expect(first.saved.purchase.priorExpiry).toBe('0');
   // Restart both sides with sales paused and no provider. Recovery must use the
   // original key and verified saved receipt, never another signing attempt.
   actionsEnabled=false;vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,db);
   let c=client(),before=gets.length;await c.open();expect(c.snapshot().error).toBeNull();expect(gets.slice(before)).toContain(`/seeker/realm-sales/by-key/${first.preparation.idempotencyKey}`);
   expect((await activeStore.read()).operation?.settlement?.value).toEqual(first.saved);expect((await activeStore.read()).operation?.signed).toEqual(first.signed);await c.archive();expect(c.snapshot().error).toBeNull();
   const nextDay=pair.nextUtcDay();time(nextDay);expect(BigInt(first.saved.purchase.expiresAt)).toBeGreaterThan(nextDay);
   const access=await prefetchExpeditionRealmAccessReader(()=>f.rpc,f.accessTrust,{wallet,realm:0});expect((await access.readCoverage(new Date().toISOString())).expiresAt).toBe(first.saved.purchase.expiresAt);
   actionsEnabled=true;vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');await app.close();app=await buildApp(TEST_CONFIG,db,{realmSalePreparationSources:sources});
   const renewal=await purchase(),newQuota=quota(renewal.preparation);
   expect(BigInt(renewal.preparation.terms.day)).toBe(BigInt(first.preparation.terms.day)+1n);expect(newQuota.address).not.toBe(oldQuota.address);
   expect(renewal.preparation.quote.needsQuota).toBe(true);expect(renewal.preparation.quote.quotaRemaining).toBe(PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax);expect(newQuota.value.sales).toBe(1);
   expect(quota(first.preparation)).toEqual(oldQuota);expect(f.store.get(first.saved.purchase.address)!.data).toEqual(oldReceipt);
   expect(renewal.saved.purchase).toMatchObject({priorExpiry:first.saved.purchase.expiresAt,coverageStart:first.saved.purchase.expiresAt});
   expect(BigInt(renewal.saved.purchase.expiresAt)).toBe(BigInt(first.saved.purchase.expiresAt)+BigInt(PHASE_E_POLICY.seekerIsland.permitDurationSec));
   expect(renewal.saved.purchase.address).not.toBe(first.saved.purchase.address);expect(f.models.access.expires_at.toString()).toBe(renewal.saved.purchase.expiresAt);
   actionsEnabled=false;vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,db);c=client();await c.open();expect(c.snapshot().error).toBeNull();expect((await activeStore.read()).operation?.settlement?.value).toEqual(renewal.saved);
   expect((await ownedGet(`/seeker/realm-sales/by-key/${first.preparation.idempotencyKey}`)).settlement).toEqual(first.saved);
   expect(await getRealmSaleSettlement(db,{wallet,idempotencyKey:first.preparation.idempotencyKey})).toEqual(first.saved);
   expect(posts.filter(p=>p.endsWith('/prepare'))).toHaveLength(2);expect(posts.filter(p=>p.endsWith('/submit'))).toHaveLength(2);expect(signTransaction).toHaveBeenCalledTimes(2);
   // The current access is the exact account produced by renewal, including its
   // bytes/hash, while operating tax authority is freshly verified for this day.
   const expiry=BigInt(renewal.saved.purchase.expiresAt);time(expiry-60n);
   const staleCookie={...cookies};await session();expect(cookies).not.toEqual(staleCookie);
   vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('FREE_ONBOARDING','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','true');
   const starter=await createStarterExpeditionFixture(db,{wallet,now:new Date()}),term=await pair.operatingTermAt(f.controls.now);
   await app.close();app=await buildApp(TEST_CONFIG,db,{starterExpeditionProvider:{policy:term.policy,connect:term.connect},starterExpeditionAccessProvider:{trust:f.accessTrust,connect:()=>f.rpc}});
   expect((await app.inject({method:'GET',url:`/seeker/realm-sales/by-key/${first.preparation.idempotencyKey}`,cookies:staleCookie})).statusCode).toBe(401);
   expect((await ownedGet(`/seeker/realm-sales/by-key/${first.preparation.idempotencyKey}`)).settlement).toEqual(first.saved);
   useApp.getState().setSelectedBaseId(starter.baseId,false);
   const starterClient=()=>{const identity=starterExpeditionIdentity(wallet);activeStarterStore=new StarterExpeditionJournalStore(identity,factory);stores.push(activeStarterStore);const ports=createStarterExpeditionBrowserPorts({identity,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:true})});return {identity,ports,controller:new StarterExpeditionController(activeStarterStore,ports)};};
   let expedition=starterClient();await expedition.controller.beginPaidDeparture(starter.baseId,0);expect(expedition.controller.snapshot().error).toBeNull();expect(expedition.controller.snapshot().review).not.toBeNull();
   const preview=paidStarterRoutePreview('paid_frostveil'),command=(await activeStarterStore.read()).operation!.command.request;
   expect(command).toMatchObject({baseId:starter.baseId,installationId:starter.installationId,routeId:preview.routeId,routeVersion:preview.routeCatalogueVersion,rewardVersion:preview.rewardTableVersion});expect(departurePosts).toEqual([]);
   await expedition.controller.confirm();expect(expedition.controller.snapshot().error).not.toBeNull();expect(departureStatuses).toEqual([201]);expect(departurePosts).toEqual([command]);expect((await activeStarterStore.read()).operation?.proof).toBeNull();
   expedition=starterClient();before=gets.length;await expedition.controller.open();expect(expedition.controller.snapshot().error).toBeNull();expect(gets.slice(before)).toEqual([`/starter-expeditions/by-key/${command.idempotencyKey}`]);
   const trip=StarterExpeditionEnvelopeSchema.parse((await activeStarterStore.read()).operation?.proof);if(trip.status!=='accepted'||!('access'in trip.receipt.route)||trip.receipt.route.access.kind!=='paid_realm')throw Error('Expected paid acceptance');
   const observation=trip.receipt.route.access.observation;expect(observation.accessAddress).toBe(f.addresses.access.toBase58());expect(observation.expiresAt).toBe(renewal.saved.purchase.expiresAt);
   expect(observation.source.accounts[3]).toEqual(renewal.saved.receipt.source.accounts[3]);expect(observation.source.genesisHash).toBe(first.saved.receipt.source.genesisHash);
   expect(Date.parse(trip.receipt.returnsAt)).toBeGreaterThan(Number(expiry)*1000);
   // The vehicle is still away at equality. Check the actual access reader's
   // exclusive boundary here; the next HTTP departure is checked after return.
   time(expiry);const expired=await prefetchExpeditionRealmAccessReader(()=>f.rpc,f.accessTrust,{wallet,realm:0});await expect(expired.readCoverage(new Date().toISOString())).rejects.toMatchObject({code:'EXPIRED'});
   time(BigInt(Date.parse(trip.receipt.returnsAt)/1000));const [proof]=await db.transaction(tx=>settleDueStarterExpeditions(tx,starter.baseId,new Date()));
   expect(proof?.expedition.id).toBe(command.idempotencyKey);expect(proof?.entries.map(e=>[e.bucket,e.delta])).toEqual([['base_stock',BigInt(preview.netQuantity)],['island_pool',BigInt(preview.islandPoolQuantity)],['issued',-BigInt(preview.grossQuantity)]]);
   expect(await readStarterExpeditionReturn(db,command.idempotencyKey)).toEqual(proof);expect(await db.transaction(tx=>settleDueStarterExpeditions(tx,starter.baseId,new Date()))).toEqual([]);
   expedition=starterClient();before=gets.length;await expedition.controller.open();expect(expedition.controller.snapshot().error).toBeNull();expect(gets.slice(before)).toEqual([`/starter-expeditions/by-key/${command.idempotencyKey}`]);
   const returned=StarterExpeditionEnvelopeSchema.parse((await activeStarterStore.read()).operation?.proof);expect(returned.receipt).toEqual(trip.receipt);expect(returned.return).not.toBeNull();expect(departurePosts).toEqual([command]);
   let hydrated:unknown;await expedition.controller.finish(async guard=>{hydrated=await refreshStarterExpeditionSnapshot(expedition.identity,expedition.ports,guard,starter.baseId);});expect(expedition.controller.snapshot().error).toBeNull();
   expect(hydrated).toMatchObject({view:{rawStock:expect.arrayContaining([{resourceId:preview.resourceId,available:preview.netQuantity,reserved:'0',total:preview.netQuantity}])}});expect((await activeStarterStore.read()).operation).toBeNull();expect((await activeStarterStore.read()).archives[0]?.operation.proof).toEqual(returned);
   // Refresh the finalized clock/term for this new attempt; expiry alone denies
   // it, and no stale observation or in-flight reservation masks the reason.
   const current=await pair.operatingTermAt(f.controls.now);await app.close();app=await buildApp(TEST_CONFIG,db,{starterExpeditionProvider:{policy:current.policy,connect:current.connect},starterExpeditionAccessProvider:{trust:f.accessTrust,connect:()=>f.rpc}});
   expedition=starterClient();await expedition.controller.beginPaidDeparture(starter.baseId,0);expect(expedition.controller.snapshot().error).toBe('Current paid destination coverage is unavailable. Saved receipts remain recoverable.');expect((await activeStarterStore.read()).operation).toBeNull();expect(departurePosts).toEqual([command]);
   // Expired browser review cannot enqueue a command. Independently prove the
   // authenticated server rejects a fresh command too, with no acceptance.
   const expiredCommand={...command,idempotencyKey:randomUUID()},refused=await app.inject({method:'POST',url:'/starter-expeditions',headers:{origin:TEST_CONFIG.WEB_ORIGIN[0]!},cookies,payload:expiredCommand});expect(refused.statusCode,refused.body).toBe(409);expect(refused.json()).toMatchObject({error:{code:'EXPEDITION_ACCESS_EXPIRED'}});
   expect(StarterExpeditionEnvelopeSchema.parse(await ownedGet(`/starter-expeditions/by-key/${expiredCommand.idempotencyKey}`)).status).toBe('unknown');expect(signTransaction).toHaveBeenCalledTimes(2);
  }finally{await Promise.all(stores.map(s=>s.close()));await app.close();}
 },SEAL_BOUND_SHARED_DB_CASE_MS);
});
