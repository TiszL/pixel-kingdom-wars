/** D153.180 one original party's detached consent, never relay authority. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {MessageV0,PublicKey} from '@solana/web3.js';
import {CharterTransferWireError,verifyCharterTransferSignedWire} from './charterTransferWire';
export interface CharterTransferContributionInput {
 readonly intentBytes:Uint8Array;readonly buyer:PublicKey;readonly seller:PublicKey;
 readonly actor:PublicKey;readonly signature:Uint8Array;
}
export function verifyCharterTransferContribution(input:CharterTransferContributionInput){
 try{
  if(!input||!(input.intentBytes instanceof Uint8Array)||input.intentBytes.length===0||input.intentBytes.length>1103
   ||!(input.signature instanceof Uint8Array)||input.signature.length!==64||![input.buyer,input.seller,input.actor].every(v=>v instanceof PublicKey))throw new CharterTransferWireError('INPUT');
  const message=Buffer.from(input.intentBytes),signature=Buffer.from(input.signature),buyer=new PublicKey(input.buyer.toBytes()),seller=new PublicKey(input.seller.toBytes()),actor=new PublicKey(input.actor.toBytes());
  if(message[0]!==0x80)throw new CharterTransferWireError('WIRE');
  const parsed=MessageV0.deserialize(message);
  if(!Buffer.from(parsed.serialize()).equals(message)||parsed.header.numRequiredSignatures!==2||parsed.header.numReadonlySignedAccounts!==0)throw new CharterTransferWireError('MESSAGE');
  if(buyer.equals(seller)||!parsed.staticAccountKeys[0]?.equals(buyer)||!parsed.staticAccountKeys[1]?.equals(seller)||(!actor.equals(buyer)&&!actor.equals(seller)))throw new CharterTransferWireError('SIGNER');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),actor.toBuffer()]),format:'der',type:'spki'});
  if(!verify(null,message,key,signature))throw new CharterTransferWireError('SIGNATURE');
  return Object.freeze({wallet:actor.toBase58(),messageSha256:createHash('sha256').update(message).digest('hex'),
   get signature(){return Uint8Array.from(signature);}});
 }catch(error){if(error instanceof CharterTransferWireError)throw error;throw new CharterTransferWireError('WIRE');}
}
/** Both signatures always go through the unchanged full-wire verifier. */
export function combineCharterTransferContributions(input:Omit<CharterTransferContributionInput,'actor'|'signature'>&{readonly buyerSignature:Uint8Array;readonly sellerSignature:Uint8Array}){
 if(!(input?.buyerSignature instanceof Uint8Array)||input.buyerSignature.length!==64||!(input.sellerSignature instanceof Uint8Array)||input.sellerSignature.length!==64||!(input.intentBytes instanceof Uint8Array)||input.intentBytes.length>1103)throw new CharterTransferWireError('INPUT');
 return verifyCharterTransferSignedWire({...input,signedTransaction:Buffer.concat([Buffer.of(2),input.buyerSignature,input.sellerSignature,input.intentBytes])});
}
