/** Real authenticated SELECT-only review; a later explicit submit owns custody. */
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {TWOFA} from '@shardkeep/shared';
import {MiningTaxClaimReviewResponseSchema as Schema,validateMiningTaxClaimCurrentReview} from '@shardkeep/shared/miningTaxClaimReviewApi';
import {buildApp,type AppDeps} from '../src/app';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import * as reviews from '../src/mining/taxClaimReview';
import {acceptMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import {withMiningTaxAdmissionFixture as fixture,type MiningTaxAdmissionFixture} from './fixtures/miningTaxAdmission';
import {TEST_CONFIG} from './helpers';
import {FRESH_DB_CASE_MS} from './freshDbCaseBudgets';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const active=()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');vi.stubEnv('MULTI_BASE_ENABLED','false');};
const path=(f:MiningTaxAdmissionFixture,ordinal=0)=>`/claims/mining-tax/review/by-key/${f.key.idempotencyKey}/${ordinal}`;
async function runtime(f:MiningTaxAdmissionFixture){
 await runMigrations(f.conn.db);const role=`tax_review_http_${randomUUID().replaceAll('-','')}`,password=randomUUID();
 await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};grant select on players,sessions,mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_receipts,mining_tax_claim_failures,mining_tax_claim_continuations to ${role}`);
 const url=new URL(f.url);url.username=role;url.password=password;const conn=createDb(url.toString(),{max:4});
 return {...conn,role,async close(){await conn.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}};
}
async function cookies(f:MiningTaxAdmissionFixture,wallet=f.wallet){await f.conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
const appFor=(conn:Awaited<ReturnType<typeof runtime>>,deps:AppDeps={})=>buildApp(TEST_CONFIG,conn.db,deps);
describe('authenticated unsigned KEEP tax review HTTP',{timeout:FRESH_DB_CASE_MS},()=>{
 it('reviews before a signature, then leaves delivery to one explicit POST and history GET to DB-only recovery',()=>fixture(async f=>{
  active();const conn=await runtime(f),auth=await cookies(f);let sends=0,transportReads=0;
  const app=await appFor(conn,{miningTaxPreparationSources:f.sources,miningTaxRelaySources:{admission:f.sources,transport:()=>({getGenesisHash:async()=>{transportReads++;return f.record.artifact.source.genesisHash;},
   getSignatureStatuses:async()=>({context:{slot:f.control.slot},value:[null]}),getBlockHeight:async()=>f.control.height,sendRawTransaction:async bytes=>{sends++;expect(Buffer.from(bytes)).toEqual(Buffer.from(f.wire()));return f.chain.txs[0]!.transaction.signatures[0]!;}})}});
  try{
   const r=await app.inject({url:path(f),cookies:auth});expect(r.statusCode,r.body).toBe(200);const result=validateMiningTaxClaimCurrentReview(f.record.artifact,r.json());expect(result).toMatchObject({status:'ready',review:{blockhash:f.record.artifact.blockhash,currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false},serverNow:f.control.now.toISOString()});
   expect(r.headers['cache-control']).toBe('private, no-store');expect(transportReads).toBe(0);expect(sends).toBe(0);expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(0);expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);expect(await f.conn.sql`select * from mining_tax_claim_preparations`).toHaveLength(1);
   await f.conn.sql.unsafe(`grant insert on mining_tax_claim_signed_wires to ${conn.role}`);
   const submit=await app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers:{origin:TEST_CONFIG.WEB_ORIGIN[0]!},payload:{idempotencyKey:f.key.idempotencyKey,signedTransaction:Buffer.from(f.wire()).toString('base64')}});
   expect(submit.statusCode,submit.body).toBe(202);expect(submit.json().delivery).toBe('submitted');expect(sends).toBe(1);
   const before={connect:f.calls.connect,transportReads,sends};vi.stubEnv('PHASE_E_MINING_ENABLED','false');const saved=await app.inject({url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`,cookies:auth});expect(saved.json().status).toBe('signed');expect({connect:f.calls.connect,transportReads,sends}).toEqual(before);
  }finally{await app.close();await conn.close();}
 },{persistSigned:false}));
 it('authenticates, rejects path/query authority, isolates wallets and declares the sensitive rate bound',()=>fixture(async f=>{
  active();const conn=await runtime(f),auth=await cookies(f),foreign=await cookies(f,f.buyer),app=await appFor(conn,{miningTaxPreparationSources:f.sources});let rate:unknown;
  app.addHook('onRequest',async req=>{if(req.routeOptions.url?.includes('/claims/mining-tax/review/'))rate=req.routeOptions.config.rateLimit;});
  try{
   const unauthorized=await app.inject({url:path(f)});expect(unauthorized.statusCode,unauthorized.body).toBe(401);expect(unauthorized.headers['cache-control']).toBe('private, no-store');
   for(const url of [path(f)+'?signingAuthorized=true',path(f).slice(0,-1)+'01',path(f).slice(0,-1)+'2',path(f).replace(f.key.idempotencyKey,'bad'),path(f).replace(f.key.idempotencyKey,f.key.idempotencyKey.toUpperCase())]){
    const r=await app.inject({url,cookies:auth});expect(r.statusCode,r.body).toBe(400);expect(r.headers['cache-control']).toBe('private, no-store');
   }
   expect(rate).toEqual({max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000});
   const other=await app.inject({url:path(f),cookies:foreign});expect(other.statusCode,other.body).toBe(200);expect(Schema.parse(other.json())).toMatchObject({wallet:f.buyer,status:'unavailable',review:null,reason:'NOT_PREPARED'});expect(other.body).not.toContain(f.wallet);expect(f.calls.connect).toBe(0);
  }finally{await app.close();await conn.close();}
 },{persistSigned:false}));
 it('returns unavailable for missing consent, absent provider and paused claims without a write or RPC',()=>fixture(async f=>{
  active();const conn=await runtime(f),auth=await cookies(f),app=await appFor(conn);
  try{
   const get=(url:string)=>app.inject({url,cookies:auth});const missing=await get(path(f).replace(f.key.idempotencyKey,randomUUID()));expect(missing.statusCode).toBe(200);expect(Schema.parse(missing.json())).toMatchObject({status:'unavailable',reason:'NOT_PREPARED',review:null});
   const unavailable=await get(path(f));expect(Schema.parse(unavailable.json())).toMatchObject({status:'unavailable',reason:'PROVIDER_UNAVAILABLE',review:null});
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');const paused=await get(path(f));expect(Schema.parse(paused.json())).toMatchObject({status:'unavailable',reason:'DISABLED'});expect(paused.headers['cache-control']).toBe('private, no-store');
   expect(f.calls.connect).toBe(0);expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(0);expect(await f.conn.sql`select * from mining_tax_claim_preparations`).toHaveLength(1);
  }finally{await app.close();await conn.close();}
 },{persistSigned:false}));
 it('can use relay admission sources for review without constructing or calling the transport',()=>fixture(async f=>{
  active();const conn=await runtime(f),auth=await cookies(f),app=await appFor(conn,{miningTaxRelaySources:{admission:f.sources,transport:()=>{throw Error('review must never access relay');}}});
  try{const r=await app.inject({url:path(f),cookies:auth});expect(r.statusCode,r.body).toBe(200);expect(validateMiningTaxClaimCurrentReview(f.record.artifact,r.json()).status).toBe('ready');}
  finally{await app.close();await conn.close();}
 },{persistSigned:false}));
 it('reviews ordinal1 only after actual owner-verified setup and retains the unsigned claim',()=>fixture(async f=>{
  active();const conn=await runtime(f),auth=await cookies(f),app=await appFor(conn,{miningTaxPreparationSources:f.sources});
  try{
   await f.stage('setup');let r=await app.inject({url:path(f,1),cookies:auth});expect(Schema.parse(r.json())).toMatchObject({status:'unavailable',reason:'SETUP_REQUIRED',review:null});
   await acceptMiningTaxClaimSigned(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey,signedTransaction:f.wire(0)});await f.verifySetup(6);f.control.fee=4;
   r=await app.inject({url:path(f,1),cookies:auth});expect(r.statusCode,r.body).toBe(200);expect(validateMiningTaxClaimCurrentReview(f.record.artifact,r.json())).toMatchObject({status:'ready',ordinal:1,review:{paidFeeLamports:'6',paidRentLamports:'1000',feeLamports:'4',rentLamports:'0',totalLamports:'4'}});
   expect(await f.conn.sql`select ordinal from mining_tax_claim_signed_wires`).toEqual([{ordinal:0}]);
  }finally{await app.close();await conn.close();}
 },{mode:'split',persistSigned:false}));
 it.each(['pause','expiry'] as const)('holds %s after the original-packet RPC await',kind=>fixture(async f=>{
  active();const conn=await runtime(f),auth=await cookies(f),app=await appFor(conn,{miningTaxPreparationSources:f.sources});f.control.afterFee=async message=>{if(Buffer.from(message.serialize()).toString('hex')===f.record.artifact.transactions[0]!.messageHex){if(kind==='pause')vi.stubEnv('PHASE_E_MINING_ENABLED','false');else f.control.now=new Date(f.record.artifact.expiresAt);}};
  try{const r=await app.inject({url:path(f),cookies:auth});expect(r.statusCode,r.body).toBe(200);expect(Schema.parse(r.json())).toMatchObject({status:'unavailable',review:null,reason:kind==='pause'?'DISABLED':'EXPIRED'});expect(r.headers['cache-control']).toBe('private, no-store');expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(0);}
  finally{await app.close();await conn.close();}
 },{persistSigned:false}));
 it('holds unavailable providers, invalid clocks and storage errors without exposing their private error text',()=>fixture(async f=>{
  active();const conn=await runtime(f),auth=await cookies(f);
  for(const sources of [{...f.sources,connect:()=>{throw Error('secret-provider-credential');}},{...f.sources,now:()=>new Date(Number.NaN)}]){
   const app=await appFor(conn,{miningTaxPreparationSources:sources});try{const r=await app.inject({url:path(f),cookies:auth});expect(r.statusCode,r.body).toBe(200);expect(Schema.parse(r.json())).toMatchObject({status:'unavailable',review:null});expect(r.body).not.toContain('secret-provider-credential');expect(r.headers['cache-control']).toBe('private, no-store');}finally{await app.close();}
  }
  const app=await appFor(conn,{miningTaxPreparationSources:f.sources});try{await f.conn.sql.unsafe(`revoke select on mining_tax_claim_preparations from ${conn.role}`);const r=await app.inject({url:path(f),cookies:auth});expect(r.statusCode,r.body).toBe(200);expect(Schema.parse(r.json())).toMatchObject({status:'unavailable',review:null});expect(r.body).not.toContain('permission denied');expect(r.headers['cache-control']).toBe('private, no-store');}
  finally{await app.close();await conn.close();}
 },{persistSigned:false}));
 it('holds a response clock that regresses after the final successful service observation',()=>fixture(async f=>{
  active();const conn=await runtime(f),auth=await cookies(f);let reviewed=false;
  // Regress only after the real assessment has returned. A count of its clock
  // reads couples this route-boundary test to newly added service guard awaits.
  const create=reviews.createMiningTaxClaimReview;vi.spyOn(reviews,'createMiningTaxClaimReview').mockImplementation((...args)=>{const read=create(...args);return async input=>{const result=await read(input);reviewed=true;return result;};});
  const app=await appFor(conn,{miningTaxPreparationSources:{...f.sources,now:()=>new Date(+f.control.now-(reviewed?1000:0))}});
  try{const r=await app.inject({url:path(f),cookies:auth});expect(r.statusCode,r.body).toBe(200);expect(reviewed).toBe(true);expect(Schema.parse(r.json())).toMatchObject({status:'unavailable',reason:'SOURCE_CONFLICT',review:null});expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(0);}
  finally{await app.close();await conn.close();}
 },{persistSigned:false}));
});
