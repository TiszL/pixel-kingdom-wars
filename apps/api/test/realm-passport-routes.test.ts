/** Real authenticated HTTP over the real Realm Passport source contexts: actual
 * settled starter returns, a real projected publication and a real current
 * assessment. Sessions are real session rows; nothing is mocked at the route
 * or provider layer. */
import {REALM_PASSPORT_PAGE_SIZE as PAGE,RealmPassportCurrentResponseSchema,RealmPassportExpeditionsResponseSchema,RealmPassportInclusionsResponseSchema} from '@shardkeep/shared/realmPassportApi';
import rateLimit from '@fastify/rate-limit';
import {CHAT} from '@shardkeep/shared';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app';
import {HttpError} from '../src/lib/errors';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import type {Db} from '../src/db/client';
import {sessions} from '../src/db/schema';
import type {RealmPassportProvider} from '../src/game/realmPassport';
import {REALM_PASSPORT_READ_RATE_LIMIT,registerRealmPassportRoutes} from '../src/game/realmPassportRoutes';
import {REALM_PASSPORT_TEST_FLAGS,realmPassportStarterFixture,withRealmPassportCurrentFixture} from './fixtures/realmPassport';
import {TEST_CONFIG} from './helpers';

const PRIVATE=['leafHex','proofHex','leafIndex','manifest','custodyWallet','homeEvidence','finality','accessEvidence','preparationAllowed','claimSubmissionAuthorized'];
async function login(db:Db,wallet:string){const [row]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,row!.id)};}
async function serve(db:Db,provider:RealmPassportProvider|null){const app=await buildApp(TEST_CONFIG,db,{realmPassportProvider:provider});await app.ready();return app;}
const get=(app:FastifyInstance,url:string,cookies?:Record<string,string>)=>app.inject({method:'GET',url,...(cookies?{cookies}:{})});
type Reply={statusCode:number;headers:Record<string,unknown>;body:string;json():unknown};
const noStore=(response:Reply)=>{expect(response.headers['cache-control'],response.body).toBe('private, no-store');return response;};
function ok(response:Reply){expect(response.statusCode,response.body).toBe(200);noStore(response);return response.json() as Record<string,unknown>;}
function noPrivate(body:string,...wallets:string[]){for(const key of [...PRIVATE,...wallets])expect(body).not.toContain(key);}

