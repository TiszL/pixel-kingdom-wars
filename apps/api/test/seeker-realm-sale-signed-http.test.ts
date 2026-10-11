/** Original signed consent survives delivery loss; retaining it never broadcasts. */
import {randomUUID} from 'node:crypto';
import {Keypair,Message,VersionedTransaction} from '@solana/web3.js';
import type {FastifyInstance} from 'fastify';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
import * as settlement from '../src/seeker/realmSaleSettlement';
const conn=connectTestDb(),db=conn.db;let app:FastifyInstance,f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>;
async function start(provider=true){const old=process.env.MULTI_BASE_ENABLED;process.env.MULTI_BASE_ENABLED='false';try{app=await buildApp(TEST_CONFIG,db,{realmSalePreparationSources:provider?{connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'signed-http-r1'}}:null});await app.ready();}finally{if(old===undefined)delete process.env.MULTI_BASE_ENABLED;else process.env.MULTI_BASE_ENABLED=old;}}
async function cookies(wallet:string){await db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
beforeAll(async()=>{f=await realmSaleQuoteFixture();await start();});afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await app.close();await conn.sql.end();});
async function prepared(){vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const idempotencyKey=randomUUID(),session=await cookies(f.buyer.toBase58());const response=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:session,payload:{idempotencyKey,spot:0,realm:0}});expect(response.statusCode).toBe(201);
 const preparation=response.json().preparation,tx=new VersionedTransaction(Message.from(Buffer.from(preparation.quote.messageHex,'hex')));tx.sign([Keypair.fromSeed(Buffer.alloc(32,1))]);return {idempotencyKey,session,preparation,wire:Buffer.from(tx.serialize()),payload:{idempotencyKey,signedTransaction:Buffer.from(tx.serialize()).toString('base64')}};}
const post=(p:Awaited<ReturnType<typeof prepared>>,payload:object=p.payload)=>app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies:p.session,payload});
describe('realm sale exact signed retention HTTP',()=>{
 it('requires authentication for retention and original history',async()=>{for(const req of [{method:'POST' as const,url:'/seeker/realm-sales/submit',payload:{idempotencyKey:randomUUID(),signedTransaction:'AA=='}},{url:`/seeker/realm-sales/by-key/${randomUUID()}`}]){const r=await app.inject(req);expect(r.statusCode).toBe(401);expect(r.headers['cache-control']).toBe('private, no-store');}});
 it('recovers exactly one signed request after pause/restart/provider loss without broadcasting or claiming settlement',async()=>{
  const p=await prepared(),count=f.reads.length;vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const saved=await post(p);expect(saved.statusCode).toBe(202);expect(saved.json()).toMatchObject({wallet:f.buyer.toBase58(),idempotencyKey:p.idempotencyKey,delivery:'held',reason:'DELIVERY_UNAVAILABLE',wire:{signedTransactionHex:p.wire.toString('hex'),relayAuthorized:false,currentSigningAuthorized:false}});expect(f.reads.length).toBe(count);
  await app.close();await start(false);expect((await post(p)).json()).toEqual(saved.json());
  const r=await app.inject({url:`/seeker/realm-sales/by-key/${p.idempotencyKey.toUpperCase()}`,cookies:p.session});expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.json()).toMatchObject({wallet:f.buyer.toBase58(),idempotencyKey:p.idempotencyKey,preparation:p.preparation,wire:saved.json().wire});
  expect(await conn.sql`select signature from seeker_realm_sale_signed_wires where wallet=${f.buyer.toBase58()} and idempotency_key=${p.idempotencyKey}`).toHaveLength(1);expect(f.reads.length).toBe(count);await app.close();await start();
 });
 it('returns the committed original wire when subsequent receipt recovery is unavailable',async()=>{
  const p=await prepared(),lookup=vi.spyOn(settlement,'getRealmSaleSettlement').mockRejectedValueOnce(Error('receipt unavailable'));
  try{const r=await post(p);expect(r.statusCode).toBe(202);expect(r.json()).toMatchObject({wallet:f.buyer.toBase58(),idempotencyKey:p.idempotencyKey,delivery:'held',reason:'SOURCE_UNAVAILABLE',wire:{signedTransactionHex:p.wire.toString('hex')}});}
  finally{lookup.mockRestore();}
  const r=await app.inject({url:`/seeker/realm-sales/by-key/${p.idempotencyKey}`,cookies:p.session});expect(r.json().wire.signedTransactionHex).toBe(p.wire.toString('hex'));
 });
 it('keeps another wallet isolated and refuses caller authority, altered bytes and noncanonical base64',async()=>{
  const p=await prepared(),saved=await post(p);expect(saved.statusCode).toBe(202);const bad=Buffer.from(p.wire);bad[10]=bad[10]!^1;
  for(const signedTransaction of [bad.toString('base64'),p.payload.signedTransaction+'\n','A'.repeat(2000)])expect([400,422]).toContain((await post(p,{...p.payload,signedTransaction})).statusCode);
  expect((await post(p,{...p.payload,relayAuthorized:true})).statusCode).toBe(400);
  const other=await cookies(f.seller.toBase58());const foreign=await app.inject({url:`/seeker/realm-sales/by-key/${p.idempotencyKey}`,cookies:other});expect(foreign.json()).toMatchObject({wallet:f.seller.toBase58(),preparation:null,wire:null});expect(foreign.body).not.toContain(f.buyer.toBase58());
  expect((await app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies:other,payload:p.payload})).statusCode).toBe(404);expect((await post(p)).json()).toEqual(saved.json());
 });
});
