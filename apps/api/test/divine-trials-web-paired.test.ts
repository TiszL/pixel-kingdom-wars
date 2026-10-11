/** Actual browser journal/owned HTTP + authenticated API + settled Renown and
 * canonical simulation. Upstream finalized banks are declared local fixtures. */
import {createRequire} from 'node:module';
import {afterEach,it,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {DivineTrialAttempt,DivineTrialEntry,DivineTrialClaim} from '@shardkeep/shared/divineTrialsApi';
import {buildApp} from '../src/app';
import {sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {withDivineTrialFixture} from './fixtures/divineTrials';
type Row={eventId:string;entryIntent:object|null;entry:DivineTrialEntry|null;attempts:{request:object;original:DivineTrialAttempt|null;orders:unknown}[];prizeIntent:{baseId:string}|null;claim:DivineTrialClaim|null};
type Store={read():Promise<{events:Row[]}>;close():Promise<void>};
type Controller={load():Promise<unknown>;open(id:string):Promise<unknown>;select(id:string):void;entry(baseId:string):Promise<unknown>;attempt(baseId:string):Promise<unknown>;submit(id:string,orders:unknown):Promise<unknown>;recover(retry?:boolean):Promise<unknown>;claim(baseId:string):Promise<unknown>};
const {DivineTrialJournalStore}=await vi.importActual<{DivineTrialJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/divineTrials/journal');
const {DivineTrialController}=await vi.importActual<{DivineTrialController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/divineTrials/controller');
const {browserDivineIdentity,createDivineBrowserPorts}=await vi.importActual<{browserDivineIdentity(wallet:string):object;createDivineBrowserPorts(input:object):object}>('../../web/src/lib/divineTrials/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void;setSelectedBaseId(id:string,reset?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory,IDBKeyRange}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown;IDBKeyRange:unknown};
afterEach(()=>{useApp.getState().setAuth(null);vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('recovers lost entry, admission, canonical result and prize through browser restart, pause and qualification-source outage',async()=>{
 await withDivineTrialFixture(async f=>{let app:FastifyInstance|undefined;const stores:Store[]=[];
  try{
   const [session]=await f.db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning(),cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.wallet,session!.id)};
   async function application(){const old=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';try{const value=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.db,{divineTrialProvider:f.service()});await value.ready();return value;}finally{process.env['MULTI_BASE_ENABLED']=old;}}
   app=await application();vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_opts:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});
   const factory=new IDBFactory(),lose=new Set<string>(),posts:string[]=[],paths:string[]=[];let store!:Store,enabled=true;
   vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);paths.push(target.pathname);const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
    if(method==='POST'){posts.push(target.pathname);const row=(await store.read()).events.find(e=>e.eventId===f.event.id)!;expect(row).toBeDefined();const body=JSON.parse(String(init?.body));if(target.pathname.endsWith('/entries'))expect(row.entryIntent).toEqual(body);if(target.pathname.endsWith('/attempts'))expect(row.attempts.some(a=>JSON.stringify(a.request)===JSON.stringify(body))).toBe(true);if(target.pathname.endsWith('/submit'))expect(row.attempts.some(a=>JSON.stringify(a.orders)===JSON.stringify(body.orders))).toBe(true);if(target.pathname.endsWith('/prize'))expect(row.prizeIntent).toEqual(body);}
    const response=await app!.inject({method:method as 'GET'|'POST',url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});expect(response.statusCode,response.body).toBeLessThan(300);if(lose.delete(target.pathname))throw Error('paired lost Divine reply');return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
   });
   function client(){useApp.getState().setAuth(f.wallet,true);useApp.getState().setSelectedBaseId(f.baseId,false);const identity=browserDivineIdentity(f.wallet);store=new DivineTrialJournalStore(identity,factory);stores.push(store);const c=new DivineTrialController(store,createDivineBrowserPorts({identity,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:enabled})}));c.select(f.event.id);return c;}
   const root='/divine-trials/events/'+f.event.id;f.setTime(f.event.entryStartsAt);let c=client();await c.load();await c.open(f.event.id);lose.add(root+'/entries');await expect(c.entry(f.baseId)).rejects.toThrow('paired lost');c=client();await c.recover(true);expect((await store.read()).events[0]!.entry?.wallet).toBe(f.wallet);await f.enter(f.buyer,f.buyerBaseId);
   f.setTime(f.event.playStartsAt);lose.add(root+'/attempts');await expect(c.attempt(f.baseId)).rejects.toThrow('paired lost');c=client();await c.recover(true);const attempt=(await store.read()).events[0]!.attempts[0]!.original!;lose.add('/divine-trials/attempts/'+attempt.id+'/submit');await expect(c.submit(attempt.id,f.orders('north'))).rejects.toThrow('paired lost');
   const other=await f.admit(f.buyer,f.buyerBaseId);await f.client.submit(f.buyer,other.id,{orders:f.orders('south')});f.setTime(f.event.playEndsAt);await f.client.close(f.event.id);f.setOnline(false);enabled=false;vi.stubEnv('PHASE_E_CATALOG_ENABLED','false');await app.close();app=await application();c=client();await c.recover(true);expect((await store.read()).events[0]!.attempts[0]!.original?.result).toMatchObject({stars:2,destruction:93});
   lose.add(root+'/prize');await expect(c.claim(f.baseId)).rejects.toThrow('paired lost');c=client();await c.recover(true);const claim=(await store.read()).events[0]!.claim!;expect(claim.baseId).toBe(f.baseId);expect(Object.values(claim.amounts)).toEqual(Array(8).fill('4'));expect(posts).toEqual([root+'/entries',root+'/attempts','/divine-trials/attempts/'+attempt.id+'/submit',root+'/prize']);expect(paths.every(p=>p.startsWith('/divine-trials/'))).toBe(true);
  }finally{await Promise.all(stores.map(s=>s.close()));await app?.close();}
 });
},120000);