describe('realm passport HTTP over real starter history',()=>{
 let f:Awaited<ReturnType<typeof realmPassportStarterFixture>>,app:FastifyInstance,disabled:FastifyInstance,restricted:FastifyInstance,seller:Record<string,string>,buyer:Record<string,string>,ownId:string;
 const apps:FastifyInstance[]=[];
 beforeAll(async()=>{
  for(const flag of REALM_PASSPORT_TEST_FLAGS)vi.stubEnv(flag,'true');
  f=await realmPassportStarterFixture({completed:PAGE+1});ownId=(await f.ownTrip(f.buyer)).proof.expedition.id;
  apps.push(app=await serve(f.db,f.provider()),disabled=await serve(f.db,null),restricted=await serve(f.db,f.provider((await f.readerRole()).db)));
  seller=await login(f.db,f.wallet);buyer=await login(f.db,f.buyer);
 },300_000);
 afterAll(async()=>{for(const a of apps)await a.close();vi.unstubAllEnvs();await f?.close();},120_000);
 const ids=()=>f.completed.map(p=>p.expedition.id).sort();

 it('requires a session on every route and never takes the wallet from the query',async()=>{
  for(const url of ['/realm-passport/expeditions?kind=starter','/realm-passport/mining/inclusions','/realm-passport/mining/current'])expect(noStore(await get(app,url)).statusCode).toBe(401);
  expect(noStore(await get(app,`/realm-passport/expeditions?kind=starter&wallet=${f.wallet}`,buyer)).statusCode).toBe(400);
 });
 it('serves the original actor\'s pages with the frozen schema, exclusive cursor and private no-store header',async()=>{
  const first=ok(await get(app,'/realm-passport/expeditions?kind=starter',seller));
  expect(RealmPassportExpeditionsResponseSchema.parse(first)).toEqual(first);
  const page=first as {wallet:string;state:string;data:{rows:{expeditionId:string}[];nextCursor:string|null}};
  expect(page.wallet).toBe(f.wallet);expect(page.state).toBe('available');expect(page.data.rows).toHaveLength(PAGE);expect(page.data.nextCursor).toBe(page.data.rows[PAGE-1]!.expeditionId);
  const second=ok(await get(app,`/realm-passport/expeditions?kind=starter&cursor=${page.data.nextCursor}`,seller)) as typeof page;
  expect([...page.data.rows,...second.data.rows].map(r=>r.expeditionId)).toEqual(ids());expect(second.data.nextCursor).toBeNull();
  noPrivate(JSON.stringify([first,second]),f.buyer,ownId);
  const mine=ok(await get(app,'/realm-passport/expeditions?kind=starter',buyer)) as typeof page;
  expect(mine.wallet).toBe(f.buyer);expect(mine.data.rows.map(r=>r.expeditionId)).toEqual([ownId]);noPrivate(JSON.stringify(mine),f.wallet);
  // A foreign cursor bounds; it never reveals the seller's rows to the buyer.
  const bounded=ok(await get(app,`/realm-passport/expeditions?kind=starter&cursor=${ids()[0]}`,buyer)) as typeof page;
  expect(bounded.data.rows.map(r=>r.expeditionId)).toEqual([ownId].filter(id=>id>ids()[0]!));
  expect((ok(await get(app,'/realm-passport/expeditions?kind=advanced',seller)) as typeof page).data).toEqual({kind:'advanced',rows:[],nextCursor:null});
 });
 it('rejects loose or foreign-shaped queries with 400 before touching the source',async()=>{
  for(const url of ['/realm-passport/expeditions','/realm-passport/expeditions?kind=paid','/realm-passport/expeditions?kind=starter&cursor=7',`/realm-passport/expeditions?kind=starter&cursor=${ids()[0]!.toUpperCase()}`,
   '/realm-passport/expeditions?kind=starter&x=1','/realm-passport/mining/inclusions?cursor=0','/realm-passport/mining/inclusions?cursor=01','/realm-passport/mining/inclusions?kind=starter',
   '/realm-passport/mining/current?cursor=1','/realm-passport/mining/current?x='])expect(noStore(await get(app,url,seller)).statusCode,url).toBe(400);
 });
 it('answers 503 only when the provider is wholly absent; a configured source without mining or without ownership uses the DTO state',async()=>{
  for(const url of ['/realm-passport/expeditions?kind=starter','/realm-passport/mining/inclusions','/realm-passport/mining/current']){
   const response=noStore(await get(disabled,url,seller));expect(response.statusCode,url).toBe(503);expect((response.json() as {error:{code:string}}).error.code).toBe('REALM_PASSPORT_UNAVAILABLE');
  }
  for(const url of ['/realm-passport/mining/inclusions','/realm-passport/mining/current']){
   const body=ok(await get(app,url,seller));expect(body).toMatchObject({wallet:f.wallet,state:'unavailable',reason:'NOT_CONFIGURED',data:null,projection:'history-only',version:1});
  }
  expect(ok(await get(restricted,'/realm-passport/expeditions?kind=advanced',seller))).toMatchObject({state:'unavailable',reason:'NOT_CONFIGURED',data:null});
  expect((ok(await get(restricted,'/realm-passport/expeditions?kind=starter',seller)) as {data:{rows:unknown[]}}).data.rows).toHaveLength(PAGE);
 });
});

