/** Actual browser journal/HTTP -> authenticated API -> actual D184 sim occupation
 * -> historical serialized Seeker proof -> protected stock. Injected finality is
 * local fixture evidence, not an independent provider or production assertion. */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {DivineFragmentAward,DivineFragmentAwardsPage,DivineFragmentClaimablePage,DivineFragmentSeekerEntitlement,DivineFragmentDeliveryEnvelope,DivineFragmentSeekerClaimEnvelope} from '@shardkeep/shared/divineFragmentsApi';
import {buildApp} from '../src/app';
import {sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createDivineFragments} from '../src/game/divineFragments';
import {TEST_CONFIG} from './helpers';
import {withMixedDivineFragmentFixture} from './fixtures/mixedDivineFragments';

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

it('pairs actual clan roster earnings and a cumulative Seeker top-up through cold browser recovery without redirecting stock',async()=>{
 await withMixedDivineFragmentFixture(async mixed=>{
  const c=mixed.clan;await mixed.enroll();await mixed.play();await mixed.settleIndividual();
  const f={...c,wallet:c.source.wallet,buyer:c.buyer.wallet,baseId:c.source.baseId,buyerBaseId:c.buyer.baseId,options:c.fragmentOptions};
  const firstRight=(await f.seeker.terms(f.wallet)).rows[0]!;
  const firstClaim=await f.seeker.claim(f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,termId:firstRight.termId,spotId:firstRight.spotId});
  expect(firstClaim.quantity).toBe('1');const settlement=await c.settle();
  expect(settlement.awards).toHaveLength(3);expect(settlement.awards.reduce((n,a)=>n+BigInt(a.gross),0n)).toBe(39n);
  const overlap=settlement.awards.find(a=>a.wallet===mixed.individual.wallet)!;expect([overlap.carryBefore,overlap.tax,overlap.net]).toEqual(['8000','3','10']);
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
   await application();let c=client();await c.open(f.baseId);expect(c.snapshot().error).toBeNull();const award=c.snapshot().awards!.rows[0]!.award;expect(award).toMatchObject({site:'divine-clan-001',clan:{clanId:f.birth.consent.clanId,rosterSize:3,siteGross:'40'}});
   await c.beginDelivery(f.baseId,award);expect(c.snapshot().review).not.toBeNull();expect(posts).toHaveLength(0);const original=(await activeStore.read()).operation!.command;
   lose.add(`/divine-fragments/events/${f.event.id}/delivery`);await c.confirm();expect(c.snapshot().error).toContain('paired fragment reply lost');expect((await activeStore.read()).operation?.proof).toBeNull();
   vi.stubEnv('PHASE_E_CATALOG_ENABLED','false');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await application(true);enabled=false;
   c=client(f.wallet,null);await c.checkOriginal();expect(c.snapshot().error).toBeNull();expect((await activeStore.read()).operation).toMatchObject({command:original,proof:{receipt:{baseId:f.baseId,quantity:'11'}}});
   await c.confirm();await c.archive();expect(posts).toHaveLength(1);expect((await activeStore.read()).archives).toHaveLength(1);
   // Source pause does not revoke an already-earned permanent winning spot.
   enabled=true;c=client();await c.open(f.baseId);expect(c.snapshot().error).toBeNull();const share=c.snapshot().terms!.rows[0]!;expect(share.claimable).toBe('3');
   await c.beginClaim(f.baseId,share,null);expect(c.snapshot().review).not.toBeNull();lose.add('/divine-fragments/seeker/claims');await c.confirm();expect(c.snapshot().error).toContain('paired fragment reply lost');
   c=client(f.buyer,f.buyerBaseId);expect((await activeStore.read()).operation).toBeNull();expect((await activeStore.read()).archives).toHaveLength(0);
   enabled=false;c=client(f.wallet,f.buyerBaseId);await c.checkOriginal();expect(c.snapshot().error).toBeNull();expect((await activeStore.read()).operation!.proof?.receipt).toMatchObject({baseId:f.baseId,quantity:'3',previousTotal:'1',cumulativeTotal:'4'});
   await c.confirm();await c.archive();expect(posts).toEqual([`/divine-fragments/events/${f.event.id}/delivery`,'/divine-fragments/seeker/claims']);
   expect((await f.sql`select available::text from crystal_fragment_stocks where base_id=${f.baseId}`)[0]!.available).toBe('15');
   expect(await f.sql`select id from divine_fragment_deliveries`).toHaveLength(1);expect(await f.sql`select id from seeker_fragment_claims`).toHaveLength(2);
   expect((await f.fragments.award(f.buyer,f.event.id)).delivery).toBeNull();expect((await f.seeker.terms(f.buyer)).rows[0]!.claimable).toBe('4');
   // Undelivered individual12 + member nets21 + other spot4 + pool dust1 + stock15 = gross53.
   expect(12n+21n+4n+1n+15n).toBe(14n+settlement.awards.reduce((sum,a)=>sum+BigInt(a.gross),0n));
  }finally{await Promise.all(stores.map(s=>s.close()));await app?.close();}
 });
},240000);
