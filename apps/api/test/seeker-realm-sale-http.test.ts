/** Real authenticated requests -> actual fixture quote verifier -> immutable DB recovery. */
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
const conn=connectTestDb(),db=conn.db;let app:FastifyInstance,f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>;
async function start(provider=true){const previous=process.env.MULTI_BASE_ENABLED;process.env.MULTI_BASE_ENABLED='false';try{
 app=await buildApp(TEST_CONFIG,db,{realmSalePreparationSources:provider?{connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'http-r1'}}:null});await app.ready();
}finally{if(previous===undefined)delete process.env.MULTI_BASE_ENABLED;else process.env.MULTI_BASE_ENABLED=previous;}}
async function cookies(wallet:string){await db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
beforeAll(async()=>{f=await realmSaleQuoteFixture();await start();});
afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await app.close();await conn.sql.end();});
const body=()=>({idempotencyKey:randomUUID(),spot:0,realm:0});
describe('Seeker realm sale preparation HTTP',()=>{
 it('authenticates before disabled admission and never calls RPC for an unauthenticated request',async()=>{
  const count=f.reads.length,r=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',payload:body()});expect(r.statusCode).toBe(401);expect(r.headers['cache-control']).toBe('private, no-store');
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const paused=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:await cookies(f.buyer.toBase58()),payload:body()});expect(paused.statusCode).toBe(503);expect(f.reads.length).toBe(count);
 });
 it('retains one exact actor quote and recovers it after pause, process restart and provider loss',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const request=body(),session=await cookies(f.buyer.toBase58());
  const response=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:session,payload:request});expect(response.statusCode).toBe(201);const saved=response.json();
  expect(saved.preparation).toMatchObject({wallet:f.buyer.toBase58(),spot:0,realm:0,state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false});
  await app.close();await start(false);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const count=f.reads.length;
  const replay=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:session,payload:request});expect(replay.statusCode).toBe(201);expect(replay.json()).toEqual(saved);
  const history=await app.inject({url:`/seeker/realm-sales/prepare/by-key/${request.idempotencyKey.toUpperCase()}`,cookies:session});expect(history.statusCode).toBe(200);expect(history.json()).toEqual(saved);expect(history.headers['cache-control']).toBe('private, no-store');expect(f.reads.length).toBe(count);
  const other=await app.inject({url:`/seeker/realm-sales/prepare/by-key/${request.idempotencyKey}`,cookies:await cookies(f.seller.toBase58())});expect(other.json().preparation).toBe(null);expect(other.body).not.toContain(f.buyer.toBase58());
  expect((await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:session,payload:{...request,realm:1}})).statusCode).toBe(409);
  await app.close();await start();
 });
 it('rejects caller-controlled prices, recipients, sale IDs and nonempty history queries',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const session=await cookies(f.buyer.toBase58()),request=body(),count=f.reads.length;
  for(const extra of [{priceLamports:'1'},{seller:f.buyer.toBase58()},{saleId:'01'.repeat(16)},{wallet:f.seller.toBase58()}])expect((await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:session,payload:{...request,...extra}})).statusCode).toBe(400);
  expect((await app.inject({url:`/seeker/realm-sales/prepare/by-key/${request.idempotencyKey}?wallet=x`,cookies:session})).statusCode).toBe(400);expect(f.reads.length).toBe(count);
 });
 it('distinguishes insufficient player SOL from an unavailable provider',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const before=f.controls.balance;f.controls.balance=1;
  try{const r=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:await cookies(f.buyer.toBase58()),payload:body()});expect(r.statusCode).toBe(422);expect(r.json().error.code).toBe('INSUFFICIENT_SOL');}
  finally{f.controls.balance=before;}
 });
 it('returns typed unavailable with no preparation when no reviewed source is wired',async()=>{
  await app.close();await start(false);vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const request=body(),session=await cookies(f.buyer.toBase58());
  const r=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:session,payload:request});expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe('REALM_SALE_UNAVAILABLE');
  const read=await app.inject({url:`/seeker/realm-sales/prepare/by-key/${request.idempotencyKey}`,cookies:session});expect(read.json().preparation).toBe(null);await app.close();await start();
 });
});