describe('realm passport HTTP over a real projected publication',()=>{
 it('serves this wallet\'s inclusions and current record from the session wallet, keeps history when the current source is disabled, and never mixes wallets',async()=>withRealmPassportCurrentFixture(async f=>{
  const app=await serve(f.db,f.provider());
  try{
   const seller=await login(f.db,f.wallet),buyer=await login(f.db,f.buyer);
   const inclusions=ok(await get(app,'/realm-passport/mining/inclusions',seller));expect(RealmPassportInclusionsResponseSchema.parse(inclusions)).toEqual(inclusions);
   expect(inclusions).toMatchObject({wallet:f.wallet,state:'available'});expect((inclusions as {data:{rows:{sequence:string;leaf:{wallet:string}}[]}}).data.rows.map(r=>[r.sequence,r.leaf.wallet])).toEqual([['1',f.wallet]]);
   const current=ok(await get(app,'/realm-passport/mining/current',seller));expect(RealmPassportCurrentResponseSchema.parse(current)).toEqual(current);
   expect(current).toMatchObject({wallet:f.wallet,state:'available',data:{publicationSequence:'1',attested:null}});
   noPrivate(JSON.stringify([inclusions,current]),f.buyer);
   const theirs=ok(await get(app,'/realm-passport/mining/inclusions',buyer));expect((theirs as {data:{rows:{leaf:{wallet:string}}[]}}).data.rows.map(r=>r.leaf.wallet)).toEqual([f.buyer]);noPrivate(JSON.stringify(theirs),f.wallet);
   expect(ok(await get(app,`/realm-passport/mining/inclusions?cursor=1`,seller))).toMatchObject({state:'available',data:{rows:[],nextCursor:null}});
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');
   try{
    expect(ok(await get(app,'/realm-passport/mining/current',seller))).toMatchObject({state:'unavailable',reason:'NOT_CONFIGURED',data:null});
    expect(ok(await get(app,'/realm-passport/mining/inclusions',seller))).toMatchObject({state:'available'});
   }finally{vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
  }finally{await app.close();}
 }),240_000);
});


/** buildApp skips Redis admission under NODE_ENV=test, so the exported per-wallet
 * read bucket is exercised on a small app with the real plugin, real hook order
 * (authenticate before the wallet bucket) and the real provider. */
describe('realm passport per-wallet read admission',()=>{
 it('declares a fail-closed authenticated wallet bucket reusing the existing per-wallet read ceiling',()=>{
  expect(REALM_PASSPORT_READ_RATE_LIMIT).toMatchObject({max:CHAT.readsPerWalletMinute,timeWindow:60_000,skipOnError:false});
  expect(REALM_PASSPORT_READ_RATE_LIMIT.keyGenerator({wallet:'So11111111111111111111111111111111111111112'} as never)).toBe('realm-passport-read-wallet:So11111111111111111111111111111111111111112');
 });
 it('admits per authenticated wallet after authentication, never per IP, and answers 429 with the passport code',async()=>{
  for(const flag of REALM_PASSPORT_TEST_FLAGS)vi.stubEnv(flag,'true');
  const f=await realmPassportStarterFixture({completed:0});
  try{
   const app=Fastify({trustProxy:1});await app.register(rateLimit,{global:false,max:10_000,timeWindow:60_000});app.decorateRequest('wallet','');
   let authCalls=0;app.decorate('authenticate',async(req:FastifyRequest)=>{authCalls++;const wallet=req.headers['x-wallet'];if(typeof wallet!=='string'||wallet==='')throw new HttpError(401,'no session');req.wallet=wallet;});
   const original=app.createRateLimit.bind(app);app.createRateLimit=((options:Parameters<typeof original>[0])=>original({...options,max:2})) as typeof app.createRateLimit;
   registerRealmPassportRoutes(app,f.provider());
   app.setErrorHandler((err:unknown,_req,reply)=>{const e=err as {statusCode?:number;code?:string;message?:string};return reply.code(e.statusCode??500).send({error:{code:e.code,message:e.message}});});
   await app.ready();
   try{
    const read=(wallet?:string)=>app.inject({method:'GET',url:'/realm-passport/mining/current',...(wallet?{headers:{'x-wallet':wallet}}:{})});
    expect((await read()).statusCode).toBe(401);expect(authCalls).toBe(1);
    expect((await read(f.wallet)).statusCode).toBe(200);expect((await read(f.wallet)).statusCode).toBe(200);
    const limited=await read(f.wallet);expect(limited.statusCode).toBe(429);expect((limited.json() as {error:{code:string}}).error.code).toBe('REALM_PASSPORT_RATE_LIMITED');
    expect((await read(f.buyer)).statusCode).toBe(200);
    expect((await read()).statusCode).toBe(401);
   }finally{await app.close();}
  }finally{vi.unstubAllEnvs();await f.close();}
 },120_000);
});
