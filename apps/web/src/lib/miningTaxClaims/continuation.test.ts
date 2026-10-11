import {createHash} from 'node:crypto';
import {Keypair,Message,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {describe,it,expect,vi} from 'vitest';
import {MiningTaxClaimContinuationEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimContinuationApi';
import {MiningTaxClaimRecoveryEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import data from '../../../../../packages/shared/src/testFixtures/miningTaxClaimContinuationApi.json';
import {verifyMiningTaxClaimContinuation} from './continuation';
import type {MiningTaxClaimLocalEvidence} from './settlement';
import type {MiningTaxClaimSigningTrust} from './signing';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const envelope=MiningTaxClaimContinuationEnvelopeSchema.parse(structuredClone(data)),c=envelope.continuation!,p=structuredClone(c.parentPreparation),w=c.parentWire;
 const original:MiningTaxClaimLocalEvidence={wallet:p.wallet,request:{idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:{...p.caps}},preparation:p,wires:[{ordinal:0,wire:Buffer.from(w.signedTransactionHex,'hex').toString('base64'),signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256}]};
 const setup=MiningTaxClaimRecoveryEnvelopeSchema.parse({wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,status:'setup',preparation:p,wires:[w],settlement:c.parentSetup,serverNow:p.preparedAt}),request={idempotencyKey:c.childPreparation.idempotencyKey,caps:{...c.childPreparation.caps}};
 const trust:MiningTaxClaimSigningTrust={genesisHash:p.identity.genesisHash,programId:p.identity.programId,configAddress:p.identity.configAddress,keepMint:p.identity.keepMint,reserveOwner:p.identity.reserveOwner,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256};return {original,setup,request,envelope,trust};
}
type F=ReturnType<typeof fixture>;
const check=(f:F)=>verifyMiningTaxClaimContinuation(f.original,f.setup,f.request,f.envelope,f.trust);
describe('browser immutable split continuation binding',()=>{
 it('binds actual setup and distinct unsigned child with separate additional caps and no action authority',async()=>{
  const f=fixture(),bound=await check(f);expect(bound.envelope).toEqual(f.envelope);expect(bound).toMatchObject({browserFinalityVerified:false,currentSigningAuthorized:false,broadcastAuthorized:false,relayAuthorized:false,settlementAuthorized:false,journalClearingAuthorized:false});expect(bound.envelope.continuation!.parentSetup.receipt.feeLamports).toBe('6');expect(bound.envelope.continuation!.childPreparation.fees.feeLamports).toBe('5');expect(Object.isFrozen(bound)).toBe(true);expect(Object.isFrozen(bound.envelope.continuation!.childPreparation.transactions[0])).toBe(true);
 });
 it('requires a positive link and exact saved setup, never treating unknown as continuation',async()=>{
  const f=fixture();f.envelope.status='unknown';f.envelope.continuation=null;await expect(check(f)).rejects.toThrow();
  const g=fixture();g.setup.status='signed';g.setup.settlement=null;await expect(check(g)).rejects.toThrow();
  await expect(verifyMiningTaxClaimContinuation(fixture().original,null,fixture().request,fixture().envelope,fixture().trust)).rejects.toThrow();
 });
 it('binds explicit pending child key and every additional cap',async()=>{
  for(const mutate of [(f:F)=>{f.request.idempotencyKey='ffffffff-ffff-4fff-8fff-ffffffffffff';},(f:F)=>{f.request.caps.maxFeeLamports='11';},(f:F)=>{f.request.caps.maxRentLamports='1001';},(f:F)=>{f.request.caps.maxTotalLamports='1011';}]){const f=fixture();mutate(f);await expect(check(f)).rejects.toThrow(/REQUEST/);}
 });
 it('requires the same parent consent and setup receipt even for fields not encoded in the message',async()=>{
  for(const mutate of [(f:F)=>{f.envelope.continuation!.parentPreparation.source.snapshotSha256='ab'.repeat(32);},(f:F)=>{f.envelope.continuation!.parentSetup.settledAt='2026-09-27T00:00:00.000000Z';},(f:F)=>{f.original.request.caps.maxFeeLamports='11';},(f:F)=>{f.setup.settlement!.settledAt='2026-09-27T00:00:00.000000Z';}]){const f=fixture();mutate(f);await expect(check(f)).rejects.toThrow();}
 });
 it('requires exact locally retained signed setup bytes and rechecks its signature',async()=>{
  const missing=fixture();missing.original.wires=[];await expect(check(missing)).rejects.toThrow();
  const f=fixture(),c=f.envelope.continuation!,bytes=Buffer.from(c.parentWire.signedTransactionHex,'hex');bytes[1]=bytes[1]!^1;const signature=bs58.encode(bytes.subarray(1,65)),wireSha256=hash(bytes);
  for(const w of [c.parentWire,f.setup.wires[0]!])Object.assign(w,{signedTransactionHex:bytes.toString('hex'),signature,wireSha256});
  for(const s of [c.parentSetup,f.setup.settlement!])Object.assign(s.receipt.transactions[0]!,{signature,signedTransactionSha256:wireSha256});Object.assign(f.original.wires[0]!,{wire:bytes.toString('base64'),signature,wireSha256});
  expect(MiningTaxClaimContinuationEnvelopeSchema.safeParse(f.envelope).success).toBe(true);expect(MiningTaxClaimRecoveryEnvelopeSchema.safeParse(f.setup).success).toBe(true);await expect(check(f)).rejects.toThrow();
 });
 it('recomputes child message hashes instead of trusting matching declarations',async()=>{const f=fixture();f.envelope.continuation!.childPreparation.transactions[0]!.messageSha256='ab'.repeat(32);expect(MiningTaxClaimContinuationEnvelopeSchema.safeParse(f.envelope).success).toBe(true);await expect(check(f)).rejects.toThrow(/WIRE/);});
 it('rejects a self-consistent child ABI replacement even with its correct new hash',async()=>{
  const f=fixture(),packet=f.envelope.continuation!.childPreparation.transactions[0]!,tx=Transaction.populate(Message.from(Buffer.from(packet.messageHex,'hex')));tx.instructions.at(-1)!.keys[9]!.pubkey=Keypair.generate().publicKey;const message=tx.serializeMessage();Object.assign(packet,{messageHex:message.toString('hex'),messageSha256:hash(message),packetBytes:message.length+65});expect(MiningTaxClaimContinuationEnvelopeSchema.safeParse(f.envelope).success).toBe(true);await expect(check(f)).rejects.toThrow(/WIRE/);
 });
 it('rejects jointly replaced permanent PDA identity and checks independent historical pins',async()=>{
  const f=fixture(),c=f.envelope.continuation!,registry=Keypair.generate().publicKey.toBase58();for(const p of [f.original.preparation,f.setup.preparation!,c.parentPreparation,c.childPreparation])p.identity.registry=registry;expect(MiningTaxClaimContinuationEnvelopeSchema.safeParse(f.envelope).success).toBe(true);expect(MiningTaxClaimRecoveryEnvelopeSchema.safeParse(f.setup).success).toBe(true);await expect(check(f)).rejects.toThrow(/WIRE/);
  for(const field of ['genesisHash','programId','configAddress','keepMint','reserveOwner','reviewedDeploymentSlot','reviewedProgramDataSha256'] as const){const g=fixture();g.trust={...g.trust,[field]:field==='reviewedDeploymentSlot'?0:field==='reviewedProgramDataSha256'?'ab'.repeat(32):Keypair.generate().publicKey.toBase58()};await expect(check(g)).rejects.toThrow(/TRUST/);}
 });
 it('rejects stale bank ordering and all caller supplied authority',async()=>{
  for(const mutate of [(f:F)=>{f.envelope.continuation!.childPreparation.source.firstSnapshotSlot=f.envelope.continuation!.expiry.slot-1;},(f:F)=>{f.envelope.continuation!.expiry.blockHeight=f.envelope.continuation!.parentPreparation.lastValidBlockHeight;}]){const f=fixture();mutate(f);await expect(check(f)).rejects.toThrow();}
  for(const key of ['currentSigningAuthorized','relayAuthorized','settlementAuthorized','journalClearingAuthorized']){const f=fixture();await expect(verifyMiningTaxClaimContinuation(f.original,f.setup,f.request,{...f.envelope,continuation:{...f.envelope.continuation,[key]:true}},f.trust)).rejects.toThrow();}
  for(const extra of [{wallet:fixture().original.wallet},{parentClaimId:fixture().original.preparation.claimId},{[Symbol('authority')]:true}]){const f=fixture();await expect(verifyMiningTaxClaimContinuation(f.original,f.setup,{...f.request,...extra},f.envelope,f.trust)).rejects.toThrow(/INPUT/);}
 });
 it('bounds local custody and rejects duplicate setup prefix',async()=>{
  const f=fixture();f.original.wires=[f.original.wires[0]!,f.original.wires[0]!];await expect(check(f)).rejects.toThrow();
  const g=fixture();let touched=0;const huge=Array(10000);Object.defineProperty(huge,0,{get(){touched++;throw Error('must not traverse');}});g.original.wires=huge;await expect(check(g)).rejects.toThrow();expect(touched).toBe(0);
 });
 it('keeps historical binding available after expiry without a current provider',async()=>{
  vi.useFakeTimers();try{vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));expect((await check(fixture())).envelope.status).toBe('continued');}finally{vi.useRealTimers();}
 });
 it('owns parent, saved setup, pending caps, link and trust before the first digest await',async()=>{
  const f=fixture(),saved=structuredClone(f.envelope),digest=crypto.subtle.digest.bind(crypto.subtle);let release!:()=>void;const wait=new Promise<void>(r=>{release=r;}),spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(algorithm,bytes)=>{await wait;return digest(algorithm,bytes);});
  try{const pending=check(f);f.original.preparation.source.snapshotSha256='ab'.repeat(32);f.original.wires[0]!.wire='changed';f.setup.settlement!.settledAt='2026-09-27T00:00:00.000000Z';f.request.caps.maxFeeLamports='0';f.envelope.continuation!.childPreparation.transactions[0]!.messageSha256='ab'.repeat(32);(f.trust as {programId:string}).programId=Keypair.generate().publicKey.toBase58();release();expect((await pending).envelope).toEqual(saved);}finally{release();spy.mockRestore();}
 });
});
