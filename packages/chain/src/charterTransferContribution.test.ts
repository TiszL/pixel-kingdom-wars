import {describe,it,expect} from 'vitest';
import {Keypair,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {verifyCharterTransferContribution,combineCharterTransferContributions} from './charterTransferContribution';
function fixture(){const buyer=Keypair.generate(),seller=Keypair.generate(),to=Keypair.generate().publicKey;
 const message=new TransactionMessage({payerKey:buyer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:buyer.publicKey,toPubkey:to,lamports:1}),SystemProgram.transfer({fromPubkey:seller.publicKey,toPubkey:to,lamports:1})]}).compileToV0Message();
 const tx=new VersionedTransaction(message);tx.sign([buyer,seller]);return {buyer,seller,tx,base:{intentBytes:message.serialize(),buyer:buyer.publicKey,seller:seller.publicKey}};
}
describe('separate original Charter wallet approvals',()=>{
 it('allows either original party first and detaches retained signatures from wallet buffers',()=>{const f=fixture();for(const [i,actor] of [f.buyer,f.seller].entries()){
  const signature=Uint8Array.from(f.tx.signatures[i]!),proof=verifyCharterTransferContribution({...f.base,actor:actor.publicKey,signature});signature.fill(0);const copy=proof.signature;copy.fill(0);
  expect(proof.signature).toEqual(f.tx.signatures[i]);expect(proof.wallet).toBe(actor.publicKey.toBase58());}
 });
 it('assembles only the exact canonical two-party wire and preserves its transaction identity',()=>{const f=fixture(),wire=combineCharterTransferContributions({...f.base,buyerSignature:f.tx.signatures[0]!,sellerSignature:f.tx.signatures[1]!});expect(wire.signedTransaction).toEqual(f.tx.serialize());
  expect(()=>combineCharterTransferContributions({...f.base,buyerSignature:f.tx.signatures[1]!,sellerSignature:f.tx.signatures[0]!})).toThrow();expect(()=>combineCharterTransferContributions({...f.base,buyerSignature:f.tx.signatures[0]!,sellerSignature:new Uint8Array(64)})).toThrow();
 });
 it('refuses a third party, another message, substituted role and padded signature before persistence',()=>{const f=fixture(),input={...f.base,actor:f.buyer.publicKey,signature:f.tx.signatures[0]!};
  expect(()=>verifyCharterTransferContribution({...input,actor:Keypair.generate().publicKey})).toThrow();expect(()=>verifyCharterTransferContribution({...input,actor:f.seller.publicKey})).toThrow();
  const changed=Uint8Array.from(f.base.intentBytes);changed[changed.length-1]=changed[changed.length-1]!^1;expect(()=>verifyCharterTransferContribution({...input,intentBytes:changed})).toThrow();
  expect(()=>verifyCharterTransferContribution({...input,signature:Buffer.concat([input.signature,Buffer.of(0)])})).toThrow();
 });
 it('refuses legacy, noncanonical and oversized message encodings even with two named parties',()=>{const f=fixture(),input={...f.base,actor:f.buyer.publicKey,signature:f.tx.signatures[0]!};
  for(const intentBytes of [Buffer.concat([f.base.intentBytes,Buffer.of(0)]),Buffer.from([0,...f.base.intentBytes.subarray(1)]),new Uint8Array(1104)])expect(()=>verifyCharterTransferContribution({...input,intentBytes})).toThrow();
 });
});
