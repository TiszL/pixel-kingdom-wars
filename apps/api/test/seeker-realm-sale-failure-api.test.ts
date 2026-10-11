/** Actual original custody and owner proof through authenticated read-only HTTP. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {retainRealmSaleSettlementFixture} from './fixtures/realmSaleSettlement';
import * as failures from '../src/seeker/realmSaleFailure';
import {getRealmSaleSigned} from '../src/seeker/realmSaleSignedStore';
const conn=resourceClaimsDatabase();let app:Awaited<ReturnType<typeof buildApp>>;
async function start(){vi.stubEnv('MULTI_BASE_ENABLED','false');app=await buildApp(TEST_CONFIG,conn.db);await app.ready();}
async function cookies(wallet:string){await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
async function fixture(persist=true){const f=await retainRealmSaleSettlementFixture(conn.db),m=f.chain.transaction.meta!;m.err={InstructionError:[0,{Custom:9}]};m.postBalances=m.preBalances.map((n,i)=>n-(i===0?m.fee:0));const session=await cookies(f.key.wallet),failure=persist?await failures.createRealmSaleFailure(conn.db,{connect:()=>f.chain.rpc,trust:f.chain.trust})(f.key):null;return {...f,session,failure,url:`/seeker/realm-sales/failures/by-key/${f.key.idempotencyKey}`};}
beforeAll(async()=>{await conn.setup();await start();});afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});afterAll(async()=>{await app.close();await conn.close();});
describe('private original realm failure API',()=>{
 it('returns exact owner evidence after pause/restart/provider loss without widening Saved or creating a writer',async()=>{
  const f=await fixture(),wire=(await getRealmSaleSigned(conn.db,f.key))!.wire!;
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();await start();const writer=vi.spyOn(failures,'createRealmSaleFailure').mockImplementation(()=>{throw Error('HTTP cannot acquire proof writer');});
  const response=await app.inject({url:f.url,cookies:f.session});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');expect(response.json()).toEqual({...f.key,failure:f.failure});expect(writer).not.toHaveBeenCalled();
  const saved=await app.inject({url:`/seeker/realm-sales/by-key/${f.key.idempotencyKey}`,cookies:f.session});expect(Object.keys(saved.json()).sort()).toEqual(['idempotencyKey','preparation','settlement','wallet','wire']);expect(saved.json().wire).toEqual(wire);expect(saved.json().settlement).toBeNull();
 });
 it('authenticates and rejects noncanonical paths and unexpected query authority',async()=>{
  const f=await fixture();expect((await app.inject({url:f.url})).statusCode).toBe(401);
  for(const url of [f.url+'?wallet='+f.key.wallet,f.url+'?relay=true',f.url.replace(f.key.idempotencyKey,f.key.idempotencyKey.toUpperCase())])expect((await app.inject({url,cookies:f.session})).statusCode).toBe(400);
 });
 it('returns explicit null for absent or foreign history without exposing original signatures',async()=>{
  const f=await fixture(false);expect((await app.inject({url:f.url,cookies:f.session})).json()).toEqual({...f.key,failure:null});
  const wallet=Keypair.generate().publicKey.toBase58(),foreign=await app.inject({url:f.url,cookies:await cookies(wallet)});expect(foreign.statusCode).toBe(200);expect(foreign.json()).toEqual({wallet,idempotencyKey:f.key.idempotencyKey,failure:null});expect(foreign.body).not.toContain(f.chain.signature);
  const key=randomUUID();expect((await app.inject({url:`/seeker/realm-sales/failures/by-key/${key}`,cookies:f.session})).json()).toEqual({wallet:f.key.wallet,idempotencyKey:key,failure:null});
 });
 it('holds a read outage rather than manufacturing absent failure evidence',async()=>{
  const f=await fixture();vi.spyOn(failures,'getRealmSaleFailure').mockRejectedValueOnce(Error('storage unavailable'));const response=await app.inject({url:f.url,cookies:f.session});expect(response.statusCode).toBe(503);expect(response.headers['cache-control']).toBe('private, no-store');expect(response.json()).not.toHaveProperty('failure');
 });
 it('retains late signed custody and acknowledges saved failure without relay or proof replacement',async()=>{
  const f=await fixture();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const response=await app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies:f.session,payload:{idempotencyKey:f.key.idempotencyKey,signedTransaction:Buffer.from(f.chain.expected.signedTransaction).toString('base64')}});
  expect(response.statusCode).toBe(202);expect(response.json()).toMatchObject({...f.key,delivery:'held',reason:'FINALIZED_FAILURE',settlement:null,wire:{signedTransactionHex:Buffer.from(f.chain.expected.signedTransaction).toString('hex')}});expect(response.json()).not.toHaveProperty('failure');expect(await failures.getRealmSaleFailure(conn.db,f.key)).toEqual(f.failure);
 });
 it('holds review of saved failure before any configured provider, even while paused',async()=>{
  const f=await fixture();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const response=await app.inject({url:`/seeker/realm-sales/review/by-key/${f.key.idempotencyKey}`,cookies:f.session});expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:{code:'REALM_SALE_REVIEW_HELD'}});
 });
});
