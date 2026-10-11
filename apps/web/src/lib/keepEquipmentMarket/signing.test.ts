import {webcrypto} from 'node:crypto';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {canonicalKeepEquipmentMessage,prepareKeepEquipmentSigning,signKeepEquipment,verifyKeepEquipmentWire,keepEquipmentTrust} from './signing';
import {keepMarketFixture} from './fixtures.testHelpers';
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(()=>vi.unstubAllGlobals());
it.each([['legacy',false],['legacy',true],[0,false],[0,true]] as const)('independently rebuilds %s ATA=%s exact90/10 transfer and actual burn before sign-only approval',async(version,createAta)=>{
 const f=keepMarketFixture(version,createAta),built=await canonicalKeepEquipmentMessage(f.value);expect(built.sellerBaseUnits).toBe('900000');expect(built.burnBaseUnits).toBe('100001');expect(Array.from(built.message)).toEqual(Array.from(f.built.messageBytes));
 const prepared=await prepareKeepEquipmentSigning(f.value,f.trust,f.value.fill.buyerWallet),copy=prepared.unsignedTransaction;copy.fill(0);expect(prepared.unsignedTransaction).not.toEqual(copy);
 const wire=await signKeepEquipment(prepared,f.signer);expect(await verifyKeepEquipmentWire(f.value,wire)).toEqual(wire);expect(wire.messageSha256).toBe(f.built.messageSha256);
});
it.each(['seller','mint','amount','blockhash','rent','version','destination'] as const)('refuses changed %s terms while preserving the original payment identity',async field=>{
 const f=keepMarketFixture('legacy',true),v=structuredClone(f.value),p=v.preparation!;
 if(field==='seller')v.fill.sellerWallet=p.original.seller=Keypair.generate().publicKey.toBase58();
 if(field==='mint')p.expectedKeepMint=p.original.keepMint=Keypair.generate().publicKey.toBase58();
 if(field==='amount')v.fill.unitPriceBaseUnits=v.fill.totalBaseUnits=p.original.totalBaseUnits='2000001';
 if(field==='blockhash')p.blockhash=Keypair.generate().publicKey.toBase58();
 if(field==='rent')p.original.sellerAtaRentCapLamports='2039281';
 if(field==='version')p.transactionVersion=0;
 if(field==='destination')v.fill.buyerWallet=Keypair.generate().publicKey.toBase58();
 await expect(prepareKeepEquipmentSigning(v,f.trust,f.value.fill.buyerWallet)).rejects.toThrow();
});
it('requires installed independent chain/mint/rent/fee pins; response identity alone never authorizes signing',async()=>{
 const f=keepMarketFixture('legacy',true);
 for(const trust of [{...f.trust,expectedGenesisHash:Keypair.generate().publicKey.toBase58()},{...f.trust,expectedKeepMint:Keypair.generate().publicKey.toBase58()},{...f.trust,maxFeeLamports:'4999'},{...f.trust,maxAtaRentLamports:'2039279'}])await expect(prepareKeepEquipmentSigning(f.value,trust,f.value.fill.buyerWallet)).rejects.toThrow();
 expect(()=>keepEquipmentTrust({...f.trust,extra:true} as typeof f.trust)).toThrow();
});
it('wallet rejection/change/modified wire never returns a retained payment or invokes a send operation',async()=>{
 const f=keepMarketFixture(),prepared=await prepareKeepEquipmentSigning(f.value,f.trust,f.value.fill.buyerWallet),other=Keypair.generate();
 await expect(signKeepEquipment({...prepared},f.signer)).rejects.toThrow();
 await expect(signKeepEquipment(prepared,{...f.signer,publicKey:other.publicKey})).rejects.toThrow();
 await expect(signKeepEquipment(prepared,{...f.signer,signVersionedTransaction:async()=>{throw Error('declined');}})).rejects.toThrow('declined');
 await expect(signKeepEquipment(prepared,{...f.signer,signVersionedTransaction:async tx=>{tx.message.recentBlockhash=other.publicKey.toBase58();tx.sign([f.buyer]);return tx;}})).rejects.toThrow();
 const wire=await signKeepEquipment(prepared,f.signer);
 for(const bad of [{...wire,signature:'1'.repeat(64)},{...wire,signedTransactionHex:wire.signedTransactionHex+'00'},{...wire,wireSha256:'f'.repeat(64)}])await expect(verifyKeepEquipmentWire(f.value,bad)).rejects.toThrow();
 const tx=VersionedTransaction.deserialize(Buffer.from(wire.signedTransactionHex,'hex'));tx.signatures[0]![0]=tx.signatures[0]![0]!^1;
 await expect(verifyKeepEquipmentWire(f.value,{...wire,signedTransactionHex:Buffer.from(tx.serialize()).toString('hex')})).rejects.toThrow();
});
it('already retained consent cannot be presented as a fresh signing request',async()=>{
 const f=keepMarketFixture(),prepared=await prepareKeepEquipmentSigning(f.value,f.trust,f.value.fill.buyerWallet),wire=await signKeepEquipment(prepared,f.signer),v={...f.value,status:'signed' as const,wire:{...wire,recordedAt:f.value.preparation!.recordedAt}};
 await expect(prepareKeepEquipmentSigning(v,f.trust,f.value.fill.buyerWallet)).rejects.toThrow();
});
