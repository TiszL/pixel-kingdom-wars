import {beforeEach,describe,expect,it,vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {MiningClaimContinuationSchema} from '@shardkeep/shared/miningClaimsApi';
import {VersionedTransaction} from '@solana/web3.js';
import {prepareMiningClaimSigning,signMiningClaim,verifySignedMiningClaim} from './signing';
import {continuedMiningOperation,MiningClaimJournalStore} from './journal';
import {MiningClaimController,type MiningClaimPorts} from './controller';
import {orderedMiningFixture} from './ordered.test-support';
import type {GameWallet} from '../../auth/useGameWallet';
let f:ReturnType<typeof orderedMiningFixture>;
beforeEach(()=>{f=orderedMiningFixture();});
describe('ordered mining consent',()=>{
 it('reconstructs and signs each independent ordinal; setup is not the claim',async()=>{
  for(const ordinal of [0,1]){const p=prepareMiningClaimSigning(f.preparation,f.trust,ordinal);const wallet={publicKey:f.signer.publicKey,signVersionedTransaction:async(tx:VersionedTransaction)=>{tx.sign([f.signer]);return tx;}} as GameWallet;
   const signed=await signMiningClaim(p,wallet);expect(signed).toEqual(f.signed(ordinal));expect(verifySignedMiningClaim(f.preparation,signed.wire,ordinal)).toEqual(signed);expect(()=>verifySignedMiningClaim(f.preparation,signed.wire,1-ordinal)).toThrow();}
 });
 it('requires independent installed table pins',()=>{
  const {orderedLookupTable,...legacyTrust}=f.trust;expect(()=>prepareMiningClaimSigning(f.preparation,legacyTrust)).toThrow();
  expect(()=>prepareMiningClaimSigning(f.preparation,{...f.trust,orderedLookupTable:{...orderedLookupTable,dataSha256:'00'.repeat(32)}})).toThrow();
 });
 it('rejects altered leaf, exact message, table bytes and signature before custody',()=>{
  for(const change of [(p:typeof f.preparation)=>{p.leaf.cumulativeDays='2';},(p:typeof f.preparation)=>{const raw=Buffer.from(p.transactions[0]!.message,'base64');raw[raw.length-1]=raw[raw.length-1]!^1;p.transactions[0]!.message=raw.toString('base64');},(p:typeof f.preparation)=>{if(p.version===2)p.format.lookupTable.dataHex='00'.repeat(152);}]){const p=structuredClone(f.preparation);change(p);expect(()=>prepareMiningClaimSigning(p,f.trust)).toThrow();}
  const wire=Buffer.from(f.signed(0).wire,'base64');wire[5]=wire[5]!^1;expect(()=>verifySignedMiningClaim(f.preparation,wire.toString('base64'))).toThrow();
 });
 it('binds continuation to original entitlement, fresh blockhash and expiry floor',()=>{
  const good=f.continuation();expect(MiningClaimContinuationSchema.parse(good)).toEqual(good);
  for(const mutate of [(c:typeof good)=>{c.childPreparation.leaf.cumulativeKeepBaseUnits='79';},(c:typeof good)=>{c.expiry.blockHeight=250;},(c:typeof good)=>{c.childPreparation.transactions[0]!.blockhash=c.parentPreparation.transactions[0]!.blockhash;},(c:typeof good)=>{c.expiry.slot=121;}]){const c=structuredClone(good);mutate(c);expect(MiningClaimContinuationSchema.safeParse(c).success).toBe(false);}
 });
});
function controller(){
 const store=new MiningClaimJournalStore(f.identity,new IDBFactory());let current=f.claim(),prepared=false;
 const ports:MiningClaimPorts={capture:()=>()=>undefined,lock:async(_n,run)=>run(),key:()=>f.preparation.idempotencyKey,clock:()=>0,getStatus:async()=>f.status(),
  prepare:async(_r,_g,retain)=>{prepared=true;await retain(f.preparation);return f.preparation;},getPreparation:async()=>({wallet:f.identity.wallet,idempotencyKey:f.preparation.idempotencyKey,status:prepared?'prepared':'unknown',receipt:prepared?f.preparation:null,serverNow:f.preparation.serverNow}),getClaim:async()=>current,
  live:async()=>undefined,sign:async(_p,_g,ordinal=0)=>f.signed(ordinal),submit:async r=>({claimId:r.claimId,signature:verifySignedMiningClaim(f.preparation,r.signedTransaction,r.signedTransaction===f.signed(0).wire?0:1).signature,serverNow:f.preparation.serverNow,delivery:'held'}),reviewOrdered:async(_id,ordinal)=>f.review(ordinal)};
 return {store,ports,c:new MiningClaimController(store,ports),setClaim:(v:typeof current)=>{current=v;}};
}
describe('ordered mining durable lifecycle',()=>{
 it('retains both original wires and requires setup finality before the second approval',async()=>{
  const h=controller();await h.c.begin('ordered-v0');await h.c.review();await h.c.sign();await h.c.submit();expect(h.c.snapshot().error).toBeNull();
  await h.c.review();expect(h.c.snapshot().error).toMatch(/already/);h.setClaim(f.claim(['finalized']));await h.c.open();await h.c.review();await h.c.sign();await h.c.submit();expect(h.c.snapshot().error).toBeNull();
  const op=(await h.store.read()).operation!;expect(op.signed).toEqual(f.signed(0));expect(op.ordered!.remainder.signed).toEqual(f.signed(1));expect(op.claim!.state).toBe('retained');
  h.setClaim(f.claim(['finalized','finalized']));await h.c.open();await h.c.finish();expect((await h.store.read()).archives).toHaveLength(1);expect((await h.store.read()).operation).toBeNull();await h.store.close();
 });
 it('substituted setup proof cannot open the second wallet approval',async()=>{
  const h=controller();await h.c.begin('ordered-v0');await h.c.review();await h.c.sign();h.setClaim(f.claim(['finalized']));h.ports.reviewOrdered=async()=>({...f.review(1),setup:{...f.review(1).setup!,wireSha256:'00'.repeat(32)}});await h.c.open();await h.c.review();expect(h.c.snapshot().error).toMatch(/setup/);expect((await h.store.read()).operation!.ordered!.remainder.signingStarted).toBe(false);await h.store.close();
 });
 it('requires a new explicit review after cancellation while preserving the original message',async()=>{
  const h=controller();h.ports.sign=vi.fn(async()=>{throw Error('Wallet closed');});await h.c.begin('ordered-v0');await h.c.review();await h.c.sign();await h.c.sign();expect(h.ports.sign).toHaveBeenCalledTimes(1);await h.c.review();await h.c.sign();expect(h.ports.sign).toHaveBeenCalledTimes(2);expect((await h.store.read()).operation!.signingStarted).toBe(true);await h.store.close();
 });
 it('retains late valid wallet bytes after dismissal without relaying',async()=>{
  const h=controller();h.ports.sign=async()=>{h.c.dismiss();return f.signed(0);};await h.c.begin('ordered-v0');await h.c.review();await h.c.sign();expect((await h.store.read()).operation!.signed).toEqual(f.signed(0));expect((await h.store.read()).operation!.submitAttempted).toBe(false);await h.store.close();
 });
 it('latches malformed known terminal replies before parsing',async()=>{
  const h=controller();await h.c.begin('ordered-v0');h.ports.getClaim=async()=>({...f.claim(),state:'settled'});await h.c.open();expect((await h.store.read()).operation!.ordered!.held).toBe(true);h.ports.getClaim=async()=>f.claim();await h.c.review();expect(h.c.snapshot().error).toMatch(/held/);await h.store.close();
 });
});

describe('mining continuation custody',()=>{
 async function setup(){const h=controller();await h.c.begin('ordered-v0');await h.c.review();await h.c.sign();h.setClaim(f.claim(['finalized']));await h.c.open();return h;}
 it('preserves first-retained times and activates the child after a later GET refresh',async()=>{
  const h=await setup(),link=f.continuation(),envelope={version:1,wallet:f.identity.wallet,parentClaimId:f.preparation.claimId,status:'continued',continuation:link,serverNow:link.createdAt};h.ports.key=()=>link.childPreparation.idempotencyKey;
  h.ports.continuation=async(_p,request,_g,retain)=>{const result=structuredClone(envelope);if(!request){const later=new Date(Date.parse(link.createdAt)+1000).toISOString();result.serverNow=later;result.continuation.parentPreparation.serverNow=later;result.continuation.childPreparation.serverNow=later;}await retain(result);return result;};await h.c.continueClaim();expect(h.c.snapshot().error).toBeNull();await h.c.sign();expect(h.c.snapshot().error).not.toBeNull();await h.c.useContinuation();expect(h.c.snapshot().error).toBeNull();
  const j=await h.store.read();expect(j.archives[0]!.signed).toEqual(f.signed(0));expect(j.archives[0]!.ordered!.continuation).toEqual(link);expect(j.operation!.preparation).toEqual(link.childPreparation);expect(j.operation!.signed).toBeNull();await h.store.close();
 });
 it('a lost continuation POST only performs GET recovery and never repeats delivery',async()=>{
  const h=await setup();h.ports.key=()=>crypto.randomUUID();h.ports.continuation=vi.fn(async(_p,request)=>{if(request)throw Error('Lost response');return {version:1,wallet:f.identity.wallet,parentClaimId:f.preparation.claimId,status:'unknown',continuation:null,serverNow:f.preparation.serverNow};});await h.c.continueClaim();await h.c.continueClaim();await h.c.open();
  expect(vi.mocked(h.ports.continuation).mock.calls.filter(c=>c[1]!==null)).toHaveLength(1);expect((await h.store.read()).operation!.ordered!.continuationAbsent).toBe(false);await h.store.close();
 });
 it('retains definitive refusal and checked absence before an explicit fresh-key attempt',async()=>{
  const h=await setup(),keys=[crypto.randomUUID(),crypto.randomUUID()];h.ports.key=()=>keys.shift()!;
  h.ports.continuation=vi.fn(async(_p,request,_g,_retain,refusal)=>{if(request){await refusal!({status:409,code:'MINING_CLAIM_NOT_EXPIRED'});throw Error('Not expired');}return {version:1,wallet:f.identity.wallet,parentClaimId:f.preparation.claimId,status:'unknown',continuation:null,serverNow:f.preparation.serverNow};});
  await h.c.continueClaim();await h.c.continueClaim();expect(vi.mocked(h.ports.continuation).mock.calls).toHaveLength(1);await h.c.open();await h.c.continueClaim();
  const ordered=(await h.store.read()).operation!.ordered!;expect(ordered.refusedContinuations).toHaveLength(1);expect(ordered.continuationRefusal?.code).toBe('MINING_CLAIM_NOT_EXPIRED');expect(ordered.continuationAbsent).toBe(false);await h.store.close();
 });
 it('keeps failed setup as unpaid history only while the claim ordinal never entered a wallet',async()=>{
  const h=controller();await h.c.begin('ordered-v0');await h.c.review();await h.c.sign();h.setClaim(f.claim(['failed']));await h.c.open();await h.c.archiveFailed();expect(h.c.snapshot().error).toBeNull();const j=await h.store.read();expect(j.operation).toBeNull();expect(j.archives[0]!.claim!.settledBaseUnits).toBeNull();expect(j.archives[0]!.signed).toEqual(f.signed(0));await h.store.close();
 });
});

it('cannot clear a terminal hold by activating an already retained continuation',async()=>{
 const h=controller();await h.c.begin('ordered-v0');await h.c.review();await h.c.sign();h.setClaim(f.claim(['finalized']));await h.c.open();const link=f.continuation(),envelope={version:1,wallet:f.identity.wallet,parentClaimId:f.preparation.claimId,status:'continued',continuation:link,serverNow:link.createdAt};h.ports.key=()=>link.childPreparation.idempotencyKey;h.ports.continuation=async()=>envelope;await h.c.continueClaim();expect(h.c.snapshot().error).toBeNull();
 h.ports.getClaim=async()=>({...f.claim(['finalized']),state:'settled'});await h.c.open();await h.c.useContinuation();expect(h.c.snapshot().error).toMatch(/held/);const before=await h.store.read();expect(before.operation!.ordered!.held).toBe(true);expect(before.archives).toHaveLength(0);await h.c.archiveFailed();expect(h.c.snapshot().error).toMatch(/held/);await h.c.finish();expect(h.c.snapshot().error).toMatch(/held/);
 await expect(h.store.compareAndSet(before.revision,row=>({...row,archives:[...row.archives,row.operation!],operation:continuedMiningOperation(link)}))).rejects.toThrow();expect((await h.store.read()).operation!.preparation!.claimId).toBe(f.preparation.claimId);await h.store.close();
});
