import {createHash} from 'node:crypto';
import {Keypair,Message,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {describe,it,expect,vi} from 'vitest';
import {MiningTaxClaimRecoveryEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import fixtures from '../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';
import {verifyMiningTaxClaimSettlement,type MiningTaxClaimLocalEvidence} from './settlement';
import type {MiningTaxClaimSigningTrust} from './signing';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fixture(kind:keyof typeof fixtures='combined'){
 const envelope=MiningTaxClaimRecoveryEnvelopeSchema.parse(structuredClone(fixtures[kind])),p=structuredClone(envelope.preparation!);
 const original:MiningTaxClaimLocalEvidence={wallet:p.wallet,request:{idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:{...p.caps}},preparation:p,wires:envelope.wires.map(w=>({ordinal:w.ordinal,wire:Buffer.from(w.signedTransactionHex,'hex').toString('base64'),signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256}))};
 const trust:MiningTaxClaimSigningTrust={genesisHash:p.identity.genesisHash,programId:p.identity.programId,configAddress:p.identity.configAddress,keepMint:p.identity.keepMint,reserveOwner:p.identity.reserveOwner,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256};return {original,envelope,trust};
}
const check=(f:ReturnType<typeof fixture>)=>verifyMiningTaxClaimSettlement(f.original,f.envelope,f.trust);
describe('browser tax owner-attestation binding to original local consent',()=>{
 it.each(['claim','combined','split','setup','aboveQuote'] as const)('binds real signed %s evidence without granting finality, clearing or action authority',async kind=>{
  const f=fixture(kind),result=await check(f);expect(result.recovery).toEqual(f.envelope);expect(result.phase).toBe(f.envelope.status);expect(result).toMatchObject({browserFinalityVerified:false,currentSigningAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false});
  expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.recovery.settlement!.receipt.transactions[0])).toBe(true);expect(result.recovery.settlement!.receipt.journalClearingAuthorized).toBe(false);
 });
 it('requires a positive setup/payment attestation; unknown/prepared/signed never becomes settlement',async()=>{
  for(const status of ['unknown','prepared','signed'] as const){const f=fixture();Object.assign(f.envelope,{status,settlement:null});if(status==='prepared')f.envelope.wires=[];if(status==='unknown')Object.assign(f.envelope,{preparation:null,claimId:null,wires:[]});expect(MiningTaxClaimRecoveryEnvelopeSchema.safeParse(f.envelope).success).toBe(true);await expect(check(f)).rejects.toThrow(/SETTLEMENT/);}
 });
 it('compares every original preparation field even when not encoded into a claim instruction',async()=>{
  for(const change of [(f:ReturnType<typeof fixture>)=>{f.envelope.preparation!.identity.registryHash='ab'.repeat(32);},(f:ReturnType<typeof fixture>)=>{f.envelope.preparation!.source.snapshotSha256='ab'.repeat(32);},(f:ReturnType<typeof fixture>)=>{f.envelope.preparation!.source.firstSnapshotSlot--;},(f:ReturnType<typeof fixture>)=>{f.envelope.preparation!.term.operatingEnd=(BigInt(f.envelope.preparation!.term.operatingEnd)+1n).toString();},(f:ReturnType<typeof fixture>)=>{f.envelope.preparation!.lastValidBlockHeight++;},(f:ReturnType<typeof fixture>)=>{f.envelope.preparation!.fees.payerBalanceLamports='1000001';},(f:ReturnType<typeof fixture>)=>{f.envelope.preparation!.caps.maxTotalLamports='1011';}]){
   const f=fixture();change(f);expect(MiningTaxClaimRecoveryEnvelopeSchema.safeParse(f.envelope).success).toBe(true);await expect(check(f)).rejects.toThrow(/ORIGINAL/);
  }
 });
 it('binds the saved request caps/key/round/spot and wallet before any crypto work',async()=>{
  for(const change of [(o:MiningTaxClaimLocalEvidence)=>{o.wallet=Keypair.generate().publicKey.toBase58();},(o:MiningTaxClaimLocalEvidence)=>{o.request.idempotencyKey='ffffffff-ffff-4fff-8fff-ffffffffffff';},(o:MiningTaxClaimLocalEvidence)=>{o.request.round='9';},(o:MiningTaxClaimLocalEvidence)=>{o.request.spot=1;},(o:MiningTaxClaimLocalEvidence)=>{o.request.caps.maxFeeLamports='11';}]){const f=fixture();change(f.original);await expect(check(f)).rejects.toThrow(/ORIGINAL/);}
 });
 it('refuses self-consistent server replacement of original claim, round, spot or term',async()=>{
  for(const field of ['claimId','round','spot','term']){const f=fixture(),p=f.envelope.preparation!,s=f.envelope.settlement!;
   if(field==='claimId'){const id='ffffffff-ffff-4fff-8fff-ffffffffffff';f.envelope.claimId=p.claimId=s.claimId=id;f.envelope.wires.forEach(w=>{w.claimId=id;});}
   if(field==='round')p.round=s.receipt.round='999';if(field==='spot')p.spot=s.receipt.spot=1;if(field==='term')p.identity.term=s.receipt.term=Keypair.generate().publicKey.toBase58();
   expect(MiningTaxClaimRecoveryEnvelopeSchema.safeParse(f.envelope).success).toBe(true);await expect(check(f)).rejects.toThrow(/ORIGINAL/);
  }
 });
 it.each(['genesisHash','programId','configAddress','keepMint','reserveOwner','reviewedDeploymentSlot','reviewedProgramDataSha256'] as const)('checks independent historical trust pin %s',async field=>{
  const f=fixture(),value=field==='reviewedDeploymentSlot'?0:field==='reviewedProgramDataSha256'?'ab'.repeat(32):Keypair.generate().publicKey.toBase58();f.trust={...f.trust,[field]:value};await expect(check(f)).rejects.toThrow();
 });
 it('refuses a jointly forged Ed25519 signature even when server/local declarations and hashes agree',async()=>{
  const f=fixture(),w=f.envelope.wires[0]!,bytes=Buffer.from(w.signedTransactionHex,'hex');bytes[1]=bytes[1]!^1;
  w.signedTransactionHex=bytes.toString('hex');w.signature=bs58.encode(bytes.subarray(1,65));w.wireSha256=hash(bytes);Object.assign(f.original.wires[0]!,{wire:bytes.toString('base64'),signature:w.signature,wireSha256:w.wireSha256});Object.assign(f.envelope.settlement!.receipt.transactions[0]!,{signature:w.signature,signedTransactionSha256:w.wireSha256});expect(MiningTaxClaimRecoveryEnvelopeSchema.safeParse(f.envelope).success).toBe(true);await expect(check(f)).rejects.toThrow(/WIRE/);
 });
 it('recomputes declared message/wire hashes and validates original ABI even if all declarations agree',async()=>{
  for(const kind of ['wire','message','abi']){const f=fixture(),p=f.original.preparation,w=f.envelope.wires[0]!,local=f.original.wires[0]!,r=f.envelope.settlement!.receipt.transactions[0]!;
   if(kind==='wire')local.wireSha256=w.wireSha256=r.signedTransactionSha256='ab'.repeat(32);
   else if(kind==='message')p.transactions[0]!.messageSha256=f.envelope.preparation!.transactions[0]!.messageSha256=local.messageSha256=w.messageSha256=r.messageSha256='ab'.repeat(32);
   else{const tx=Transaction.populate(Message.from(Buffer.from(p.transactions[0]!.messageHex,'hex')));tx.instructions.at(-1)!.keys[9]!.pubkey=Keypair.generate().publicKey;const message=tx.serializeMessage(),bytes=Buffer.concat([Buffer.from(local.wire,'base64').subarray(0,65),message]);for(const prep of [p,f.envelope.preparation!])Object.assign(prep.transactions[0]!,{messageHex:message.toString('hex'),messageSha256:hash(message),packetBytes:bytes.length});local.wire=bytes.toString('base64');local.messageSha256=w.messageSha256=r.messageSha256=hash(message);local.wireSha256=w.wireSha256=r.signedTransactionSha256=hash(bytes);w.signedTransactionHex=bytes.toString('hex');}
   expect(MiningTaxClaimRecoveryEnvelopeSchema.safeParse(f.envelope).success).toBe(true);await expect(check(f)).rejects.toThrow(/WIRE/);
  }
 });
 it('requires matching locally saved signed prefix and rejects duplicate/reversed/unrelated local wires',async()=>{
  for(const change of [(f:ReturnType<typeof fixture>)=>{f.original.wires=[];},(f:ReturnType<typeof fixture>)=>{f.original.wires=[f.original.wires[1]!];},(f:ReturnType<typeof fixture>)=>{f.original.wires.reverse();},(f:ReturnType<typeof fixture>)=>{f.original.wires=[f.original.wires[0]!,f.original.wires[0]!];},(f:ReturnType<typeof fixture>)=>{f.original.wires[0]!.wire=fixture('claim').original.wires[0]!.wire;}]){const f=fixture('split');change(f);await expect(check(f)).rejects.toThrow();}
 });
 it('allows setup with extra signed custody without turning ordinal1 custody into payment',async()=>{
  const f=fixture('setup');f.original.wires=[f.original.wires[0]!];expect((await check(f)).phase).toBe('setup');
  const g=fixture('setup');g.envelope.wires=[g.envelope.wires[0]!];expect((await check(g)).phase).toBe('setup');
  const h=fixture('setup');h.original.wires=[h.original.wires[1]!];await expect(check(h)).rejects.toThrow(/WIRE/);
  const bad=fixture('setup'),w=bad.envelope.wires[1]!,bytes=Buffer.from(w.signedTransactionHex,'hex');bytes[1]=bytes[1]!^1;w.signedTransactionHex=bytes.toString('hex');w.signature=bs58.encode(bytes.subarray(1,65));w.wireSha256=hash(bytes);bad.original.wires=[bad.original.wires[0]!];expect(MiningTaxClaimRecoveryEnvelopeSchema.safeParse(bad.envelope).success).toBe(true);await expect(check(bad)).rejects.toThrow(/WIRE/);
 });
 it('preserves historical recovery after expiry and never reads current provider/pause state',async()=>{
  const f=fixture();vi.useFakeTimers();try{vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));expect((await check(f)).phase).toBe('settled');}finally{vi.useRealTimers();}
 });
 it('rejects changed parsed objects anew and bounds local collections before traversal',async()=>{
  const f=fixture();await check(f);f.envelope.preparation!.identity.registryHash='ab'.repeat(32);await expect(check(f)).rejects.toThrow(/ORIGINAL/);
  let touched=0;const huge=Array(10000);Object.defineProperty(huge,0,{get(){touched++;throw Error('must not traverse');}});const g=fixture();g.original.wires=huge;await expect(check(g)).rejects.toThrow(/INPUT/);expect(touched).toBe(0);
  await expect(verifyMiningTaxClaimSettlement({...fixture().original,extra:true},fixture().envelope,fixture().trust)).rejects.toThrow(/INPUT/);
 });
 it('owns original request/preparation/wires, envelope and trust before its first digest await',async()=>{
  const f=fixture(),saved=structuredClone(f.envelope),digest=crypto.subtle.digest.bind(crypto.subtle);let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});const spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(algorithm,bytes)=>{await waiting;return digest(algorithm,bytes);});
  try{const pending=check(f);f.original.wallet='changed';f.original.request.caps.maxFeeLamports='0';f.original.preparation.identity.registryHash='ab'.repeat(32);f.original.wires[0]!.wire='changed';f.envelope.settlement!.receipt.paidKeepBaseUnits='0';(f.trust as {programId:string}).programId=Keypair.generate().publicKey.toBase58();release();expect((await pending).recovery).toEqual(saved);}finally{spy.mockRestore();}
 });
});
