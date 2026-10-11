/** Runtime relay uses public saved evidence and never obtains a verifier writer. */
import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { createDb } from '../src/db/client';
import { createMiningClaimReconciler,type MiningClaimReconcileSources,type MiningClaimTransport } from '../src/mining/claimReconcile';
import * as settlements from '../src/mining/claimSettlement';
import { withMiningClaimSettlementFixture as fixture } from './fixtures/miningClaimSettlement';
type Fixture=Parameters<Parameters<typeof fixture>[0]>[0];
async function runtime(f:Fixture,run:(conn:ReturnType<typeof createDb>,role:string)=>Promise<void>){
 const role=`claim_relay_${randomUUID().replaceAll('-','')}`,password=randomUUID(),url=new URL(f.url);
 await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};grant select on mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures to ${role}`);
 url.username=role;url.password=password;const conn=createDb(url.toString(),{max:2});
 try{const [r]=await conn.sql`select current_user as role`;expect(r!.role).toBe(role);await run(conn,role);}finally{await conn.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
}
function sources(f:Fixture){
 let sends=0,connections=0;const transport:MiningClaimTransport={getGenesisHash:async()=>f.preparedClaim.header.genesisHash,getSignatureStatuses:async()=>({context:{slot:4000},value:[null]}),getBlockHeight:async()=>200,
  sendRawTransaction:async bytes=>{sends++;expect(Buffer.from(bytes).toString('hex')).toBe(f.signed.signedTransactionHex);return f.signed.signature;}};
 const input={mode:'read-saved-receipt' as const,admission:{reader:f.bank.reader,trust:f.bank.trust},transport:()=>{connections++;return transport;},now:()=>new Date(f.preparedClaim.preparedAt)} satisfies MiningClaimReconcileSources;
 return {input,transport,request:{wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0},sends:()=>sends,connections:()=>connections};
}
describe('runtime saved-receipt mining claim relay',()=>{
 it('sends only an already saved wire without a live verifier or success write, even under broad grants',async()=>fixture(async f=>runtime(f,async(conn,role)=>{
  const [privileges]=await conn.sql`select has_table_privilege(current_user,'mining_claim_receipts','INSERT') as insert`;expect(privileges!.insert).toBe(false);
  await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role}`);
  await expect(conn.sql`insert into mining_claim_receipts(claim_id,ordinal,receipt) values(${f.preparedClaim.claimId},0,'{}')`).rejects.toThrow('MINING_CLAIM_RECEIPT_OWNER_REQUIRED');
  const s=sources(f),live=vi.spyOn(settlements,'createMiningClaimSettlement');
  try{expect(await createMiningClaimReconciler(conn.db,s.input)(s.request)).toMatchObject({status:'submitted',signature:f.signed.signature,claimFinalized:false});expect(s.sends()).toBe(1);expect(live).not.toHaveBeenCalled();}finally{live.mockRestore();}
  expect(await conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);expect((await conn.sql`select encode(signed_transaction,'hex') wire from mining_claim_signed_wires`)[0]!.wire).toBe(f.signed.signedTransactionHex);
 })));
 it('returns an owner-verified saved receipt while paused without connecting transport or sources',async()=>fixture(async f=>{
  const s=sources(f),settled=await settlements.createMiningClaimSettlement(f.conn.db,{reader:f.receiptReader,trust:f.trust})(s.request);vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  await runtime(f,async conn=>{
   let reads=0;const fail=async()=>{reads++;throw Error('Historical recovery must stay offline');};
   const live=vi.spyOn(settlements,'createMiningClaimSettlement');
   try{const step=createMiningClaimReconciler(conn.db,{...s.input,admission:{...s.input.admission,reader:{getGenesisHash:fail,getSlot:fail,getMultipleAccountsInfoAndContext:fail}},transport:()=>{throw Error('No transport on settled replay');}});
    expect(await step(s.request)).toEqual({status:'settled',claimId:s.request.claimId,ordinal:0,signature:f.signed.signature,settlement:settled});expect(reads).toBe(0);expect(live).not.toHaveBeenCalled();
   }finally{live.mockRestore();}
  });
 }));
 it('holds paused, observed, expired or malformed unresolved evidence without payment or resend',async()=>fixture(async f=>runtime(f,async conn=>{
  let s=sources(f);vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await createMiningClaimReconciler(conn.db,s.input)(s.request)).toMatchObject({status:'held',reason:'PAUSED'});expect(s.connections()).toBe(0);vi.stubEnv('PHASE_E_MINING_ENABLED','true');
  for(const status of [{context:{slot:4000},value:[{slot:3500,err:null,confirmations:null,confirmationStatus:'finalized'}]},{context:{slot:100},value:[null]}]){s=sources(f);s.transport.getSignatureStatuses=async()=>status;expect(await createMiningClaimReconciler(conn.db,s.input)(s.request)).toMatchObject({status:'held'});expect(s.sends()).toBe(0);}
  s=sources(f);s.transport.getBlockHeight=async()=>f.preparedClaim.lastValidBlockHeight+1;expect(await createMiningClaimReconciler(conn.db,s.input)(s.request)).toMatchObject({status:'held',reason:'EXPIRED_UNRESOLVED'});expect(s.sends()).toBe(0);
  s=sources(f);await f.bank.config({latest_sequence:2n});expect(await createMiningClaimReconciler(conn.db,s.input)(s.request)).toMatchObject({status:'held',reason:'CLAIM_PROOF_STALE',signature:f.signed.signature});expect(s.sends()).toBe(0);
  expect(await conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
 })));
 it('rejects runtime configuration carrying a verifier writer dependency',async()=>fixture(async f=>{
  const s=sources(f);expect(()=>createMiningClaimReconciler(f.conn.db,{...s.input,settlement:{reader:f.receiptReader,trust:f.trust}} as never)).toThrow('Runtime mining relay cannot receive a settlement source');
 }));
});
