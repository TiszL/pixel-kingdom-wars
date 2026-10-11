/** Only a separately verified exact failed transaction may close the public claim. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {MiningClaimViewSchema} from '@shardkeep/shared/miningClaimsApi';
import {buildApp,type AppDeps} from '../src/app';
import {sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createMiningClaimFailure} from '../src/mining/claimFailure';
import {withMiningClaimSettlementFixture as fixture,type MiningClaimSettlementFixture} from './fixtures/miningClaimSettlement';
import {miningClaimFailureSource,withMiningClaimFailureRuntime as runtime} from './fixtures/miningClaimFailure';
import {TEST_CONFIG} from './helpers';
import {FRESH_DB_CASE_MS} from './freshDbCaseBudgets';
afterEach(()=>vi.unstubAllEnvs());
const headers={origin:TEST_CONFIG.WEB_ORIGIN[0]!};
const key=(f:MiningClaimSettlementFixture)=>({wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0});
async function auth(f:MiningClaimSettlementFixture,wallet:string){
 const [session]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
}
describe('private finalized mining failure HTTP recovery',{timeout:FRESH_DB_CASE_MS},()=>{
 it('recovers owner proof while paused without a provider, keeps it private and never resends repeated POSTs',async()=>fixture(async f=>runtime(f,async conn=>{
  vi.stubEnv('MULTI_BASE_ENABLED','false');const record=await createMiningClaimFailure(f.conn.db,miningClaimFailureSource(f))(key(f));
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const cookies=await auth(f,f.wallet),foreign=await auth(f,f.buyer);
  const app=await buildApp(TEST_CONFIG,conn.db);try{
   const url=`/claims/mining/${record.claimId}`;
   expect((await app.inject({url})).statusCode).toBe(401);
   const response=await app.inject({url,cookies});expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
   const view=MiningClaimViewSchema.parse(response.json());expect(view).toMatchObject({wallet:f.wallet,state:'failed',landing:'failed',signature:f.signed.signature,settledBaseUnits:null});
   expect(view.transactions[0]).toMatchObject({ordinal:0,landing:'failed',signature:f.signed.signature,settledBaseUnits:null});
   const unseen=await app.inject({url,cookies:foreign});expect(unseen.statusCode).toBe(200);expect(unseen.json()).toMatchObject({wallet:f.buyer,state:'unknown',signature:null,settledBaseUnits:null});
   const original=await app.inject({url:`/claims/mining/prepare/by-key/${f.preparedClaim.idempotencyKey}`,cookies});expect(original.json()).toMatchObject({status:'prepared',receipt:{claimId:f.preparedClaim.claimId}});
   const status=await app.inject({url:'/claims/mining/status',cookies});expect(status.json()).toMatchObject({state:'unavailable',preparationAllowed:false,claimableBaseUnits:null});
  }finally{await app.close();}
  let calls=0;const forbidden=async()=>{calls++;throw Error('Terminal recovery must stay offline');};
  const provider:NonNullable<AppDeps['miningClaimsProvider']>={reader:{getGenesisHash:forbidden,getSlot:forbidden,getMultipleAccountsInfoAndContext:forbidden},trust:f.trust,quoteSource:()=>{calls++;throw Error('No quote');},transport:()=>{calls++;throw Error('No transport');}};
  const restarted=await buildApp(TEST_CONFIG,conn.db,{miningClaimsProvider:provider});try{
   for(let i=0;i<2;i++){const response=await restarted.inject({method:'POST',url:'/claims/mining/submit',cookies,headers,payload:{claimId:f.preparedClaim.claimId,signedTransaction:Buffer.from(f.sign()).toString('base64')}});
    expect(response.statusCode,response.body).toBe(202);expect(response.json()).toMatchObject({delivery:'held',reason:'CLAIM_FAILED_CHECK_RECEIPT',signature:f.signed.signature});}
   expect(calls).toBe(0);expect(await f.conn.sql`select claim_id from mining_claim_failures`).toHaveLength(1);expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(1);
  }finally{await restarted.close();}
 })));
 it('cannot fabricate a failure through the runtime connection even under accidental broad grants',async()=>fixture(async f=>runtime(f,async(conn,role)=>{
  vi.stubEnv('MULTI_BASE_ENABLED','false');await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role}`);
  await expect(createMiningClaimFailure(conn.db,miningClaimFailureSource(f))(key(f))).rejects.toMatchObject({code:'OWNER_REQUIRED'});
  await expect(conn.sql`insert into mining_claim_failures(claim_id,ordinal,receipt) values(${f.preparedClaim.claimId},0,'{}')`).rejects.toThrow('MINING_CLAIM_FAILURE_OWNER_REQUIRED');
  const app=await buildApp(TEST_CONFIG,conn.db),cookies=await auth(f,f.wallet);try{
   const response=await app.inject({url:`/claims/mining/${f.preparedClaim.claimId}`,cookies});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({state:'retained',landing:'pending',settledBaseUnits:null});
   expect(await f.conn.sql`select claim_id from mining_claim_failures`).toHaveLength(0);
  }finally{await app.close();}
 })));
 it('returns definitive blockhash-reuse refusal before writing a new preparation and permits a fresh original intent',async()=>fixture(async f=>runtime(f,async conn=>{
  vi.stubEnv('MULTI_BASE_ENABLED','false');await createMiningClaimFailure(f.conn.db,miningClaimFailureSource(f))(key(f));
  f.quote.reader.getLatestBlockhashAndContext=async()=>({context:{slot:3003},value:{blockhash:f.preparedClaim.blockhash,lastValidBlockHeight:250}});
  f.quote.reader.getFeeForMessage=async()=>({context:{slot:3003},value:5000});f.quote.reader.getSlot=async()=>3003;
  const provider:NonNullable<AppDeps['miningClaimsProvider']>={reader:f.bank.reader,trust:f.trust,quoteSource:()=>f.quote.reader,now:()=>new Date(f.preparedClaim.preparedAt),transport:()=>{throw Error('Preparation never sends');}};
  const app=await buildApp(TEST_CONFIG,conn.db,{miningClaimsProvider:provider}),cookies=await auth(f,f.wallet),idempotencyKey=randomUUID();try{
   const denied=await app.inject({method:'POST',url:'/claims/mining/prepare',headers,cookies,payload:{idempotencyKey}});
   expect(denied.statusCode,denied.body).toBe(409);expect(denied.json()).toMatchObject({error:{code:'CLAIM_BLOCKHASH_REUSED'}});
   const absent=await app.inject({url:`/claims/mining/prepare/by-key/${idempotencyKey}`,cookies});expect(absent.json()).toMatchObject({status:'unknown',receipt:null});
   const blockhash=Keypair.generate().publicKey.toBase58();f.quote.reader.getLatestBlockhashAndContext=async()=>({context:{slot:3003},value:{blockhash,lastValidBlockHeight:250}});
   const fresh=await app.inject({method:'POST',url:'/claims/mining/prepare',headers,cookies,payload:{idempotencyKey:randomUUID()}});
   expect(fresh.statusCode,fresh.body).toBe(201);expect(fresh.json().claimId).not.toBe(f.preparedClaim.claimId);expect(fresh.json().transactions[0].blockhash).toBe(blockhash);
   expect(await f.conn.sql`select claim_id from mining_claim_failures`).toHaveLength(1);expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(1);
  }finally{await app.close();}
 })));
});
