/** D153.175 exact original v0 buyer and seller consent; no signing, RPC or relay.
 * The caller obtains intent from the separately reviewed original transfer plan. This
 * proves only both signatures over those exact bytes, not Charter eligibility,
 * ALT provenance, current delivery admission, transfer eligibility or terminal effects. */
import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto';
import {MessageV0,PACKET_DATA_SIZE,PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
const SIGNATURE_BYTES=64,SIGNED_PREFIX_BYTES=1+2*SIGNATURE_BYTES;
type Code='INPUT'|'WIRE'|'MESSAGE'|'SIGNER'|'SIGNATURE';
export class CharterTransferWireError extends Error {
 constructor(readonly code:Code){super(`Charter transfer wire refused: ${code}`);this.name='CharterTransferWireError';}
}
function need(value:unknown,code:Code):asserts value{if(!value)throw new CharterTransferWireError(code);}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export interface CharterTransferSignedWireInput {
 readonly intentBytes:Uint8Array;
 readonly signedTransaction:Uint8Array;
 readonly buyer:PublicKey;readonly seller:PublicKey;
}
export interface CharterTransferSignedWire {
 readonly signature:string;
 readonly wireSha256:string;
 readonly messageSha256:string;
 /** A fresh owned copy on every access. */
 readonly signedTransaction:Uint8Array;
}
export function verifyCharterTransferSignedWire(input:CharterTransferSignedWireInput):CharterTransferSignedWire {
 try{
  // Bounds precede the SDK compact-vector decoders and all owned allocations.
  need(input&&input.intentBytes instanceof Uint8Array&&input.signedTransaction instanceof Uint8Array&&input.buyer instanceof PublicKey&&input.seller instanceof PublicKey,'INPUT');
  need(input.intentBytes.length>0&&input.intentBytes.length<=PACKET_DATA_SIZE-SIGNED_PREFIX_BYTES
   &&input.signedTransaction.length>SIGNED_PREFIX_BYTES&&input.signedTransaction.length<=PACKET_DATA_SIZE,'INPUT');
  const intent=Buffer.from(input.intentBytes),wire=Buffer.from(input.signedTransaction),buyer=new PublicKey(input.buyer.toBytes()),seller=new PublicKey(input.seller.toBytes());
  // Exactly two canonical compact-u16 signatures, followed by version0. Never
  // reinterpret legacy or future-version bytes as the saved Charter consent.
  need(wire[0]===2&&intent[0]===0x80&&wire[SIGNED_PREFIX_BYTES]===0x80,'WIRE');
  need(wire.length===SIGNED_PREFIX_BYTES+intent.length&&wire.subarray(SIGNED_PREFIX_BYTES).equals(intent),'MESSAGE');
  let message:MessageV0;
  try{message=MessageV0.deserialize(intent);need(Buffer.from(message.serialize()).equals(intent),'MESSAGE');}
  catch(error){if(error instanceof CharterTransferWireError)throw error;throw new CharterTransferWireError('MESSAGE');}
  need(message.header.numRequiredSignatures===2&&message.header.numReadonlySignedAccounts===0,'WIRE');
  need(message.staticAccountKeys[0]?.equals(buyer)&&message.staticAccountKeys[1]?.equals(seller)&&!buyer.equals(seller),'SIGNER');
  const tx=VersionedTransaction.deserialize(wire);
  need(tx.version===0&&tx.signatures.length===2,'WIRE');
  need(Buffer.from(tx.message.serialize()).equals(intent),'MESSAGE');
  need(Buffer.from(tx.serialize()).equals(wire),'WIRE');
  const signature=Buffer.from(tx.signatures[0]!);
  for(const [i,wallet] of [buyer,seller].entries()){
   const sig=Buffer.from(tx.signatures[i]!);
   const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),wallet.toBuffer()]),format:'der',type:'spki'});
   need(sig.length===SIGNATURE_BYTES&&verifySignature(null,intent,key,sig),'SIGNATURE');
  }
  return Object.freeze({signature:bs58.encode(signature),wireSha256:digest(wire),messageSha256:digest(intent),
   get signedTransaction(){return Uint8Array.from(wire);}});
 }catch(error){if(error instanceof CharterTransferWireError)throw error;throw new CharterTransferWireError('WIRE');}
}
