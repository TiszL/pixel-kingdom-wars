/** The exact failure verifier, not a signature-status hint, closes the wire. */
import {Keypair} from '@solana/web3.js';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createMiningClaimReconciler,type MiningClaimTransport} from '../src/mining/claimReconcile';
import {getMiningClaimFailure} from '../src/mining/claimFailure';
import {getMiningClaimSigned} from '../src/mining/claimSignedStore';
import {withMiningClaimSettlementFixture as fixture,type MiningClaimSettlementFixture} from './fixtures/miningClaimSettlement';
import {failedMiningClaimTransaction,miningClaimFailureSource,withMiningClaimFailureRuntime as runtime} from './fixtures/miningClaimFailure';
afterEach(()=>vi.unstubAllEnvs());
function sources(f:MiningClaimSettlementFixture){
 let sends=0,connections=0;const transport:MiningClaimTransport={getGenesisHash:async()=>f.identity.genesisHash,getBlockHeight:async()=>200,
  getSignatureStatuses:async()=>({context:{slot:4000},value:[{slot:3004,err:{InstructionError:[0,'InvalidArgument']},confirmations:null,confirmationStatus:'finalized'}]}),
  sendRawTransaction:async()=>{sends++;return f.signed.signature;}};
 const common={admission:{reader:f.bank.reader,trust:f.bank.trust},transport:()=>{connections++;return transport;},now:()=>new Date(f.preparedClaim.preparedAt)};
 return {input:{...common,settlement:miningClaimFailureSource(f)},runtime:{...common,mode:'read-saved-receipt' as const},transport,request:{wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0},sends:()=>sends,connections:()=>connections};
}
describe('saved failed mining wire reconciliation',()=>{
 it('proves an actual failure and replays it offline through runtime after pause and expiry',async()=>fixture(async f=>{
  const s=sources(f),result=await createMiningClaimReconciler(f.conn.db,s.input)(s.request);
  expect(result).toMatchObject({status:'failed',signature:f.signed.signature,failure:{claimFailed:true,receipt:{outcome:'failed',paymentAuthorized:false}}});
  expect(s.connections()).toBe(0);expect(await f.conn.sql`select claim_id from mining_claim_failures`).toHaveLength(1);expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');await runtime(f,async conn=>{
   let reads=0;const never=async()=>{reads++;throw Error('No live read after terminal proof');};
   const step=createMiningClaimReconciler(conn.db,{...s.runtime,admission:{...s.runtime.admission,reader:{getGenesisHash:never,getSlot:never,getMultipleAccountsInfoAndContext:never}},transport:()=>{reads++;throw Error('No send');},now:()=>new Date(Date.parse(f.preparedClaim.expiresAt)+1)});
   expect(await step(s.request)).toEqual(result);expect(reads).toBe(0);
  });expect((await getMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:s.request.claimId}))!.wires[0]).toEqual(f.signed);
 }));
 it('holds a finalized error status when the exact transaction is missing, with no failure receipt or send',async()=>fixture(async f=>{
  const s=sources(f);s.input.settlement.reader.getTransaction=async()=>null as typeof f.tx|null;
  expect(await createMiningClaimReconciler(f.conn.db,s.input)(s.request)).toMatchObject({status:'held',reason:'FINALIZED_ERROR_UNVERIFIED',signature:f.signed.signature});
  await runtime(f,async conn=>{expect(await createMiningClaimReconciler(conn.db,s.runtime)(s.request)).toMatchObject({status:'held',reason:'FINALIZED_ERROR_UNVERIFIED'});});
  expect(s.sends()).toBe(0);expect(await getMiningClaimFailure(f.conn.db,s.request)).toBeNull();
 }));
 it('fails closed before transport if the saved failure reader loses database access',async()=>fixture(async f=>runtime(f,async(conn,role)=>{
  const s=sources(f);await f.conn.sql.unsafe(`revoke select on mining_claim_failures from ${role}`);
  expect(await createMiningClaimReconciler(conn.db,s.runtime)(s.request)).toMatchObject({status:'held',reason:'SETTLEMENT_HELD'});expect(s.connections()).toBe(0);expect(s.sends()).toBe(0);
  expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(1);
 })));
 it('refuses cross-trust configuration and a provider genesis mismatch without a terminal write',async()=>fixture(async f=>{
  const s=sources(f);expect(()=>createMiningClaimReconciler(f.conn.db,{...s.input,settlement:{...s.input.settlement,trust:{...s.input.settlement.trust,expectedGenesisHash:Keypair.generate().publicKey.toBase58()}}})).toThrow('Mining claim source identity mismatch');
  s.input.settlement.reader.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();
  expect(await createMiningClaimReconciler(f.conn.db,s.input)(s.request)).toMatchObject({status:'held',reason:'SETTLEMENT_HELD'});expect(s.connections()).toBe(0);expect(await getMiningClaimFailure(f.conn.db,s.request)).toBeNull();
 }));
 it('holds an unfinished verification after timeout and discards its late failed result before any write or send',async()=>fixture(async f=>{
  const s=sources(f);let calls=0,finish!:(v:typeof f.tx)=>void;const pending=new Promise<typeof f.tx>(resolve=>{finish=resolve;});
  s.input.settlement.reader.getTransaction=()=>{calls++;return calls===1?pending:Promise.resolve(null as typeof f.tx|null);};
  const step=createMiningClaimReconciler(f.conn.db,{...s.input,timeoutMs:500});expect(await step(s.request)).toMatchObject({status:'held',reason:'TIMEOUT'});expect(calls).toBe(1);
  expect(await step(s.request)).toMatchObject({status:'held',reason:'TIMEOUT'});expect(calls).toBe(1);finish(failedMiningClaimTransaction(f));
  await vi.waitFor(async()=>{expect(await step(s.request)).toMatchObject({status:'held',reason:'FINALIZED_ERROR_UNVERIFIED'});},{timeout:3000});
  expect(await getMiningClaimFailure(f.conn.db,s.request)).toBeNull();expect(s.sends()).toBe(0);expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
 }));
});
