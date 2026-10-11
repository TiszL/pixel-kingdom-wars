/** Exact committed bytes recover across process loss without releasing ambiguity. */
import { describe,it,expect,vi } from 'vitest';
import { createMiningPublicationFixture } from '../../../packages/chain/src/testFixtures/miningPublication';
import { withMiningPublicationOutboxFixture as fixture,type MiningPublicationOutboxFixture } from './fixtures/miningPublicationOutbox';
import { createMiningPublicationReconciler,type MiningPublicationTransport } from '../src/mining/publicationReconcile';
async function ready(f:MiningPublicationOutboxFixture,signed=true){
 await f.outbox.reserveSigning(f.request);if(signed)await f.outbox.acceptSigned({...f.request,signedTransaction:f.sign()});
 const p=f.prepared.publication,chain=await createMiningPublicationFixture('legacy',{signer:f.signer,identity:f.backing.trust,genesisHash:f.backing.trust.expectedGenesisHash,programData:f.backing.programData,intentBytes:Buffer.from(f.prepared.intentHex,'hex'),publicationSlot:2111,
  args:{sequence:BigInt(p.sequence),day:BigInt(p.day),kind:0,root:Buffer.from(p.root,'hex'),totalCumulative:BigInt(p.total),leafCount:p.leafCount,budgetGross:BigInt(p.budgetGross),freeGross:BigInt(p.freeGross),deedGross:BigInt(p.deedGross),sourceHash:Buffer.from(f.prepared.sourceHash,'hex'),taxCommitment:Buffer.from(p.taxCommitment,'hex'),taxVersion:p.taxVersion}});
 let landed=false;const get=chain.reader.getTransaction;chain.reader.getTransaction=vi.fn(async signature=>landed?get(signature,{commitment:'finalized',maxSupportedTransactionVersion:0}):null);
 const transport={getGenesisHash:vi.fn<MiningPublicationTransport['getGenesisHash']>(async()=>f.backing.trust.expectedGenesisHash),getSignatureStatuses:vi.fn<MiningPublicationTransport['getSignatureStatuses']>(async()=>({context:{slot:2120},value:[null]})),getBlockHeight:vi.fn<MiningPublicationTransport['getBlockHeight']>(async()=>2150),sendRawTransaction:vi.fn<MiningPublicationTransport['sendRawTransaction']>(async()=>chain.request.signature)};
 const make=(timeoutMs?:number)=>createMiningPublicationReconciler(f.conn.db,{backing:{reader:f.backing.reader,trust:f.backing.trust},settlement:{reader:chain.reader,trust:chain.trusted},transport:()=>transport as MiningPublicationTransport,...(timeoutMs===undefined?{}:{timeoutMs})});
 const stock=async()=>Number((await f.conn.sql`select qty from base_items where base_id=${f.baseId} and item_id='forge_ingot'`)[0]?.qty??0);
 return {chain,transport,make,land:()=>{landed=true;},stock};
}
describe('one bounded mining publication reconcile step',()=>{
 it('proves commit-before-send and recovers a lost reply through real finalized settlement in a fresh instance',async()=>fixture(async f=>{
  const h=await ready(f),before=await h.stock();let finish!:()=>void;const drained=new Promise<void>(resolve=>{finish=resolve;});
  h.transport.sendRawTransaction.mockImplementation(async(wire:Uint8Array)=>{
   const saved=await f.outbox.get(f.request.epochId);expect(saved?.signed?.signedTransactionHex).toBe(Buffer.from(wire).toString('hex'));
   expect(saved?.signed?.signature).toBe(h.chain.request.signature);
   try{await new Promise(resolve=>setTimeout(resolve,1100));throw Error('reply lost after send');}finally{finish();}
  });
  const first=await h.make(1000)(f.request);expect(first).toMatchObject({status:'held',reason:'TIMEOUT',signature:h.chain.request.signature});
  expect(h.transport.sendRawTransaction).toHaveBeenCalledTimes(1);expect(await h.stock()).toBe(before);
  expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toHaveLength(0);
  await drained;h.land();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  try{const next=await h.make()(f.request);expect(next).toMatchObject({status:'settled',signature:h.chain.request.signature});if(next.status==='settled')expect(next.settlement.dispositions).toMatchObject([{consumed:2,returned:1}]);}
  finally{vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
  expect(await h.stock()).toBe(before+1);expect(h.transport.sendRawTransaction).toHaveBeenCalledTimes(1);
 },{quantities:[3]}));
 it('submits only exact persisted bytes once; acknowledgement is not custody settlement',async()=>fixture(async f=>{
  const h=await ready(f),r=await h.make()(f.request);expect(r).toMatchObject({status:'submitted',signature:h.chain.request.signature,publicationFinalized:false});
  const call=h.transport.sendRawTransaction.mock.calls[0]!;expect(Buffer.from(call[0])).toEqual(Buffer.from(f.sign()));expect(call[1]).toMatchObject({skipPreflight:false,maxRetries:0,preflightCommitment:'finalized'});
  expect(await f.conn.sql`select reservation_id from mining_ingot_dispositions`).toHaveLength(0);
 }));
 it('retains stock for missing signed bytes, pause and expired null history',async()=>fixture(async f=>{
  const h=await ready(f,false),step=h.make();expect(await step(f.request)).toMatchObject({status:'held',reason:'NOT_SIGNED'});expect(h.transport.getGenesisHash).not.toHaveBeenCalled();
  await f.outbox.acceptSigned({...f.request,signedTransaction:f.sign()});vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  try{expect(await step(f.request)).toMatchObject({status:'held',reason:'PAUSED'});}finally{vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
  h.transport.getBlockHeight.mockResolvedValue(2201);expect(await step(f.request)).toMatchObject({status:'held',reason:'EXPIRED_UNRESOLVED'});
  expect(h.transport.sendRawTransaction).not.toHaveBeenCalled();expect(await h.stock()).toBe(0);expect(await f.conn.sql`select reservation_id from mining_ingot_dispositions`).toHaveLength(0);
 }));
 it('holds seen transactions, malformed status, stale context and a wrong chain without sending',async()=>fixture(async f=>{
  const h=await ready(f),step=h.make();
  const cases=[{context:{slot:2120},value:[{slot:2111,confirmations:1,err:null,confirmationStatus:'confirmed'}]},
   {context:{slot:2120},value:[{slot:2111,confirmations:null,err:{InstructionError:[0,'Custom']},confirmationStatus:'finalized'}]},
   {context:{slot:1999},value:[null]},{context:{slot:2120},value:[]},{context:{slot:2120},value:[{slot:2121,err:null,confirmationStatus:'finalized'}]}];
  for(const result of cases){h.transport.getSignatureStatuses.mockResolvedValue(result as never);expect((await step(f.request)).status).toBe('held');}
  h.transport.getSignatureStatuses.mockResolvedValue({context:{slot:2120},value:[null]});h.transport.getGenesisHash.mockResolvedValue(f.buyer);
  expect(await step(f.request)).toMatchObject({status:'held',reason:'IDENTITY'});expect(h.transport.sendRawTransaction).not.toHaveBeenCalled();expect(await h.stock()).toBe(0);
 }));
 it('requires fresh admission and preserves the original signature on wrong acknowledgement',async()=>fixture(async f=>{
  const h=await ready(f),step=h.make();f.backing.model.flags=2;await f.backing.config();
  expect(await step(f.request)).toMatchObject({status:'held',reason:'ADMISSION_HELD'});expect(h.transport.sendRawTransaction).not.toHaveBeenCalled();
  f.backing.model.flags=0;await f.backing.config();h.transport.sendRawTransaction.mockResolvedValue('wrong acknowledgement');
  expect(await step(f.request)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN',signature:h.chain.request.signature});expect(await h.stock()).toBe(0);
 }));
 it('shares an in-flight epoch step and never starts a late send after an uncooperative timeout',async()=>fixture(async f=>{
  const h=await ready(f);let resolve!:(value:string)=>void;
  h.transport.getGenesisHash.mockImplementation(()=>new Promise<string>(r=>{resolve=r;}));
  const step=h.make(200),first=step(f.request),second=step(f.request);expect(second).toBe(first);
  expect(await first).toMatchObject({status:'held',reason:'TIMEOUT'});expect(await step(f.request)).toMatchObject({status:'held',reason:'TIMEOUT'});expect(h.transport.getGenesisHash).toHaveBeenCalledTimes(1);
  resolve(f.backing.trust.expectedGenesisHash);await new Promise(r=>setTimeout(r,15));
  expect(h.transport.getBlockHeight).not.toHaveBeenCalled();expect(h.transport.sendRawTransaction).not.toHaveBeenCalled();expect(await h.stock()).toBe(0);
 }));
});
