import {createHash} from 'node:crypto';
import {VersionedTransaction,Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,it,expect,vi} from 'vitest';
import {CharterSigningSchema} from '@shardkeep/shared/charterApi';
import {charterClientFixture} from './testFixture';
import {prepareCharterSigning,signCharter,verifyCharterContribution,verifyCharterWire} from './signing';
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
describe('ordinary Charter client exact consent',()=>{
 it('one independently frozen static ALT serves distinct future clans and maximum admitted metadata',()=>{
  const f=charterClientFixture(),a=f.pair(1,true),b=f.pair(2,true,false);
  expect(f.staticKeys).toHaveLength(12);expect(new Set(f.staticKeys.map(k=>k.toBase58())).size).toBe(12);
  for(const p of [a,b]){expect(p.creation.original.metadata.name).toHaveLength(24);expect(p.creation.original.metadata.uri).toHaveLength(292);expect(p.creation.packet.packetBytes).toBe(1228);expect(p.sale.packet.packetBytes).toBeLessThanOrEqual(1232);
   for(const s of [p.creation,p.sale])expect(s.lookupPin).toEqual(f.lookupPin);
   for(const key of [p.creation.original.chain.asset,p.creation.original.chain.charter,p.creation.original.chain.freezeAuthority,p.creation.original.chain.executor,p.creation.original.chain.creationReceipt,p.creator.publicKey.toBase58(),p.buyer.publicKey.toBase58()])expect(f.staticKeys.map(k=>k.toBase58())).not.toContain(key);
  }
  expect(a.creation.original.clanId).not.toBe(b.creation.original.clanId);expect(a.creation.original.chain.asset).not.toBe(b.creation.original.chain.asset);
 });
 it('the bounded schema accepts the real creation and sale review inputs without granting authority',()=>{
  const f=charterClientFixture(),p=f.pair(3,true);for(const value of [p.creation,p.sale])expect(CharterSigningSchema.parse(value)).toEqual(value);
 });
 it('browser reconstruction matches the original v0 message for creator and both sale signer slots',async()=>{
  const f=charterClientFixture(),p=f.pair(4,true);for(const [value,wallet] of [[p.creation,p.creator.publicKey.toBase58()],[p.sale,p.creator.publicKey.toBase58()],[p.sale,p.buyer.publicKey.toBase58()]] as const){const approved=await prepareCharterSigning(value,f.trust,wallet);expect(Buffer.from(approved.unsignedTransaction).toString('hex')).toBe(value.packet.unsignedTransactionHex);expect(approved.wallet).toBe(wallet);}
 });
 it('refuses server-selected deployments, policy, treasury and table even when a valid policy signed the returned packet',async()=>{
  const f=charterClientFixture(),p=f.pair(5);for(const change of [{...f.trust,policySigner:Keypair.generate().publicKey.toBase58()},{...f.trust,treasury:Keypair.generate().publicKey.toBase58()},{...f.trust,lookupTables:[{...f.lookupPin,dataSha256:'00'.repeat(32)}]},{...f.trust,deployment:{...f.trust.deployment,craft:{...f.trust.deployment.craft,reviewedDeploymentSlot:91}}}])await expect(prepareCharterSigning(p.sale,change,p.creator.publicKey.toBase58())).rejects.toMatchObject({code:'TRUST'});
 });
 it('binds buyer review including seller stays or leaves, royalty, metadata and original revision to the actual signed packet',async()=>{
  const f=charterClientFixture(),p=f.pair(6);const changedTerms=structuredClone(p.sale);changedTerms.original.terms.sellerLeaves=!changedTerms.original.terms.sellerLeaves;
  const changedRevision=structuredClone(p.sale);changedRevision.original.terms.expectedRevision++;
  const changedCost=structuredClone(p.sale);changedCost.costs.royaltyLamports='0';
  const changedMetadata=structuredClone(p.creation);changedMetadata.original.metadata.uri='https://evil.invalid/change';
  for(const value of [changedTerms,changedRevision,changedCost,changedMetadata])await expect(prepareCharterSigning(value,f.trust,p.creator.publicKey.toBase58())).rejects.toThrow();
 });
 it('extracts each real wallet signature independently without sending or relying on another wallet preserving it',async()=>{
  const f=charterClientFixture(),p=f.pair(7),send=vi.fn();for(const signer of [p.creator,p.buyer]){
   const prepared=await prepareCharterSigning(p.sale,f.trust,signer.publicKey.toBase58()),sign=vi.fn(async(tx:VersionedTransaction)=>{tx.sign([signer]);return tx;});
   const out=await signCharter(prepared,{publicKey:signer.publicKey,signMessage:null,isEmbedded:false,sendTransaction:send,signVersionedTransaction:sign});expect(out.kind).toBe('sale');if(out.kind!=='sale')throw Error('Expected contribution');
   expect(await verifyCharterContribution(p.sale,signer.publicKey.toBase58(),out.contribution)).toEqual(out.contribution);expect(sign).toHaveBeenCalledTimes(1);
  }expect(send).not.toHaveBeenCalled();
 });
 it('requires both real signatures over the complete canonical wire for recovery and rejects message or trailing-byte substitution',async()=>{
  const f=charterClientFixture(),p=f.pair(8),tx=VersionedTransaction.deserialize(Buffer.from(p.sale.packet.unsignedTransactionHex,'hex'));tx.sign([p.buyer,p.creator]);
  const bytes=Buffer.from(tx.serialize()),wire={signedTransaction:bytes.toString('base64'),signature:bs58.encode(tx.signatures[0]!),wireSha256:digest(bytes),messageSha256:p.sale.packet.messageSha256};expect(await verifyCharterWire(p.sale,wire)).toEqual(wire);
  const badSignature=Buffer.from(bytes),badMessage=Buffer.from(bytes);badSignature[65]=badSignature[65]!^1;badMessage[bytes.length-1]=badMessage[bytes.length-1]!^1;
  for(const mutated of [Buffer.concat([bytes,Buffer.of(0)]),badSignature,badMessage])await expect(verifyCharterWire(p.sale,{...wire,signedTransaction:mutated.toString('base64'),wireSha256:digest(mutated)})).rejects.toThrow();
  const one=VersionedTransaction.deserialize(Buffer.from(p.sale.packet.unsignedTransactionHex,'hex'));one.sign([p.buyer]);const raw=Buffer.from(one.serialize());await expect(verifyCharterWire(p.sale,{...wire,signedTransaction:raw.toString('base64'),wireSha256:digest(raw)})).rejects.toThrow();
 });
 it('owns immutable packet copies and keeps valid late wallet evidence before any obsolete-view guard',async()=>{
  const f=charterClientFixture(),p=f.pair(9),mutable=structuredClone(p.creation),prepared=await prepareCharterSigning(mutable,f.trust,p.creator.publicKey.toBase58());prepared.unsignedTransaction.fill(0);expect(Buffer.from(prepared.unsignedTransaction).toString('hex')).toBe(p.creation.packet.unsignedTransactionHex);
  let release!:(v:VersionedTransaction)=>void;const pending=new Promise<VersionedTransaction>(resolve=>{release=resolve;});const result=signCharter(prepared,{publicKey:p.creator.publicKey,signMessage:null,isEmbedded:false,sendTransaction:null,signVersionedTransaction:async tx=>{tx.sign([p.creator]);queueMicrotask(()=>release(tx));return pending;}});
  mutable.packet.messageHex='00';const signed=await result;expect(signed.kind).toBe('creation');
 });
 it('holds unsupported cryptography explicitly instead of treating structural parsing as signature proof',async()=>{
  const f=charterClientFixture(),p=f.pair(10);vi.stubGlobal('crypto',{});try{await expect(prepareCharterSigning(p.sale,f.trust,p.creator.publicKey.toBase58())).rejects.toMatchObject({code:'CRYPTO_UNAVAILABLE'});}finally{vi.unstubAllGlobals();}
 });
});
