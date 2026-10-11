import {randomUUID} from 'node:crypto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {buildApp} from '../src/app';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {MiningTaxClaimFailureEnvelopeSchema as schema} from '../../../packages/shared/src/miningTaxClaimFailureApi';
import {withMiningTaxFailureFixture as fixture} from './fixtures/miningTaxFailure';
import {TEST_CONFIG} from './helpers';
import {FRESH_DB_CASE_MS} from './freshDbCaseBudgets';
afterEach(()=>vi.unstubAllEnvs());
type F=Parameters<Parameters<typeof fixture>[0]>[0];
const path=(f:F)=>`/claims/mining-tax/failures/by-key/${f.key.idempotencyKey}`;
async function start(f:F){
 await runMigrations(f.conn.db);const role=`tax_failure_http_${randomUUID().replaceAll('-','')}`,password=randomUUID();
 await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};grant select on players,sessions,mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_receipts,mining_tax_claim_failures to ${role}`);
 const url=new URL(f.url);url.username=role;url.password=password;const conn=createDb(url.toString(),{max:4}),app=await buildApp(TEST_CONFIG,conn.db);
 async function cookie(wallet=f.wallet){await f.conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
 return {app,role,cookie,async close(){await app.close();await conn.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}};
}
async function persist(f:F,ordinal=0){const receipt=await f.failure(ordinal);await f.conn.sql`insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},${ordinal},${JSON.stringify(receipt)}::jsonb)`;}
describe('private read-only owner failure history',{timeout:FRESH_DB_CASE_MS},()=>{
 it.each(['claim','combined','split'] as const)('recovers %s owner evidence paused and providerless without whole-plan success',mode=>fixture(async f=>{
  await persist(f);const h=await start(f);vi.stubEnv('PHASE_E_MINING_ENABLED','false');const auth=await h.cookie();
  try{const reads=f.chain.calls.genesis;f.chain.rpc.getTransaction=async()=>{throw Error('offline');};const r=await h.app.inject({url:path(f),cookies:auth});expect(r.statusCode,r.body).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');const v=schema.parse(r.json());expect(v.recovery.status).toBe('signed');expect(v.failures).toHaveLength(1);expect(v.failures[0]).toMatchObject({transactionFailed:true,claimFinalized:false,receipt:{paymentAuthorized:false,journalClearingAuthorized:false}});expect(f.chain.calls.genesis).toBe(reads);expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);}
  finally{await h.close();}
 },{mode}));
 it('authenticates every response, isolates wallets and rejects path/query authority',()=>fixture(async f=>{
  await persist(f);const h=await start(f);try{const auth=await h.cookie(),other=await h.cookie(f.buyer),denied=await h.app.inject({url:path(f)});expect(denied.statusCode).toBe(401);expect(denied.headers['cache-control']).toBe('private, no-store');
   for(const url of [path(f)+'?wallet='+f.wallet,path(f).replace(f.key.idempotencyKey,'bad'),path(f).replace(f.key.idempotencyKey,f.key.idempotencyKey.toUpperCase())]){const r=await h.app.inject({url,cookies:auth});expect(r.statusCode,r.body).toBe(400);expect(r.headers['cache-control']).toBe('private, no-store');}
   const r=await h.app.inject({url:path(f),cookies:other});expect(r.statusCode).toBe(200);expect(schema.parse(r.json())).toMatchObject({recovery:{wallet:f.buyer,status:'unknown',preparation:null,wires:[],settlement:null},failures:[]});expect(r.body).not.toContain(f.wallet);
   const unknown=await h.app.inject({url:path(f).replace(f.key.idempotencyKey,randomUUID()),cookies:auth});expect(schema.parse(unknown.json()).failures).toEqual([]);
  }finally{await h.close();}
 }));
 it('returns unavailable on a missing receipt read instead of inventing no-failure authority',()=>fixture(async f=>{
  await persist(f);const h=await start(f);try{const auth=await h.cookie();await f.conn.sql.unsafe(`revoke select on mining_tax_claim_failures from ${h.role}`);const r=await h.app.inject({url:path(f),cookies:auth});expect(r.statusCode,r.body).toBe(503);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.json().error.code).toBe('MINING_TAX_UNAVAILABLE');expect(r.json().failures).toBeUndefined();}
  finally{await h.close();}
 }));
 it('keeps successful setup beside failed claim without claiming the complete plan finalized',()=>fixture(async f=>{
  const setup=await f.success(0);await f.conn.sql`insert into mining_tax_claim_receipts(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,${JSON.stringify(setup)}::jsonb)`;await persist(f,1);const h=await start(f);try{const r=await h.app.inject({url:path(f),cookies:await h.cookie()});expect(r.statusCode,r.body).toBe(200);expect(schema.parse(r.json())).toMatchObject({recovery:{status:'setup',settlement:{claimFinalized:false}},failures:[{ordinal:1,claimFinalized:false}]});}finally{await h.close();}
 },{mode:'split'}));
});
