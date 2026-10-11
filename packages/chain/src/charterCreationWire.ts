/** D153.168 exact original v0 wallet consent; no signing, RPC or relay.
 * The caller obtains intent from the verified retained D166 preparation. This
 * proves only payer signature over those exact bytes, not Charter eligibility,
 * ALT provenance, current delivery admission, minting or terminal effects. */
import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto';
import {MessageV0,PACKET_DATA_SIZE,PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
const SIGNATURE_BYTES=64,SIGNED_PREFIX_BYTES=1+SIGNATURE_BYTES;
type Code='INPUT'|'WIRE'|'MESSAGE'|'SIGNER'|'SIGNATURE';
export class CharterCreationWireError extends Error {
 constructor(readonly code:Code){super(`Charter creation wire refused: ${code}`);this.name='CharterCreationWireError';}
}
function need(value:unknown,code:Code):asserts value{if(!value)throw new CharterCreationWireError(code);}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export interface CharterCreationSignedWireInput {
 readonly intentBytes:Uint8Array;
 readonly signedTransaction:Uint8Array;
 readonly wallet:PublicKey;
}
export interface CharterCreationSignedWire {
 readonly signature:string;
 readonly wireSha256:string;
 readonly messageSha256:string;
 /** A fresh owned copy on every access. */
 readonly signedTransaction:Uint8Array;
}
export function verifyCharterCreationSignedWire(input:CharterCreationSignedWireInput):CharterCreationSignedWire {
 try{
  // Bounds precede the SDK compact-vector decoders and all owned allocations.
  need(input&&input.intentBytes instanceof Uint8Array&&input.signedTransaction instanceof Uint8Array&&input.wallet instanceof PublicKey,'INPUT');
  need(input.intentBytes.length>0&&input.intentBytes.length<=PACKET_DATA_SIZE-SIGNED_PREFIX_BYTES
   &&input.signedTransaction.length>SIGNED_PREFIX_BYTES&&input.signedTransaction.length<=PACKET_DATA_SIZE,'INPUT');
  const intent=Buffer.from(input.intentBytes),wire=Buffer.from(input.signedTransaction),wallet=new PublicKey(input.wallet.toBytes());
  // Exactly one canonical compact-u16 signature, followed by version0. Never
  // reinterpret legacy or future-version bytes as the saved Charter consent.
  need(wire[0]===1&&intent[0]===0x80&&wire[SIGNED_PREFIX_BYTES]===0x80,'WIRE');
  need(wire.length===SIGNED_PREFIX_BYTES+intent.length&&wire.subarray(SIGNED_PREFIX_BYTES).equals(intent),'MESSAGE');
  let message:MessageV0;
  try{message=MessageV0.deserialize(intent);need(Buffer.from(message.serialize()).equals(intent),'MESSAGE');}
  catch(error){if(error instanceof CharterCreationWireError)throw error;throw new CharterCreationWireError('MESSAGE');}
  need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0,'WIRE');
  need(message.staticAccountKeys[0]?.equals(wallet),'SIGNER');
  const tx=VersionedTransaction.deserialize(wire);
  need(tx.version===0&&tx.signatures.length===1,'WIRE');
  need(Buffer.from(tx.message.serialize()).equals(intent),'MESSAGE');
  need(Buffer.from(tx.serialize()).equals(wire),'WIRE');
  const signature=Buffer.from(tx.signatures[0]!);
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),wallet.toBuffer()]),format:'der',type:'spki'});
  need(signature.length===SIGNATURE_BYTES&&verifySignature(null,intent,key,signature),'SIGNATURE');
  return Object.freeze({signature:bs58.encode(signature),wireSha256:digest(wire),messageSha256:digest(intent),
   get signedTransaction(){return Uint8Array.from(wire);}});
 }catch(error){if(error instanceof CharterCreationWireError)throw error;throw new CharterCreationWireError('WIRE');}
}
