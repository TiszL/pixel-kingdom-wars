import {it,expect} from 'vitest';
import {CharterRetirementOperationSchema,CharterRetirementRequestSchema} from '@shardkeep/shared/charterRetirementApi';
import {prepareRetirementSigning,signRetirement,verifyRetirementWire} from './signing';
import {retirementFixture} from './testFixture';
it('reconstructs the permanent retirement consent and matches the independently built SDK wire',async()=>{
 const f=await retirementFixture(),p=await prepareRetirementSigning(f.operation,f.trust,f.actor);
 const wire=await signRetirement(p,{publicKey:f.leader.publicKey,signVersionedTransaction:async tx=>{tx.sign([f.leader]);return tx;}});
 expect(wire.signedTransactionHex).toBe(f.wire.toString('hex'));expect(await verifyRetirementWire(f.operation,wire)).toEqual(wire);
});
it('requires independent deployment, policy and lookup pins before wallet consent',async()=>{
 const f=await retirementFixture();for(const trust of [{...f.trust,policySigner:f.actor},{...f.trust,lookupTables:[]},{...f.trust,deployment:{...f.trust.deployment,economy:{...f.trust.deployment.economy,reviewedProgramDataSha256:'00'.repeat(32)}}}])
  await expect(prepareRetirementSigning(f.operation,trust,f.actor)).rejects.toThrow('Independent');
 await expect(prepareRetirementSigning(f.operation,f.trust,f.policy.publicKey.toBase58())).rejects.toThrow('leader');
});
it('binds the exact clan, clearance, revision and permanent receipt in the signed permit',async()=>{
 const f=await retirementFixture();for(const change of [{clearanceHash:'ab'.repeat(32)},{expectedRevision:1},{fenceId:f.operation.memberPayment.id},{id:f.operation.memberPayment.id}]){
  const v=structuredClone(f.operation);Object.assign(v.original.retirement,change);v.attempt!.quote.packetInput.original=structuredClone(v.original);
  await expect(prepareRetirementSigning(v,f.trust,f.actor)).rejects.toThrow();
 }
});
it('rejects changed policy signatures, ALT bytes, fees and expired blockhash bounds',async()=>{
 const f=await retirementFixture();for(const change of [(v:typeof f.operation)=>{v.preparation!.policySignatureHex='00'.repeat(64);},
  (v:typeof f.operation)=>{v.attempt!.quote.packetInput.lookupTable.dataHex='00'+v.attempt!.quote.packetInput.lookupTable.dataHex.slice(2);},
  (v:typeof f.operation)=>{v.attempt!.quote.costs.totalLamports='0';},
  (v:typeof f.operation)=>{v.attempt!.quote.costs.allocations[1]!.address=f.actor;},
  (v:typeof f.operation)=>{v.attempt!.quote.packetInput.currentBlockHeight=v.attempt!.quote.packetInput.lastValidBlockHeight+1;}]){
  const v=structuredClone(f.operation);change(v);await expect(prepareRetirementSigning(v,f.trust,f.actor)).rejects.toThrow();
 }
});
it('rejects fabricated prepared objects, unsigned responses and wallet message replacement',async()=>{
 const f=await retirementFixture(),p=await prepareRetirementSigning(f.operation,f.trust,f.actor),wallet={publicKey:f.leader.publicKey,signVersionedTransaction:async(tx:Parameters<NonNullable<Parameters<typeof signRetirement>[1]['signVersionedTransaction']>>[0])=>tx};
 await expect(signRetirement({...p},wallet)).rejects.toThrow('signer changed');await expect(signRetirement(p,wallet)).rejects.toThrow('signature');
 await expect(signRetirement(p,{...wallet,signVersionedTransaction:async tx=>{tx.message.recentBlockhash=f.actor;tx.sign([f.leader]);return tx;}})).rejects.toThrow();
});
it('preserves immutable signed history after completion without reopening wallet approval',async()=>{
 const f=await retirementFixture(),p=await prepareRetirementSigning(f.operation,f.trust,f.actor),bytes=p.unsignedTransaction;bytes.fill(0);expect(p.unsignedTransaction[0]).toBe(1);
 const wire=await signRetirement(p,{publicKey:f.leader.publicKey,signVersionedTransaction:async tx=>{tx.sign([f.leader]);return tx;}});
 const terminal={...f.operation,status:'completed' as const,signed:wire,terminal:{id:f.operation.memberPayment.id,outcome:'completed' as const}};
 expect(await verifyRetirementWire(terminal,wire)).toEqual(wire);await expect(prepareRetirementSigning(terminal,f.trust,f.actor)).rejects.toThrow('not awaiting');
 await expect(verifyRetirementWire(terminal,{...wire,signedTransactionHex:'01'+'00'.repeat(64)+wire.signedTransactionHex.slice(130)})).rejects.toThrow();
});
it('refuses caller authority or completion without signed backing in the public contract',async()=>{
 const f=await retirementFixture();expect(CharterRetirementOperationSchema.safeParse({...f.operation,retirementAuthorized:true}).success).toBe(false);
 expect(CharterRetirementOperationSchema.safeParse({...f.operation,status:'completed',terminal:{id:f.operation.memberPayment.id,outcome:'completed'}}).success).toBe(false);
 const request={clanId:f.original.creation.clanId,idempotencyKey:f.original.retirement.id};expect(CharterRetirementRequestSchema.parse(request)).toEqual(request);
 expect(CharterRetirementRequestSchema.safeParse({...request,clearanceHash:'ab'.repeat(32)}).success).toBe(false);
});
