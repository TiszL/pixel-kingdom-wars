/** A recovered quote never restarts its clock. Review measures current authority
 * against the same immutable consent and has no signer or transport. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
import type {RealmSalePreparation} from '../src/seeker/realmSalePreparationStore';
const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>vi.unstubAllEnvs());
async function fixture(run:(x:{app:Awaited<ReturnType<typeof buildApp>>;f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>;cookies:Record<string,string>;key:string;p:RealmSalePreparation})=>Promise<void>){
 vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');const f=await realmSaleQuoteFixture(),wallet=f.buyer.toBase58(),key=randomUUID(),app=await buildApp(TEST_CONFIG,conn.db,{realmSalePreparationSources:{connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'review-r1'}}});
 try{await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};
  const r=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies,payload:{idempotencyKey:key,spot:0,realm:0}});expect(r.statusCode).toBe(201);await run({app,f,cookies,key,p:r.json().preparation});
 }finally{await app.close();}
}
describe('current original purchase review HTTP',()=>{
 it('returns current Clock and original deadline without changing saved consent',async()=>fixture(async({app,f,cookies,key,p})=>{
  f.controls.now+=10n;f.controls.slot++;const r=await app.inject({url:`/seeker/realm-sales/review/by-key/${key}`,cookies});expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');
  expect(r.json()).toMatchObject({wallet:p.wallet,idempotencyKey:key,saleId:p.saleId,messageSha256:p.quote.messageSha256,sourceRevision:p.source.revision,unixTimestamp:f.controls.now.toString(),validUntil:p.terms.validUntil,admissionEligible:true,signingAuthorized:false,paymentAuthorized:false,submissionAuthorized:false,reservation:false});
  expect(r.json().bracketSlot).toBe(f.controls.slot);expect(r.json().requiredLamports).toBe(p.quote.requiredLamports);
  const saved=await app.inject({url:`/seeker/realm-sales/prepare/by-key/${key}`,cookies});expect(saved.json().preparation).toEqual(p);expect(await conn.sql`select signature from seeker_realm_sale_signed_wires where idempotency_key=${key}`).toHaveLength(0);
 }));
 it('holds paused, changed and expired authority while historical recovery still works',async()=>fixture(async({app,f,cookies,key,p})=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');expect((await app.inject({url:`/seeker/realm-sales/review/by-key/${key}`,cookies})).statusCode).toBe(503);
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');f.controls.now=BigInt(p.terms.validUntil)+1n;expect((await app.inject({url:`/seeker/realm-sales/review/by-key/${key}`,cookies})).statusCode).toBe(409);
  const saved=await app.inject({url:`/seeker/realm-sales/prepare/by-key/${key}`,cookies});expect(saved.json().preparation).toEqual(p);
 }));
 it('requires authentication, original actor/key and an empty query',async()=>fixture(async({app,f,cookies,key})=>{
  expect((await app.inject({url:`/seeker/realm-sales/review/by-key/${key}`})).statusCode).toBe(401);
  expect((await app.inject({url:`/seeker/realm-sales/review/by-key/${key}?wallet=${f.seller.toBase58()}`,cookies})).statusCode).toBe(400);
  expect((await app.inject({url:`/seeker/realm-sales/review/by-key/${randomUUID()}`,cookies})).statusCode).toBe(404);
 }));
});
