/** Real authenticated runtime-role HTTP can retain packets; only the independent
 * fixture owner verifier can record finalized payment. GET never performs RPC. */
import {randomUUID} from 'node:crypto';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {MiningTaxClaimRecoveryEnvelopeSchema,MiningTaxClaimSubmitResponseSchema,MiningTaxClaimSignedWireSchema} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import {buildApp,type AppDeps} from '../src/app';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createMiningTaxClaimSettlement} from '../src/mining/taxClaimSettlement';
import {withMiningTaxAdmissionFixture as fixture,type MiningTaxAdmissionFixture} from './fixtures/miningTaxAdmission';
import {TEST_CONFIG} from './helpers';
import {SEAL_BOUND_HTTP_CASE_MS} from './sealLatencyBudgets';
afterEach(()=>vi.unstubAllEnvs());
const headers={origin:TEST_CONFIG.WEB_ORIGIN[0]!};
async function runtime(f:MiningTaxAdmissionFixture){
 await runMigrations(f.conn.db);
 const role=`tax_http_${randomUUID().replaceAll('-','')}`,password=randomUUID();
 await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};grant select on players,sessions,mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_receipts,mining_tax_claim_failures,mining_tax_claim_continuations to ${role};grant insert on mining_tax_claim_preparations,mining_tax_claim_signed_wires to ${role}`);
 const url=new URL(f.url);url.username=role;url.password=password;const conn=createDb(url.toString(),{max:4});
 return {...conn,role,async close(){await conn.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}};
}
async function cookies(f:MiningTaxAdmissionFixture,wallet=f.wallet){await f.conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
function consent(f:MiningTaxAdmissionFixture){const a=f.record.artifact;return {idempotencyKey:a.idempotencyKey,round:a.round,spot:a.spot,caps:a.caps};}
function start(conn:Awaited<ReturnType<typeof runtime>>,deps:AppDeps={}){vi.stubEnv('MULTI_BASE_ENABLED','false');return buildApp(TEST_CONFIG,conn.db,deps);}
const submitBody=(f:MiningTaxAdmissionFixture,ordinal=0)=>({idempotencyKey:f.key.idempotencyKey,signedTransaction:Buffer.from(f.wire(ordinal)).toString('base64')});
// Every case here is a full authenticated lifecycle over guarded SQL; see sealLatencyBudgets.ts.
describe('authenticated KEEP tax claims HTTP',{timeout:SEAL_BOUND_HTTP_CASE_MS},()=>{
 it('keeps exact signed custody through a lost reply, providerless restart and paused owner-verified payment',()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const conn=await runtime(f),auth=await cookies(f),app=await start(conn);let restarted;
  try{
   const prior=await app.inject({method:'POST',url:'/claims/mining-tax/prepare',cookies:auth,headers,payload:consent(f)});expect(prior.statusCode,prior.body).toBe(201);expect(prior.json().preparation).toEqual(f.record.artifact);
   const retained=await app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers,payload:submitBody(f)});expect(retained.statusCode,retained.body).toBe(202);expect(retained.json()).toMatchObject({wallet:f.wallet,idempotencyKey:f.key.idempotencyKey,claimId:f.record.artifact.claimId,delivery:'held',reason:'DELIVERY_UNAVAILABLE'});const wire=MiningTaxClaimSignedWireSchema.parse(retained.json().wire);expect(wire.signedTransactionHex).toBe(Buffer.from(f.wire()).toString('hex'));
   const signed=await app.inject({url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`,cookies:auth});expect(signed.statusCode,signed.body).toBe(200);expect(MiningTaxClaimRecoveryEnvelopeSchema.parse(signed.json())).toMatchObject({status:'signed',settlement:null,wires:[wire]});
   expect(f.calls.connect).toBe(0);await expect(conn.sql`insert into mining_tax_claim_receipts(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,'{}')`).rejects.toBeDefined();
   await f.stage('paid');await createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key);restarted=await start(conn);
   const recovered=await restarted.inject({url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`,cookies:auth});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.headers['cache-control']).toBe('private, no-store');expect(MiningTaxClaimRecoveryEnvelopeSchema.parse(recovered.json())).toMatchObject({status:'settled',settlement:{claimFinalized:true,receipt:{paidKeepBaseUnits:f.record.artifact.intended.claimBaseUnits,journalClearingAuthorized:false}}});
   const again=await restarted.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers,payload:submitBody(f)});expect(again.statusCode,again.body).toBe(200);expect(again.json().delivery).toBe('settled');expect(f.calls.connect).toBe(0);expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(1);
  }finally{await restarted?.close();await app.close();await conn.close();}
 },{persistSigned:false}));
 it('authenticates every route, isolates wallets and refuses query/body/packet authority',()=>fixture(async f=>{
  const conn=await runtime(f),auth=await cookies(f),foreign=await cookies(f,f.buyer),app=await start(conn);
  try{
   for(const req of [{method:'POST' as const,url:'/claims/mining-tax/prepare',payload:consent(f)},{url:`/claims/mining-tax/prepare/by-key/${f.key.idempotencyKey}`},{method:'POST' as const,url:'/claims/mining-tax/submit',payload:submitBody(f)},{url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`}]){const r=await app.inject(req);expect(r.statusCode,r.body).toBe(401);expect(r.headers['cache-control']).toBe('private, no-store');const query=await app.inject({...req,url:req.url+'?authority=true',cookies:auth,headers});expect(query.statusCode,query.body).toBe(400);}
   const other=await app.inject({url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`,cookies:foreign});expect(MiningTaxClaimRecoveryEnvelopeSchema.parse(other.json())).toMatchObject({wallet:f.buyer,status:'unknown',preparation:null,wires:[],settlement:null});expect(other.body).not.toContain(f.wallet);
   expect((await app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:foreign,headers,payload:submitBody(f)})).statusCode).toBe(404);
   for(const extra of [{wallet:f.buyer},{ordinal:1},{claimId:randomUUID()},{relayAuthorized:true}])expect((await app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers,payload:{...submitBody(f),...extra}})).statusCode).toBe(400);
   const damaged=Buffer.from(f.wire());damaged[10]=damaged[10]!^1;
   for(const [signedTransaction,status] of [[damaged.toString('base64'),422],[submitBody(f).signedTransaction+'\n',400],['A'.repeat(1700),400]] as const){const r=await app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers,payload:{idempotencyKey:f.key.idempotencyKey,signedTransaction}});expect(r.statusCode,r.body).toBe(status);expect(r.headers['cache-control']).toBe('private, no-store');}
   expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(0);expect(f.calls.connect).toBe(0);
  }finally{await app.close();await conn.close();}
 },{persistSigned:false}));
 it('prepares through fresh actual quote facts and preserves all original caps while paused without a provider',()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');const conn=await runtime(f),auth=await cookies(f),app=await start(conn,{miningTaxPreparationSources:f.sources});let offline;
  try{
   const payload={...consent(f),idempotencyKey:randomUUID()},r=await app.inject({method:'POST',url:'/claims/mining-tax/prepare',cookies:auth,headers,payload});expect(r.statusCode,r.body).toBe(201);const saved=r.json().preparation;expect(saved.claimId).not.toBe(f.record.artifact.claimId);expect(saved.blockhash).toBe(f.control.blockhash);expect(saved.caps).toEqual(payload.caps);
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');offline=await start(conn);const reads=f.calls.connect;
   const recovered=await offline.inject({url:`/claims/mining-tax/prepare/by-key/${payload.idempotencyKey}`,cookies:auth});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().preparation).toEqual(saved);
   expect((await offline.inject({method:'POST',url:'/claims/mining-tax/prepare',cookies:auth,headers,payload})).json().preparation).toEqual(saved);
   for(const changed of [{round:String(BigInt(payload.round)+1n)},{spot:payload.spot+1},{caps:{...payload.caps,maxFeeLamports:String(BigInt(payload.caps.maxFeeLamports)+1n)}}]){const conflict=await offline.inject({method:'POST',url:'/claims/mining-tax/prepare',cookies:auth,headers,payload:{...payload,...changed}});expect(conflict.statusCode,conflict.body).toBe(409);}
   const fresh=await offline.inject({method:'POST',url:'/claims/mining-tax/prepare',cookies:auth,headers,payload:{...payload,idempotencyKey:randomUUID()}});expect(fresh.statusCode).toBe(503);expect(fresh.json().error.code).toBe('PHASE_E_DISABLED');expect(f.calls.connect).toBe(reads);
  }finally{await offline?.close();await app.close();await conn.close();}
 }));
 it('keeps sparse ordinal1 custody nonterminal and projects verified setup then the complete final prefix',()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const conn=await runtime(f),auth=await cookies(f),app=await start(conn);
  try{
   const post=(ordinal:number)=>app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers,payload:submitBody(f,ordinal)}),get=()=>app.inject({url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`,cookies:auth});
   expect((await post(1)).statusCode).toBe(202);let state=MiningTaxClaimRecoveryEnvelopeSchema.parse((await get()).json());expect(state.status).toBe('signed');expect(state.wires.map(w=>w.ordinal)).toEqual([1]);expect(state.settlement).toBeNull();
   expect((await post(0)).statusCode).toBe(202);await f.verifySetup();state=MiningTaxClaimRecoveryEnvelopeSchema.parse((await get()).json());expect(state).toMatchObject({status:'setup',settlement:{ordinal:0,claimFinalized:false}});expect(state.wires).toHaveLength(2);
   await f.stage('paid');await createMiningTaxClaimSettlement(f.conn.db,f.options)({...f.key,ordinal:1});state=MiningTaxClaimRecoveryEnvelopeSchema.parse((await get()).json());expect(state).toMatchObject({status:'settled',settlement:{ordinal:1,claimFinalized:true}});expect(state.settlement!.receipt.transactions).toHaveLength(2);expect((await post(0)).json().delivery).toBe('settled');expect(f.calls.connect).toBe(0);
  }finally{await app.close();await conn.close();}
 },{mode:'split',persistSigned:false}));
 it('returns committed wire identity when receipt SELECT fails after custody, then recovers it by GET',()=>fixture(async f=>{
  const conn=await runtime(f),auth=await cookies(f),app=await start(conn);
  try{
   await f.conn.sql.unsafe(`revoke select on mining_tax_claim_receipts from ${conn.role}`);
   const r=await app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers,payload:submitBody(f)});expect(r.statusCode,r.body).toBe(202);expect(r.json()).toMatchObject({delivery:'held',reason:'SOURCE_UNAVAILABLE',wire:{signedTransactionHex:Buffer.from(f.wire()).toString('hex')}});
   await f.conn.sql.unsafe(`grant select on mining_tax_claim_receipts to ${conn.role}`);const recovered=await app.inject({url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`,cookies:auth});expect(MiningTaxClaimRecoveryEnvelopeSchema.parse(recovered.json())).toMatchObject({status:'signed',settlement:null});expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(1);
  }finally{await app.close();await conn.close();}
 },{persistSigned:false}));
 it('persists custody before an exact relay attempt and uses GET alone after its response is lost',()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');const conn=await runtime(f),auth=await cookies(f);let sends=0,reads=0;
  const app=await start(conn,{miningTaxPreparationSources:f.sources,miningTaxRelaySources:{admission:f.sources,transport:()=>({
   getGenesisHash:async()=>{reads++;return f.record.artifact.source.genesisHash;},getSignatureStatuses:async()=>({context:{slot:f.control.slot},value:[null]}),getBlockHeight:async()=>f.control.height,
   sendRawTransaction:async(bytes,options)=>{sends++;expect(options).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:f.control.slot});
    const saved=await f.conn.sql`select encode(signed_transaction,'hex') wire from mining_tax_claim_signed_wires where claim_id=${f.record.artifact.claimId}`;expect(saved).toHaveLength(1);expect(saved[0]!.wire).toBe(Buffer.from(bytes).toString('hex'));expect(Buffer.from(bytes)).toEqual(Buffer.from(f.wire()));throw Error('Lost relay reply');},
  })}});
  try{const response=await app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers,payload:submitBody(f)});expect(response.statusCode,response.body).toBe(202);expect(response.json()).toMatchObject({delivery:'held',reason:'SEND_UNCERTAIN'});expect(sends).toBe(1);
   const before={reads,connect:f.calls.connect};vi.stubEnv('PHASE_E_MINING_ENABLED','false');const restart=await start(conn);try{const history=await restart.inject({url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`,cookies:auth});expect(history.statusCode,history.body).toBe(200);expect(MiningTaxClaimRecoveryEnvelopeSchema.parse(history.json())).toMatchObject({status:'signed',settlement:null});}finally{await restart.close();}
   expect({reads,connect:f.calls.connect}).toEqual(before);expect(sends).toBe(1);expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
  }finally{await app.close();await conn.close();}
 },{mode:'combined',persistSigned:false}));

 it.each(['before-insert','after-insert-read','lost-insert-reply'] as const)('holds uncertain custody for %s without inventing a durable acceptance time',kind=>fixture(async f=>{
  const conn=await runtime(f),auth=await cookies(f),execute=conn.db.execute.bind(conn.db);let armed=true,inserted=false;
  const proxy=new Proxy(conn.db,{get(target,name,receiver){if(name!=='execute')return Reflect.get(target,name,receiver);return async(query:SQL)=>{
   const insert=new PgDialect().sqlToQuery(query).sql.startsWith('insert into mining_tax_claim_signed_wires');
   if(armed&&(kind==='before-insert'&&insert||kind==='after-insert-read'&&inserted))throw Error('Unavailable custody storage');
   const result=await execute(query);if(insert){inserted=true;if(armed&&kind==='lost-insert-reply')throw Error('Lost INSERT acknowledgement');}return result;
  };}}),app=await start({...conn,db:proxy});
  try{const r=await app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:auth,headers,payload:submitBody(f)});expect(r.statusCode,r.body).toBe(202);expect(MiningTaxClaimSubmitResponseSchema.parse(r.json())).toMatchObject({wallet:f.wallet,idempotencyKey:f.key.idempotencyKey,claimId:null,wire:null,delivery:'held',reason:'STORAGE_UNCERTAIN'});expect(r.body).not.toContain('acceptedAt');expect(f.calls.connect).toBe(0);
   armed=false;const recovery=MiningTaxClaimRecoveryEnvelopeSchema.parse((await app.inject({url:`/claims/mining-tax/by-key/${f.key.idempotencyKey}`,cookies:auth})).json());expect(recovery.status).toBe(kind==='before-insert'?'prepared':'signed');expect(recovery.wires).toHaveLength(kind==='before-insert'?0:1);
  }finally{await app.close();await conn.close();}
 },{persistSigned:false}));

});
