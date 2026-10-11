/** Full real preparation/signature/receipt pipeline; injected raw provider and
 * transport uncertainty never substitute for the chain receipt verifier. */
import { describe,it,expect,vi } from 'vitest';
import { createMiningClaimReconciler,type MiningClaimTransport } from '../src/mining/claimReconcile';
import { getMiningClaimSigned } from '../src/mining/claimSignedStore';
import { withMiningClaimSettlementFixture as fixture } from './fixtures/miningClaimSettlement';
type Fixture=Parameters<Parameters<typeof fixture>[0]>[0];
function sources(f:Fixture){
 let landed=false,sends=0,statusCalls=0;const original=f.receiptReader.getTransaction;
 const receiptReader={...f.receiptReader,getTransaction:async(...args:Parameters<typeof original>)=>landed?original(...args):null};
 const transport:MiningClaimTransport={getGenesisHash:async()=>f.preparedClaim.header.genesisHash,
  getSignatureStatuses:async()=>{statusCalls++;return {context:{slot:4000},value:[null]};},getBlockHeight:async()=>200,
  sendRawTransaction:async()=>{sends++;return f.signed.signature;}};
 return {input:{admission:{reader:f.bank.reader,trust:f.bank.trust},settlement:{reader:receiptReader,trust:f.trust},transport:()=>transport,now:()=>new Date(f.preparedClaim.preparedAt)},
  request:{wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0},transport,receiptReader,land:()=>{landed=true;},sends:()=>sends,statusCalls:()=>statusCalls};
}
describe('saved claimant wire delivery and finalized recovery',()=>{
 it('retains a real timeout-after-send then settles the original payment once after restart, pause and quote expiry',async()=>fixture(async f=>{
  const s=sources(f);let sendCalls=0,finish!:(signature:string)=>void;const pending=new Promise<string>(resolve=>{finish=resolve;});
  s.transport.sendRawTransaction=async(bytes)=>{sendCalls++;const saved=await getMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId});expect(saved!.wires[0]!.signedTransactionHex).toBe(Buffer.from(bytes).toString('hex'));s.land();return pending;};
  const first=createMiningClaimReconciler(f.conn.db,{...s.input,timeoutMs:150});expect(await first(s.request)).toMatchObject({status:'held',reason:'TIMEOUT',signature:f.signed.signature});expect(sendCalls).toBe(1);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const reboot=createMiningClaimReconciler(f.conn.db,{...s.input,now:()=>new Date(Date.parse(f.preparedClaim.expiresAt)+1)});
  const result=await reboot(s.request);expect(result.status).toBe('settled');if(result.status!=='settled')throw Error('Expected exact finalized payment');
  expect(result.settlement.receipt.paidKeepBaseUnits).toBe(String(f.payment));expect(result.signature).toBe(f.signed.signature);
  expect(await reboot(s.request)).toEqual(result);expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(1);expect(sendCalls).toBe(1);finish(f.signed.signature);
 }));
 it('reports an acknowledgment only as submitted and later reconciles the actual finalized KEEP transfer',async()=>fixture(async f=>{
  const s=sources(f),step=createMiningClaimReconciler(f.conn.db,s.input);expect(await step(s.request)).toMatchObject({status:'submitted',claimFinalized:false,signature:f.signed.signature});expect(s.sends()).toBe(1);
  expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);s.land();expect(await step(s.request)).toMatchObject({status:'settled'});expect(s.sends()).toBe(1);
 }));
 it('holds an expired unresolved wire and preserves the original signature and reward evidence',async()=>fixture(async f=>{
  const s=sources(f);s.transport.getBlockHeight=async()=>f.preparedClaim.lastValidBlockHeight+1;
  expect(await createMiningClaimReconciler(f.conn.db,s.input)(s.request)).toMatchObject({status:'held',reason:'EXPIRED_UNRESOLVED',signature:f.signed.signature});expect(s.sends()).toBe(0);
  expect((await getMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId}))!.wires[0]).toEqual(f.signed);expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
 }));
 it('does not turn observed status, finalized errors or malformed evidence into another send or a payment',async()=>fixture(async f=>{
  const cases=[{context:{slot:4000},value:[{slot:3500,err:null,confirmations:1,confirmationStatus:'confirmed'}]},
   {context:{slot:4000},value:[{slot:3500,err:{InstructionError:[0,'Custom']},confirmations:null,confirmationStatus:'finalized'}]},
   {context:{slot:100},value:[null]},{context:{slot:4000},value:[]}];
  for(const raw of cases){const s=sources(f);s.transport.getSignatureStatuses=async()=>raw;expect(await createMiningClaimReconciler(f.conn.db,s.input)(s.request)).toMatchObject({status:'held'});expect(s.sends()).toBe(0);}
  expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
 }));
 it('holds a wrong acknowledgment without rewriting the persisted signature',async()=>fixture(async f=>{
  const s=sources(f);s.transport.sendRawTransaction=async()=>f.prepared.publication.blockhash;
  expect(await createMiningClaimReconciler(f.conn.db,s.input)(s.request)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN',signature:f.signed.signature});expect((await getMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId}))!.wires[0]).toEqual(f.signed);
 }));
 it('refuses fresh root drift and another wallet before any send',async()=>fixture(async f=>{
  const s=sources(f),step=createMiningClaimReconciler(f.conn.db,s.input);expect(await step({...s.request,wallet:f.buyer})).toMatchObject({status:'held',reason:'NOT_SIGNED'});
  await f.bank.config({latest_sequence:2n});expect(await step(s.request)).toMatchObject({status:'held',reason:'CLAIM_PROOF_STALE'});expect(s.sends()).toBe(0);
 }));
 it('retains the source flight after deadline and rejects a late status answer without sending',async()=>fixture(async f=>{
  const s=sources(f);let calls=0,resume!:(v:unknown)=>void;const blocked=new Promise<unknown>(resolve=>{resume=resolve;});s.transport.getSignatureStatuses=()=>{calls++;return blocked;};
  // The deadline tests the deliberately blocked RPC, not variable Ed25519/SQL
  // setup latency under the full workspace load. Production bounds are unchanged.
  const step=createMiningClaimReconciler(f.conn.db,{...s.input,timeoutMs:1000});expect(await step(s.request)).toMatchObject({reason:'TIMEOUT'});expect(calls).toBe(1);
  expect(await step(s.request)).toMatchObject({reason:'TIMEOUT'});expect(calls).toBe(1);resume({context:{slot:4000},value:[null]});await new Promise(resolve=>setTimeout(resolve,20));expect(s.sends()).toBe(0);
 }));
 it('does not retry transport when an observed transaction fails exact finalized payment verification',async()=>fixture(async f=>{
  const s=sources(f);s.land();f.tx.meta!.postTokenBalances![0]!.uiTokenAmount.amount='0';
  expect(await createMiningClaimReconciler(f.conn.db,s.input)(s.request)).toMatchObject({status:'held',reason:'SETTLEMENT_HELD'});expect(s.sends()).toBe(0);expect(s.statusCalls()).toBe(0);expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
 }));
});
