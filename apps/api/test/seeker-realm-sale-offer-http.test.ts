import type {FastifyInstance} from 'fastify';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
const conn=connectTestDb(),db=conn.db;let app:FastifyInstance,f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>;
async function start(provider=true){app=await buildApp(TEST_CONFIG,db,{realmSalePreparationSources:provider?{connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'http-offer-r1'}}:null});await app.ready();}
async function cookies(wallet:string){await db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
beforeAll(async()=>{f=await realmSaleQuoteFixture();await start();});afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await app.close();await conn.sql.end();});
describe('authenticated realm sale observations',()=>{
 it('authenticates before provider work and prevents all caching',async()=>{
  const before=f.reads.length;for(const url of ['/seeker/realm-sales/offer?spot=0&realm=0','/seeker/realm-sales/coverage?realm=0']){const r=await app.inject({url});expect(r.statusCode).toBe(401);expect(r.headers['cache-control']).toBe('private, no-store');}expect(f.reads.length).toBe(before);
 });
 it('rejects caller trust, wallet and noncanonical selectors before RPC',async()=>{
  const session=await cookies(f.buyer.toBase58()),before=f.reads.length;
  for(const query of ['spot=00&realm=0','spot=100&realm=0','spot=0&realm=0&wallet=x','spot=0&realm=0&source=x','spot=0&spot=1&realm=0']){const r=await app.inject({url:`/seeker/realm-sales/offer?${query}`,cookies:session});expect(r.statusCode).toBe(400);expect(r.headers['cache-control']).toBe('private, no-store');}expect(f.reads.length).toBe(before);
 });
 it('binds real offers and paused coverage to each session without writing sale records',async()=>{
  const before=await conn.sql`select (select count(*) from seeker_realm_sale_preparations) as p,(select count(*) from seeker_realm_sale_signed_wires) as w,(select count(*) from seeker_realm_sale_receipts) as r`;
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const session=await cookies(f.buyer.toBase58()),r=await app.inject({url:'/seeker/realm-sales/offer?spot=0&realm=0',cookies:session});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({wallet:f.buyer.toBase58(),status:'available',authorization:'none'});expect(r.headers['cache-control']).toBe('private, no-store');
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const paused=await app.inject({url:'/seeker/realm-sales/offer?spot=0&realm=0',cookies:session});expect(paused.json()).toMatchObject({status:'blocked',reason:'PAUSED',offer:null});
  const other=await app.inject({url:'/seeker/realm-sales/coverage?realm=0',cookies:await cookies(f.seller.toBase58())});expect(other.json()).toMatchObject({wallet:f.seller.toBase58(),status:'observed',coverage:{accountState:'absent'}});expect(other.body).not.toContain(f.buyer.toBase58());
  expect(await conn.sql`select (select count(*) from seeker_realm_sale_preparations) as p,(select count(*) from seeker_realm_sale_signed_wires) as w,(select count(*) from seeker_realm_sale_receipts) as r`).toEqual(before);
 });
 it('does not invent absence when no reviewed source is wired',async()=>{
  await app.close();await start(false);vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const session=await cookies(f.buyer.toBase58());
  for(const [url,field] of [['/seeker/realm-sales/offer?spot=0&realm=0','offer'],['/seeker/realm-sales/coverage?realm=0','coverage']] as const){const r=await app.inject({url,cookies:session});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({status:'unavailable',[field]:null,authorization:'none'});}
 });
});
