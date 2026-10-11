/** A saved failed packet suppresses relay and deterministic message reuse; it
 * never resolves the entire split plan or discards the signed custody. */
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createMiningTaxFailureVerifier,type MiningTaxFailureRpc} from '@shardkeep/chain/mining-tax-failure';
import {MiningTaxClaimFailureEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimFailureApi';
import {buildApp} from '../src/app';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createMiningTaxClaimPreparer} from '../src/mining/taxClaimPreparation';
import {createMiningTaxClaimReconciler,type MiningTaxClaimTransport} from '../src/mining/taxClaimReconcile';
import {getMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import * as failures from '../src/mining/taxClaimFailure';
import {withMiningTaxAdmissionFixture,type MiningTaxAdmissionFixture as F} from './fixtures/miningTaxAdmission';
import {failureMigration} from './fixtures/miningTaxFailure';
import {TEST_CONFIG} from './helpers';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(run:(f:F)=>Promise<void>,options:Parameters<typeof withMiningTaxAdmissionFixture>[1]={}){
 await withMiningTaxAdmissionFixture(async f=>{for(const s of failureMigration().split('--> statement-breakpoint').filter(s=>s.trim()))await f.conn.sql.unsafe(s);vi.stubEnv('PHASE_E_MINING_ENABLED','true');await run(f);},options);
}
async function persist(f:F,ordinal=0){
 const connect=(signal:AbortSignal):MiningTaxFailureRpc=>{const rpc=f.sources.connect(signal);return {...rpc,getMultipleAccountsInfoAndContext:async(keys,options)=>{const r=await rpc.getMultipleAccountsInfoAndContext(keys,options);return {context:r.context,value:r.value.map((row,i)=>row?{address:keys[i]!,owner:row.owner,executable:row.executable,data:row.data}:null)};}};};
 const tx=f.chain.txs[ordinal]!,old=tx.meta!;tx.meta={...old,err:{InstructionError:[0,{Custom:9}]},postBalances:old.preBalances.map((n,i)=>n-(i===0?old.fee:0)),postTokenBalances:structuredClone(old.preTokenBalances!)};
 try{const proof=await createMiningTaxFailureVerifier(connect,f.chain.trust.mining)({preparation:f.record.artifact,ordinal,signedTransaction:f.wire(ordinal)});await f.conn.sql`insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},${ordinal},${JSON.stringify(proof)}::jsonb)`;}finally{tx.meta=old;}
}
function relay(f:F){
 let connects=0,sends=0;const rpc:MiningTaxClaimTransport={getGenesisHash:async()=>f.record.artifact.source.genesisHash,getSignatureStatuses:async()=>({context:{slot:f.control.slot},value:[null]}),getBlockHeight:async()=>f.control.height,sendRawTransaction:async()=>{sends++;return f.chain.txs[0]!.transaction.signatures[0]!;}};
 return {rpc,sources:{admission:f.sources,transport:()=>{connects++;return rpc;}},counts:()=>({connects,sends})};
}
function request(f:F){const a=f.record.artifact;return {idempotencyKey:a.idempotencyKey,round:a.round,spot:a.spot,caps:a.caps};}
async function runtime(f:F,enabled:boolean){
 await runMigrations(f.conn.db);const role=`tax_failed_admit_${randomUUID().replaceAll('-','')}`,password=randomUUID();
 await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};grant select on players,sessions,mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_receipts,mining_tax_claim_failures,mining_tax_claim_continuations to ${role};grant insert on mining_tax_claim_signed_wires to ${role}`);
 const url=new URL(f.url);url.username=role;url.password=password;const conn=createDb(url.toString(),{max:4}),r=relay(f),app=await buildApp(TEST_CONFIG,conn.db,enabled?{miningTaxRelaySources:r.sources}:{});
 await f.conn.db.insert(players).values({wallet:f.wallet}).onConflictDoNothing();const [session]=await f.conn.db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.wallet,session!.id)};
 return {app,role,r,cookies,async close(){await app.close();await conn.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}};
}
describe('KEEP tax failed packet admission',()=>{
 it.each(['claim','combined','split'] as const)('recovers failed %s before providers, flag or expiry checks',mode=>fixture(async f=>{
  await persist(f);const r=relay(f);vi.stubEnv('PHASE_E_MINING_ENABLED','false');f.control.now=new Date(f.record.artifact.expiresAt);const before=f.calls.connect;
  const result=await createMiningTaxClaimReconciler(f.conn.db,{...r.sources,admission:{...f.sources,connect:()=>{throw Error('offline');}}})(f.key);
  expect(result).toMatchObject({...f.key,status:'held',reason:'CLAIM_FAILED_CHECK_RECEIPT',signature:f.chain.txs[0]!.transaction.signatures[0],claimFinalized:false});expect(r.counts()).toEqual({connects:0,sends:0});expect(f.calls.connect).toBe(before);expect((await getMiningTaxClaimSigned(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey}))!.wires).toHaveLength(mode==='split'?2:1);
 },{mode}));
 it.each(['admission','final-transport'] as const)('suppresses send when failure is saved during %s',when=>fixture(async f=>{
  const r=relay(f);if(when==='admission'){let saved=false;f.control.afterFee=async()=>{if(!saved){saved=true;await persist(f);}};}else{const get=r.rpc.getGenesisHash;let n=0;r.rpc.getGenesisHash=async()=>{const v=await get();if(++n===3)await persist(f);return v;};}
  expect(await createMiningTaxClaimReconciler(f.conn.db,r.sources)(f.key)).toMatchObject({status:'held',reason:'CLAIM_FAILED_CHECK_RECEIPT',claimFinalized:false});expect(r.counts().sends).toBe(0);expect(f.calls.connect).toBeGreaterThan(0);
 }));
 it.each(['first','last'] as const)('holds on %s failure-read outage rather than relaying',when=>fixture(async f=>{
  const r=relay(f),get=failures.getMiningTaxClaimFailure;let reads=0;vi.spyOn(failures,'getMiningTaxClaimFailure').mockImplementation((db,key)=>++reads===(when==='first'?1:3)?Promise.reject(Error('failure read unavailable')):get(db,key));
  expect(await createMiningTaxClaimReconciler(f.conn.db,r.sources)(f.key)).toMatchObject({status:'held',reason:'SETTLEMENT_HELD'});expect(r.counts().sends).toBe(0);if(when==='first')expect(r.counts().connects).toBe(0);
 }));
 it('keeps a setup success distinct from the failed claim packet',()=>fixture(async f=>{
  await f.verifySetup();await persist(f,1);const r=relay(f),step=createMiningTaxClaimReconciler(f.conn.db,r.sources);vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  expect(await step(f.key)).toMatchObject({status:'setup',claimFinalized:false});expect(await step({...f.key,ordinal:1})).toMatchObject({status:'held',reason:'CLAIM_FAILED_CHECK_RECEIPT',claimFinalized:false});expect(r.counts()).toEqual({connects:0,sends:0});
 },{mode:'split'}));
 it.each([false,true])('HTTP preserves custody and GET failure evidence with relay configured=%s',enabled=>fixture(async f=>{
  await persist(f);const h=await runtime(f,enabled);vi.stubEnv('PHASE_E_MINING_ENABLED','false');try{
   const result=await h.app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:h.cookies,headers:{origin:TEST_CONFIG.WEB_ORIGIN[0]!},payload:{idempotencyKey:f.key.idempotencyKey,signedTransaction:Buffer.from(f.wire()).toString('base64')}});
   expect(result.statusCode,result.body).toBe(202);expect(result.json()).toMatchObject({delivery:'held',reason:'CLAIM_FAILED_CHECK_RECEIPT',wire:{signedTransactionHex:Buffer.from(f.wire()).toString('hex')}});expect(result.headers['cache-control']).toBe('private, no-store');expect(h.r.counts()).toEqual({connects:0,sends:0});
   const saved=await h.app.inject({url:`/claims/mining-tax/failures/by-key/${f.key.idempotencyKey}`,cookies:h.cookies});expect(saved.statusCode,saved.body).toBe(200);expect(MiningTaxClaimFailureEnvelopeSchema.parse(saved.json())).toMatchObject({recovery:{status:'signed',settlement:null},failures:[{ordinal:0,transactionFailed:true,claimFinalized:false}]});
  }finally{await h.close();}
 }));
 it('HTTP keeps newly committed custody when the failure lookup is unavailable',()=>fixture(async f=>{
  const h=await runtime(f,true);try{await f.conn.sql.unsafe(`revoke select on mining_tax_claim_failures from ${h.role}`);const result=await h.app.inject({method:'POST',url:'/claims/mining-tax/submit',cookies:h.cookies,headers:{origin:TEST_CONFIG.WEB_ORIGIN[0]!},payload:{idempotencyKey:f.key.idempotencyKey,signedTransaction:Buffer.from(f.wire()).toString('base64')}});
   expect(result.statusCode,result.body).toBe(202);expect(result.json()).toMatchObject({delivery:'held',reason:'SOURCE_UNAVAILABLE',wire:{signedTransactionHex:Buffer.from(f.wire()).toString('hex')}});expect(h.r.counts()).toEqual({connects:0,sends:0});expect((await getMiningTaxClaimSigned(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey}))!.wires).toHaveLength(1);
  }finally{await h.close();}
 },{persistSigned:false}));
 it.each(['claim','combined','split'] as const)('refuses a new %s key that would reproduce any failed message',mode=>fixture(async f=>{
  await persist(f,mode==='split'?1:0);f.control.blockhash=f.record.artifact.blockhash;const service=createMiningTaxClaimPreparer(f.conn.db,f.sources),fresh={...request(f),idempotencyKey:randomUUID()};
  await expect(service.prepare(f.wallet,fresh)).rejects.toMatchObject({code:'CLAIM_BLOCKHASH_REUSED'});expect(await service.get(f.wallet,fresh.idempotencyKey)).toBeNull();
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await service.prepare(f.wallet,request(f))).toEqual(f.record.artifact);
 },{mode}));
 it('permits a different unsigned message without reparenting failed custody or granting retry',()=>fixture(async f=>{
  await persist(f);const service=createMiningTaxClaimPreparer(f.conn.db,f.sources),fresh=await service.prepare(f.wallet,{...request(f),idempotencyKey:randomUUID()});
  expect(fresh.transactions[0]!.messageSha256).not.toBe(f.record.artifact.transactions[0]!.messageSha256);expect(fresh).toMatchObject({currentSigningAuthorized:false,submissionAuthorized:false});expect((await getMiningTaxClaimSigned(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey}))!.wires).toHaveLength(1);expect(await failures.getMiningTaxClaimFailure(f.conn.db,f.key)).toMatchObject({transactionFailed:true,claimFinalized:false});
 }));
});
