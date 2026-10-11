/** Actual browser journal/HTTP -> authenticated API -> actual D184 sim occupation
 * -> historical serialized Seeker proof -> protected stock. Injected finality is
 * local fixture evidence, not an independent provider or production assertion. */
import {createRequire} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {DivineFragmentAward,DivineFragmentAwardsPage,DivineFragmentClaimablePage,DivineFragmentSeekerEntitlement,DivineFragmentDeliveryEnvelope,DivineFragmentSeekerClaimEnvelope} from '@shardkeep/shared/divineFragmentsApi';
import {buildApp} from '../src/app';
import {sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createDivineFragments} from '../src/game/divineFragments';
import {TEST_CONFIG} from './helpers';
import {withDivineFragmentFixture} from './fixtures/divineFragments';

type Proof=DivineFragmentDeliveryEnvelope|DivineFragmentSeekerClaimEnvelope;
type Operation={command:{kind:string;consent:{request:{idempotencyKey:string;baseId:string}}};attemptRevision:number|null;proof:Proof|null};
type Store={read():Promise<{operation:Operation|null;archives:{operation:Operation}[]}>;close():Promise<void>};
type Controller={open(baseId?:string):Promise<void>;beginDelivery(baseId:string,award:DivineFragmentAward):Promise<void>;beginClaim(baseId:string,row:DivineFragmentSeekerEntitlement,cursor:string|null):Promise<void>;confirm():Promise<void>;checkOriginal():Promise<void>;archive():Promise<void>;snapshot():{error:string|null;review:unknown;awards:DivineFragmentAwardsPage|null;terms:DivineFragmentClaimablePage|null}};
const {DivineFragmentsJournalStore}=await vi.importActual<{DivineFragmentsJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/divineFragments/journal');
const {DivineFragmentsController}=await vi.importActual<{DivineFragmentsController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/divineFragments/controller');
const {divineFragmentsIdentity,createDivineFragmentsBrowserPorts}=await vi.importActual<{divineFragmentsIdentity(wallet:string):object;createDivineFragmentsBrowserPorts(input:object):object}>('../../web/src/lib/divineFragments/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void;setSelectedBaseId(id:string|null,reset?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory,IDBKeyRange}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown;IDBKeyRange:unknown};
afterEach(()=>{useApp.getState().setAuth(null);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});

it('pairs actual earned fragments and permanent Seeker shares through lost replies, cold journals, source pause and changed selection without a second credit',async()=>{
 await withDivineFragmentFixture(async f=>{
  await f.fragments.enroll(f.event.id);await f.play();const settlement=await f.settle();
  expect(settlement.awards).toHaveLength(2);expect(settlement.awards.map(a=>[a.gross,a.net,a.tax])).toEqual([['14','12','2'],['14','12','2']]);
  let app:FastifyInstance|undefined,activeStore!:Store,actor=f.wallet,enabled=true;
  const stores:Store[]=[],factory=new IDBFactory(),posts:string[]=[],lose=new Set<string>(),cookies=new Map<string,Record<string,string>>();
  const local=new Map<string,string>();
  vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!},localStorage:{getItem:(k:string)=>local.get(k)??null,setItem:(k:string,v:string)=>local.set(k,v),removeItem:(k:string)=>local.delete(k)}});
  vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});
  for(const wallet of [f.wallet,f.buyer]){const [session]=await f.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();cookies.set(wallet,{[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)});}
  async function application(providerless=false){await app?.close();const old=process.env.MULTI_BASE_ENABLED;process.env.MULTI_BASE_ENABLED='false';try{app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.db,{divineFragmentProvider:{fragments:providerless?createDivineFragments(f.db,{...f.options,termSource:null}):f.fragments,seeker:f.seeker}});await app.ready();}finally{if(old===undefined)delete process.env.MULTI_BASE_ENABLED;else process.env.MULTI_BASE_ENABLED=old;}}
  vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
   const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);expect(target.pathname.startsWith('/divine-fragments/')).toBe(true);
   if(method==='POST'){const op=(await activeStore.read()).operation;expect(op?.attemptRevision,'Persist exact consent/attempt before any POST').not.toBeNull();expect(op?.command.consent.request).toEqual(JSON.parse(String(init?.body)));posts.push(target.pathname);}
   const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
   const response=await app!.inject({method:method as 'GET'|'POST',url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies:cookies.get(actor)!}:{}),...(init?.body==null?{}:{payload:String(init.body)})});
   expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
   if(lose.delete(target.pathname))throw Error('paired fragment reply lost');return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  });
  function client(wallet=f.wallet,selected:string|null=f.baseId){actor=wallet;useApp.getState().setAuth(wallet,true);useApp.getState().setSelectedBaseId(selected,false);const identity=divineFragmentsIdentity(wallet);activeStore=new DivineFragmentsJournalStore(identity,factory);stores.push(activeStore);return new DivineFragmentsController(activeStore,createDivineFragmentsBrowserPorts({identity,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:enabled})}));}
  try{
   await application();let c=client();await c.open(f.baseId);expect(c.snapshot().error).toBeNull();const award=c.snapshot().awards!.rows[0]!.award;
   await c.beginDelivery(f.baseId,award);expect(c.snapshot().review).not.toBeNull();expect(posts).toHaveLength(0);const original=(await activeStore.read()).operation!.command;
   lose.add(`/divine-fragments/events/${f.event.id}/delivery`);await c.confirm();expect(c.snapshot().error).toContain('paired fragment reply lost');expect((await activeStore.read()).operation?.proof).toBeNull();
   vi.stubEnv('PHASE_E_CATALOG_ENABLED','false');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await application(true);enabled=false;
   c=client(f.wallet,null);await c.checkOriginal();expect(c.snapshot().error).toBeNull();expect((await activeStore.read()).operation).toMatchObject({command:original,proof:{receipt:{baseId:f.baseId,quantity:'12'}}});
   await c.confirm();await c.archive();expect(posts).toHaveLength(1);expect((await activeStore.read()).archives).toHaveLength(1);
   // Source pause does not revoke an already-earned permanent winning spot.
   enabled=true;c=client();await c.open(f.baseId);expect(c.snapshot().error).toBeNull();const share=c.snapshot().terms!.rows[0]!;expect(share.claimable).toBe('2');
   await c.beginClaim(f.baseId,share,null);expect(c.snapshot().review).not.toBeNull();lose.add('/divine-fragments/seeker/claims');await c.confirm();expect(c.snapshot().error).toContain('paired fragment reply lost');
   c=client(f.buyer,f.buyerBaseId);expect((await activeStore.read()).operation).toBeNull();expect((await activeStore.read()).archives).toHaveLength(0);
   enabled=false;c=client(f.wallet,f.buyerBaseId);await c.checkOriginal();expect(c.snapshot().error).toBeNull();expect((await activeStore.read()).operation!.proof?.receipt).toMatchObject({baseId:f.baseId,quantity:'2',previousTotal:'0',cumulativeTotal:'2'});
   await c.confirm();await c.archive();expect(posts).toEqual([`/divine-fragments/events/${f.event.id}/delivery`,'/divine-fragments/seeker/claims']);
   expect((await f.sql`select available::text from crystal_fragment_stocks where base_id=${f.baseId}`)[0]!.available).toBe('14');
   expect(await f.sql`select id from divine_fragment_deliveries`).toHaveLength(1);expect(await f.sql`select id from seeker_fragment_claims`).toHaveLength(1);
   expect((await f.fragments.award(f.buyer,f.event.id)).delivery).toBeNull();expect((await f.seeker.terms(f.buyer)).rows[0]!.claimable).toBe('2');
   // Player net outstanding12 + original winning-spot due2 + actual stock14 = gross28.
   expect(12n+2n+14n).toBe(settlement.awards.reduce((sum,a)=>sum+BigInt(a.gross),0n));
  }finally{await Promise.all(stores.map(s=>s.close()));await app?.close();}
 });
},120000);
