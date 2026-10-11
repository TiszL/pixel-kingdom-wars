import {randomUUID} from 'node:crypto';
import type {InjectOptions} from 'fastify';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {MiningTaxClaimContinuationEnvelopeSchema as schema} from '@shardkeep/shared/miningTaxClaimContinuationApi';
import {buildApp} from '../src/app';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {withMiningTaxContinuationFixture as fixture} from './fixtures/miningTaxContinuation';
import {TEST_CONFIG} from './helpers';
import {FRESH_DB_CASE_MS} from './freshDbCaseBudgets';
type F=Parameters<Parameters<typeof fixture>[0]>[0];
afterEach(()=>vi.unstubAllEnvs());
const post=(f:F)=>`/claims/mining-tax/continue/${f.parentKey}`,get=(f:F)=>`/claims/mining-tax/continuations/by-key/${f.parentKey}`;
async function runtime(f:F){
 await runMigrations(f.conn.db);const role=`tax_continue_http_${randomUUID().replaceAll('-','')}`,password=randomUUID();await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};grant select on all tables in schema public to ${role};grant insert on mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_continuations to ${role};grant execute on function public.shardkeep_mining_tax_continuation_lock(uuid) to ${role}`);
 const url=new URL(f.url);url.username=role;url.password=password;const conn=createDb(url.toString());let app=await buildApp(TEST_CONFIG,conn.db,{miningTaxPreparationSources:f.sources});
 const cookie=async(wallet=f.wallet)=>{await f.conn.db.insert(players).values({wallet}).onConflictDoNothing();const [session]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};};
 return {role,cookie,request:(input:InjectOptions)=>app.inject(input),async restart(){await app.close();app=await buildApp(TEST_CONFIG,conn.db);},async close(){await app.close();await conn.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}};
}
describe('authenticated explicit tax continuation',{timeout:FRESH_DB_CASE_MS},()=>{
 it('creates a linked unsigned child and recovers it paused/providerless without erasing late custody',()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');const h=await runtime(f),cookies=await h.cookie(),headers={origin:TEST_CONFIG.WEB_ORIGIN[0]!};try{
   const response=await h.request({method:'POST',url:post(f),cookies,headers,payload:f.request});expect(response.statusCode,response.body).toBe(201);const saved=schema.parse(response.json());expect(saved).toMatchObject({status:'continued',continuation:{childPreparation:{idempotencyKey:f.request.idempotencyKey,caps:f.request.caps},currentSigningAuthorized:false,journalClearingAuthorized:false}});
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');await h.restart();const reads=f.calls.connect;const recovered=await h.request({url:get(f),cookies});expect(recovered.statusCode,recovered.body).toBe(200);expect(schema.parse(recovered.json()).continuation).toEqual(saved.continuation);expect(recovered.headers['cache-control']).toBe('private, no-store');expect((await h.request({method:'POST',url:post(f),cookies,headers,payload:f.request})).statusCode).toBe(201);
   const late=await h.request({method:'POST',url:'/claims/mining-tax/submit',cookies,headers,payload:{idempotencyKey:f.parentKey,signedTransaction:Buffer.from(f.wire(1)).toString('base64')}});expect(late.statusCode,late.body).toBe(202);expect(late.json()).toMatchObject({delivery:'held',reason:'CONTINUED',wire:{ordinal:1,signedTransactionHex:Buffer.from(f.wire(1)).toString('hex')}});expect(f.calls.connect).toBe(reads);
  }finally{await h.close();}
 }));
 it('requires authenticated ownership and rejects extra path/query/body authority',()=>fixture(async f=>{
  const h=await runtime(f),cookies=await h.cookie(),other=await h.cookie(f.buyer),headers={origin:TEST_CONFIG.WEB_ORIGIN[0]!};try{
   for(const input of [{url:get(f)},{method:'POST' as const,url:post(f),payload:f.request}]){const denied=await h.request(input);expect(denied.statusCode).toBe(401);expect(denied.headers['cache-control']).toBe('private, no-store');}
   for(const url of [get(f)+'?wallet='+f.buyer,get(f).replace(f.parentKey,'bad'),get(f).replace(f.parentKey,f.parentKey.toUpperCase())])expect((await h.request({url,cookies})).statusCode).toBe(400);
   for(const extra of [{wallet:f.buyer},{parentClaimId:f.record.artifact.claimId},{setupReceipt:f.setup},{signingAuthorized:true}])expect((await h.request({method:'POST',url:post(f),cookies,headers,payload:{...f.request,...extra}})).statusCode).toBe(400);
   expect(schema.parse((await h.request({url:get(f),cookies:other})).json())).toMatchObject({wallet:f.buyer,status:'unknown',continuation:null});
  }finally{await h.close();}
 }));
 it('holds unavailable reads and paused new requests while preserving an existing link',()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const h=await runtime(f),cookies=await h.cookie(),headers={origin:TEST_CONFIG.WEB_ORIGIN[0]!};try{
   const before=f.calls.connect,paused=await h.request({method:'POST',url:post(f),cookies,headers,payload:f.request});expect(paused.statusCode,paused.body).toBe(503);expect(paused.json().error.code).toBe('PHASE_E_DISABLED');expect(f.calls.connect).toBe(before);vi.stubEnv('PHASE_E_MINING_ENABLED','true');
   expect((await h.request({method:'POST',url:post(f),cookies,headers,payload:f.request})).statusCode).toBe(201);
   const conflict=await h.request({method:'POST',url:post(f),cookies,headers,payload:{...f.request,idempotencyKey:randomUUID()}});expect(conflict.statusCode).toBe(409);
   await f.conn.sql.unsafe(`revoke select on mining_tax_claim_continuations from ${h.role}`);const unknown=await h.request({url:get(f),cookies});expect(unknown.statusCode).toBe(503);expect(unknown.json().error.code).toBe('MINING_TAX_UNAVAILABLE');expect(unknown.json().continuation).toBeUndefined();expect(unknown.headers['cache-control']).toBe('private, no-store');
  }finally{await h.close();}
 }));
});
