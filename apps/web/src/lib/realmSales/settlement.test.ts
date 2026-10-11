import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {describe,it,expect,vi} from 'vitest';
import {validateRealmSaleSettlement} from '@shardkeep/shared/realmSaleSettlementApi';
import {realmSaleSettlementFixture} from './settlement.test-support';
import {verifyRealmSaleSettlement} from './settlement';
type Fixture=Awaited<ReturnType<typeof realmSaleSettlementFixture>>;
const check=(f:Fixture)=>verifyRealmSaleSettlement(f.preparation,f.wire,f.settlement);
function receiptBytes(f:Fixture,change:(b:Buffer)=>void){const b=Buffer.from(f.settlement.receipt.receiptAccountHex,'hex');change(b);f.settlement.receipt.receiptAccountHex=b.toString('hex');f.settlement.receipt.source.accounts[5]!.dataSha256=createHash('sha256').update(b).digest('hex');}
describe('browser cryptographic original realm-sale settlement binding',()=>{
 it.each([false,true].flatMap(needsAccess=>[false,true].flatMap(needsQuota=>([undefined,'seller','developer','both','recipients'] as const).map(alias=>({needsAccess,needsQuota,alias})))))(
  'matches actual Anchor receipt, SDK message and owner-finality fixtures %j',async options=>{
   const f=await realmSaleSettlementFixture({needsAccess:options.needsAccess,needsQuota:options.needsQuota,...options.alias?{alias:options.alias}:{}}),result=await check(f);expect(result).toEqual(f.settlement);expect(result).not.toHaveProperty('finalityVerified');expect(result).not.toHaveProperty('journalReleaseAuthorized');expect(result.signingAuthorized).toBe(false);
  });
 it('retains prefunded-PDA rent and seller aliasing the newly allocated access account',async()=>{
  for(const options of [{prefunded:true},{alias:'new-access' as const}]){const f=await realmSaleSettlementFixture(options);expect(await check(f)).toEqual(f.settlement);}
 });
 it('rejects a forged buyer signature even when every declared hash and signature is recomputed',async()=>{
  const f=await realmSaleSettlementFixture(),bytes=Buffer.from(f.wire.signedTransactionHex,'hex');bytes[1]=bytes[1]!^1;
  f.wire.signedTransactionHex=bytes.toString('hex');f.wire.wireSha256=f.settlement.receipt.signedTransactionSha256=createHash('sha256').update(bytes).digest('hex');f.wire.signature=f.settlement.signature=f.settlement.receipt.signature=bs58.encode(bytes.subarray(1,65));
 expect(()=>validateRealmSaleSettlement(f.preparation,f.wire,f.settlement)).not.toThrow();await expect(check(f)).rejects.toThrow();
 });
 it('binds the declared signature to the actual signed packet',async()=>{
  const f=await realmSaleSettlementFixture();f.wire.signature=f.settlement.signature=f.settlement.receipt.signature=bs58.encode(Buffer.alloc(64,17));expect(()=>validateRealmSaleSettlement(f.preparation,f.wire,f.settlement)).not.toThrow();await expect(check(f)).rejects.toThrow();
 });
 it('recomputes wire and receipt hashes instead of trusting internally consistent declarations',async()=>{
  for(const kind of ['wire','receipt'] as const){const f=await realmSaleSettlementFixture();if(kind==='wire')f.wire.wireSha256=f.settlement.receipt.signedTransactionSha256='ab'.repeat(32);else f.settlement.receipt.source.accounts[5]!.dataSha256='ab'.repeat(32);expect(()=>validateRealmSaleSettlement(f.preparation,f.wire,f.settlement)).not.toThrow();await expect(check(f)).rejects.toThrow();}
 });
 it('derives every source identity including existing access without an access rent entry',async()=>{
  for(const i of [1,2,3]){const f=await realmSaleSettlementFixture({needsAccess:false,needsQuota:false});f.settlement.receipt.source.accounts[i]!.address=new PublicKey(Buffer.alloc(32,19)).toBase58();expect(()=>validateRealmSaleSettlement(f.preparation,f.wire,f.settlement)).not.toThrow();await expect(check(f)).rejects.toThrow();}
 });
 it('binds every receipt field including hidden ABI discriminator, version, config, registry, term and bump after recomputed hashes',async()=>{
  // One mutation per fixed ABI field; DTO-only consistency intentionally cannot see these bytes.
  for(const offset of [0,8,9,41,57,89,121,153,185,186,187,195,203,205,237,245,253,261,269,277,285,293]){
   const f=await realmSaleSettlementFixture();receiptBytes(f,b=>{b[offset]=b[offset]!^1;});expect(()=>validateRealmSaleSettlement(f.preparation,f.wire,f.settlement)).not.toThrow();await expect(check(f)).rejects.toThrow();
  }
 });
 it('owns all three inputs before the first await and freezes the verified historical result',async()=>{
  const f=await realmSaleSettlementFixture(),original=structuredClone(f.settlement),digest=crypto.subtle.digest.bind(crypto.subtle);let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});const spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(algorithm,data)=>{await waiting;return digest(algorithm,data);});
  try{const pending=check(f);f.preparation.wallet=new PublicKey(Buffer.alloc(32,19)).toBase58();f.wire.signedTransactionHex='00';f.settlement.purchase.expiresAt='0';f.settlement.receipt.source.accounts[5]!.dataSha256='ab'.repeat(32);release();const result=await pending;expect(result).toEqual(original);expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.receipt.source.accounts[5])).toBe(true);}finally{spy.mockRestore();}
 });
});
