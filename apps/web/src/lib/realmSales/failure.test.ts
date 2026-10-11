import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {describe,it,expect,vi} from 'vitest';
import {validateRealmSaleFailure} from '@shardkeep/shared/realmSaleFailureApi';
import {realmSaleBrowserFailureFixture} from './failure.test-support';
import {verifyRealmSaleFailure} from './failure';
type Fixture=Awaited<ReturnType<typeof realmSaleBrowserFailureFixture>>;
const check=(f:Fixture)=>verifyRealmSaleFailure(f.preparation,f.wire,f.failure,f.trust);
const address=new PublicKey(Buffer.alloc(32,19)).toBase58();
describe('browser original realm failed-purchase cryptographic binding',()=>{
 it.each([false,true].flatMap(needsAccess=>[false,true].map(needsQuota=>({needsAccess,needsQuota}))))('binds complete failed packet for optional accounts %j',async options=>{
  const f=await realmSaleBrowserFailureFixture(options),bound=await check(f);expect(bound.failure).toEqual(f.failure);expect(bound.browserFinalityVerified).toBe(false);expect(bound.journalClearingAuthorized).toBe(false);expect(bound.currentSigningAuthorized).toBe(false);expect(bound.broadcastAuthorized).toBe(false);
 });
 it.each(['seller','developer','both','recipients','new-access'] as const)('preserves fee-only failure under %s recipient aliasing',async alias=>{const f=await realmSaleBrowserFailureFixture({alias});expect((await check(f)).failure).toEqual(f.failure);});
 it('rejects forged signature bytes even when all declared identities and hashes agree',async()=>{
  const f=await realmSaleBrowserFailureFixture(),wire=Buffer.from(f.wire.signedTransactionHex,'hex');wire[1]=wire[1]!^1;f.wire.signedTransactionHex=wire.toString('hex');f.wire.wireSha256=f.failure.receipt.signedTransactionSha256=createHash('sha256').update(wire).digest('hex');f.wire.signature=f.failure.receipt.signature=bs58.encode(wire.subarray(1,65));expect(()=>validateRealmSaleFailure(f.preparation,f.wire,f.failure)).not.toThrow();await expect(check(f)).rejects.toThrow();
 });
 it('recomputes the signed wire digest and binds the actual signature',async()=>{
  for(const kind of ['hash','signature']){const f=await realmSaleBrowserFailureFixture();if(kind==='hash')f.wire.wireSha256=f.failure.receipt.signedTransactionSha256='ab'.repeat(32);else f.wire.signature=f.failure.receipt.signature=bs58.encode(Buffer.alloc(64,17));expect(()=>validateRealmSaleFailure(f.preparation,f.wire,f.failure)).not.toThrow();await expect(check(f)).rejects.toThrow();}
 });
 it('requires independent historical deployment, developer, revision and upgrade authority pins',async()=>{
  for(const key of ['genesisHash','programId','developer','reviewedProgramDataSha256','reviewedDeploymentSlot','revision','upgradeAuthority'] as const){const f=await realmSaleBrowserFailureFixture();const trust={...f.trust,[key]:key==='reviewedDeploymentSlot'?f.trust.reviewedDeploymentSlot+1:key==='reviewedProgramDataSha256'?'ab'.repeat(32):key==='revision'?'other':address};await expect(verifyRealmSaleFailure(f.preparation,f.wire,f.failure,trust)).rejects.toThrow();}
 });
 it('derives the exact program, program-data and Clock accounts',async()=>{
  for(const i of [0,1,2]){const f=await realmSaleBrowserFailureFixture();f.failure.receipt.source.accounts[i]!.address=address;await expect(check(f)).rejects.toThrow();}
 });
 it('does not reinterpret nullable blockTime or a charged fee above quote as payment or refund',async()=>{const f=await realmSaleBrowserFailureFixture();f.failure.receipt.blockTime=null;f.failure.receipt.feeLamports=(BigInt(f.preparation.quote.feeLamports)+1n).toString();const bound=await check(f);expect(bound.failure.receipt.feeLamports).toBe(f.failure.receipt.feeLamports);expect(bound.failure.receipt.buyerNetPaymentLamports).toBe('0');expect(bound.failure.receipt.actualRentLamports).toBe('0');});
 it('owns preparation, wire, failure and application pins before asynchronous cryptography',async()=>{
  const f=await realmSaleBrowserFailureFixture(),original=structuredClone(f.failure),digest=crypto.subtle.digest.bind(crypto.subtle);let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(algorithm,data)=>{await held;return digest(algorithm,data);});
  try{const pending=check(f);f.preparation.wallet=address;f.wire.signedTransactionHex='00';f.failure.receipt.signature=bs58.encode(Buffer.alloc(64,17));f.trust.programId=address;release();const bound=await pending;expect(bound.failure).toEqual(original);expect(Object.isFrozen(bound)).toBe(true);expect(Object.isFrozen(bound.failure.receipt.source.accounts)).toBe(true);}finally{spy.mockRestore();}
 });
});
