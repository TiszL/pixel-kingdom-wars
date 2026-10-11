/** HTTP recovery consumes owner-verified success, never caller-provided finality. */
import type {FastifyInstance} from 'fastify';
import {Keypair} from '@solana/web3.js';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
import {retainRealmSaleSettlementFixture} from './fixtures/realmSaleSettlement';
import {createRealmSaleSettlement} from '../src/seeker/realmSaleSettlement';
const conn=connectTestDb(),db=conn.db;let app:FastifyInstance;
async function start(){const old=process.env.MULTI_BASE_ENABLED;process.env.MULTI_BASE_ENABLED='false';try{app=await buildApp(TEST_CONFIG,db);await app.ready();}finally{if(old===undefined)delete process.env.MULTI_BASE_ENABLED;else process.env.MULTI_BASE_ENABLED=old;}}
async function cookies(wallet:string){await db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
beforeAll(start);afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await app.close();await conn.sql.end();});
describe('finalized original realm sale HTTP recovery',()=>{
 it('exposes only verified own success after restart, expiry and pause without a provider or second payment',async()=>{
  const f=await retainRealmSaleSettlementFixture(db),session=await cookies(f.key.wallet),url=`/seeker/realm-sales/by-key/${f.key.idempotencyKey}`;
  expect((await app.inject({url,cookies:session})).json().settlement).toBe(null);
  const connect=vi.fn(()=>f.chain.rpc),settled=await createRealmSaleSettlement(db,{connect,trust:f.chain.trust})(f.key);expect(settled.purchaseFinalized).toBe(true);expect(connect).toHaveBeenCalledOnce();
  f.chain.rpc.getGenesisHash=async()=>{throw Error('offline');};vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();await start();
  const r=await app.inject({url,cookies:session});expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.json().settlement).toEqual(settled);
  const replay=await app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies:session,payload:{idempotencyKey:f.key.idempotencyKey,signedTransaction:Buffer.from(f.chain.expected.signedTransaction).toString('base64')}});
  expect(replay.statusCode).toBe(200);expect(replay.json()).toMatchObject({delivery:'settled',settlement:settled});expect(connect).toHaveBeenCalledOnce();
  const foreign=await app.inject({url,cookies:await cookies(Keypair.generate().publicKey.toBase58())});expect(foreign.json()).toMatchObject({preparation:null,wire:null,settlement:null});expect(foreign.body).not.toContain(f.chain.signature);
 });
});
