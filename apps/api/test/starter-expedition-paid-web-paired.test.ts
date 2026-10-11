/** Real authenticated HTTP -> browser transport/controller -> strict IndexedDB.
 * Access bytes are locally encoded; tax term is synthetic. No listener or RPC. */
import {createRequire} from 'node:module';
import {PublicKey} from '@solana/web3.js';
import type {StarterExpeditionEnvelope,StarterExpeditionRequest} from '@shardkeep/shared/starterExpeditionApi';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions} from '../src/db/schema';
import * as term from '../src/game/expeditionTermReader';
import {settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import type {StarterExpeditionProvider} from '../src/game/starterExpeditionRoutes';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {connectTestDb,TEST_CONFIG} from './helpers';
import {isolateDeedTestFixtures} from './deed-fixtures';
type Journal={revision:number;operation:{command:{request:StarterExpeditionRequest;route:unknown};attemptRevision:number|null;proof:StarterExpeditionEnvelope|null;refusal:unknown}|null;archives:Array<{operation:{command:{request:StarterExpeditionRequest};proof:StarterExpeditionEnvelope|null}}>};
type Store={read():Promise<Journal>;close():Promise<void>};
type Controller={beginPaidDeparture(baseId:string,realm:number):Promise<void>;confirm():Promise<void>;reviewCommand():Promise<void>;open():Promise<void>;finish(hydrate:(guard:()=>void)=>Promise<void>):Promise<void>;snapshot():{error:string|null;review:unknown}};
const {StarterExpeditionJournalStore}=await vi.importActual<{StarterExpeditionJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/starterExpedition/journal');
const {StarterExpeditionController}=await vi.importActual<{StarterExpeditionController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/starterExpedition/controller');
const {createStarterExpeditionBrowserPorts,starterExpeditionIdentity}=await vi.importActual<{createStarterExpeditionBrowserPorts(input:object):object;starterExpeditionIdentity(wallet:string):object}>('../../web/src/lib/starterExpedition/browser');
const {refreshStarterExpeditionSnapshot}=await vi.importActual<{refreshStarterExpeditionSnapshot(identity:object,ports:object,guard:()=>void,originalBaseId:string):Promise<unknown>}>('../../web/src/lib/starterExpedition/snapshot');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,authed?:boolean):void;setSelectedBaseId(baseId:string|null,reset?:boolean):void;rawStock?:unknown}}}>('../../web/src/state/store');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=connectTestDb(),db=conn.db;let restoreDeeds=async()=>{};beforeAll(async()=>{restoreDeeds=await isolateDeedTestFixtures(db,{observerQueue:true});});afterAll(async()=>{await restoreDeeds();await conn.sql.end();});afterEach(()=>{useApp.getState().setAuth(null);vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();});
async function fixture(mode:'lost-accepted'|'generic-failure',run:(f:{client:()=>{store:Store;controller:Controller;ports:object;identity:object};stop:()=>Promise<void>;posts:StarterExpeditionRequest[];gets:string[];failures:string[];baseId:string;returnAt:(at:string)=>Promise<void>})=>Promise<void>){
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2035-01-01T01:00:00.000Z'));vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('FREE_ONBOARDING','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
 const f=await createStarterExpeditionFixture(db,{now:new Date()}),bank=await createSeekerRealmAccessFixture(),wallet=new PublicKey(f.wallet),realm=0;
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('realm_access'),wallet.toBuffer(),Buffer.of(realm)],bank.programId),BN=bank.accessModel.expires_at.constructor as new(n:string)=>typeof bank.accessModel.expires_at;
 bank.accessModel.wallet=wallet;bank.accessModel.bump=bump;bank.accessModel.expires_at=new BN(String(Math.floor(Date.now()/1000)+60));bank.rows[3]!.address=address;await bank.encode('access');bank.rows[4]!.data.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32);bank.rows[5]=null;
 f.snapshot={...f.snapshot,source:{...f.snapshot.source,genesisHash:bank.genesis.toBase58(),programId:bank.programId.toBase58()}};
 vi.spyOn(term,'prefetchExpeditionTermReader').mockImplementation(async()=>({readOperatingTerm:async at=>({snapshot:f.snapshot,finality:{commitment:'finalized',contextSlot:'200',observedAt:at}})}));
 const key=bank.programId,provider:StarterExpeditionProvider={policy:{genesisHash:key,programId:key,config:key,round:1n,mint:key,prizeOwner:key,prizeAta:key,stateProvenance:'fresh-reviewed-deployment',deployment:{programDataAddress:key.toBase58(),programDataSha256:'ab'.repeat(32),upgradeAuthority:null}},connect:()=>{throw Error('Synthetic term only');}};
 let app=await buildApp(TEST_CONFIG,db,{starterExpeditionProvider:provider,starterExpeditionAccessProvider:{trust:bank.trust,connect:()=>bank.rpc}}),activeStore!:Store,actionsEnabled=true;
 const factory=new IDBFactory(),stores:Store[]=[],posts:StarterExpeditionRequest[]=[],gets:string[]=[],failures:string[]=[];
 try{
  const [session]=await db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning(),cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.wallet,session!.id)};
  vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,work:(lock:{name:string})=>Promise<T>)=>work({name})}});useApp.getState().setAuth(f.wallet,true);useApp.getState().setSelectedBaseId(f.baseId,false);
  vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
   const url=new URL(String(input)),method=init?.method??'GET';expect(url.origin).toBe(new URL(API_URL).origin);if(method!=='GET'&&method!=='POST')throw Error('Unexpected paired method');
   const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
   if(method==='POST'){const saved=await activeStore.read();expect(saved.operation?.attemptRevision).toBe(saved.revision);const request=JSON.parse(String(init?.body)) as StarterExpeditionRequest;expect(request).toEqual(saved.operation?.command.request);posts.push(request);if(mode==='generic-failure')return new Response(JSON.stringify({error:{code:'INTERNAL_ERROR',message:'Unknown result'}}),{status:503,headers:{'content-type':'application/json'}});}
   else gets.push(url.pathname);
   const result=await app.inject({method,url:url.pathname+url.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});
   if(method==='POST'){expect(result.statusCode).toBe(201);throw Error('Lost response after committed acceptance');}
   if(result.statusCode!==200)failures.push(`${url.pathname}: ${result.statusCode} ${result.body}`);expect(result.statusCode).toBe(200);return new Response(result.body,{status:result.statusCode,headers:{'content-type':'application/json'}});
  });
  const client=()=>{const identity=starterExpeditionIdentity(f.wallet);activeStore=new StarterExpeditionJournalStore(identity,factory);stores.push(activeStore);const ports=createStarterExpeditionBrowserPorts({identity,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled})});return {store:activeStore,ports,identity,controller:new StarterExpeditionController(activeStore,ports)};};
  await run({client,posts,gets,failures,baseId:f.baseId,stop:async()=>{actionsEnabled=false;vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,db);},returnAt:async at=>{vi.setSystemTime(new Date(at));await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,new Date(at)));}});
 }finally{await Promise.all(stores.map(s=>s.close()));await app.close();}
}
describe('paid starter browser paired recovery',()=>{
 it('recovers a lost committed acceptance by GET while paused/providerless, then hydrates exact return stock after access expiry',async()=>fixture('lost-accepted',async f=>{
  let c=f.client();await c.controller.beginPaidDeparture(f.baseId,0);expect(c.controller.snapshot().error).toBeNull();expect(c.controller.snapshot().review).not.toBeNull();expect(f.posts).toHaveLength(0);
  const original=(await c.store.read()).operation!.command;await c.controller.confirm();expect(f.posts).toEqual([original.request]);expect((await c.store.read()).operation!.proof).toBeNull();
  await f.stop();c=f.client();const before=f.gets.length;await c.controller.open();const recovered=(await c.store.read()).operation!.proof;expect(recovered?.status).toBe('accepted');expect(f.gets.slice(before)).toEqual([`/starter-expeditions/by-key/${original.request.idempotencyKey}`]);
  await c.controller.reviewCommand();await c.controller.confirm();expect(f.posts).toHaveLength(1);if(recovered?.status!=='accepted')throw Error('fixture acceptance');
  await f.returnAt(recovered.receipt.returnsAt);await c.controller.open();const returned=(await c.store.read()).operation!.proof;expect(returned?.return).not.toBeNull();
  let hydrated:unknown;await c.controller.finish(async guard=>{hydrated=await refreshStarterExpeditionSnapshot(c.identity,c.ports,guard,f.baseId);});expect(f.failures).toEqual([]);expect(c.controller.snapshot().error).toBeNull();expect(hydrated).toMatchObject({view:{rawStock:expect.arrayContaining([{resourceId:recovered.receipt.route.resourceId,available:recovered.receipt.route.netQuantity,reserved:'0',total:recovered.receipt.route.netQuantity}])}});
  expect((await c.store.read()).operation).toBeNull();expect((await c.store.read()).archives[0]?.operation.proof).toEqual(returned);expect(f.posts).toHaveLength(1);
 }));
 it('keeps an ambiguous first POST and original absence held without a second POST or replacement key',async()=>fixture('generic-failure',async f=>{
  let c=f.client();await c.controller.beginPaidDeparture(f.baseId,0);await c.controller.confirm();const original=(await c.store.read()).operation!;expect(original.refusal).toBeNull();await f.stop();c=f.client();await c.controller.open();await c.controller.reviewCommand();await c.controller.confirm();await c.controller.beginPaidDeparture(f.baseId,0);expect(f.posts).toEqual([original.command.request]);expect((await c.store.read()).operation).toEqual(original);expect((await c.store.read()).archives).toEqual([]);
 }));
});
