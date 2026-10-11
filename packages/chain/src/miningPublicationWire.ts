/** Pure acceptance of externally provided bytes. No signing, broadcast or RPC.
 * The retained intent's instruction/economic authority is checked by preparation;
 * this boundary proves only one publisher signed that EXACT legacy message. */
import { createHash } from 'node:crypto';
import { Message,PACKET_DATA_SIZE,PublicKey,Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

const SIGNATURE_BYTES=64,SIGNED_PREFIX_BYTES=1+SIGNATURE_BYTES;
type Code='INPUT'|'WIRE'|'MESSAGE'|'SIGNER'|'SIGNATURE';
export class MiningPublicationWireError extends Error{
 constructor(readonly code:Code){super(`Mining publication wire refused: ${code}`);this.name='MiningPublicationWireError';}
}
function need(value:unknown,code:Code):asserts value{if(!value)throw new MiningPublicationWireError(code);}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export interface MiningPublicationSignedWireInput{
 readonly intentBytes:Uint8Array;
 readonly signedTransaction:Uint8Array;
 readonly signer:PublicKey;
}
export interface MiningPublicationSignedWire{
 readonly signature:string;
 readonly wireSha256:string;
 readonly messageSha256:string;
 /** A fresh copy per read; neither caller input nor consumers own retained bytes. */
 readonly signedTransaction:Uint8Array;
}
export function verifyMiningPublicationSignedWire(input:MiningPublicationSignedWireInput):MiningPublicationSignedWire{
 try{
  // Bound before any Solana decoder/constructor, including compact-vector reads.
  need(input&&input.intentBytes instanceof Uint8Array&&input.signedTransaction instanceof Uint8Array,'INPUT');
  need(input.intentBytes.length>0&&input.intentBytes.length<=PACKET_DATA_SIZE-SIGNED_PREFIX_BYTES
   &&input.signedTransaction.length>SIGNED_PREFIX_BYTES&&input.signedTransaction.length<=PACKET_DATA_SIZE,'INPUT');
  const intent=Buffer.from(input.intentBytes),wire=Buffer.from(input.signedTransaction);
  // Exactly one signature has the unique canonical compact-u16 prefix 0x01.
  // A legacy message starts with its required-signature count; versioned messages
  // set the high bit, so neither lookup tables nor alternate versions can enter.
  need(wire[0]===1&&intent[0]===1&&wire[SIGNED_PREFIX_BYTES]===1,'WIRE');
  need(wire.length===SIGNED_PREFIX_BYTES+intent.length&&wire.subarray(SIGNED_PREFIX_BYTES).equals(intent),'MESSAGE');
  need(input.signer instanceof PublicKey,'INPUT');const signer=new PublicKey(input.signer.toBytes());
  let message:Message;
  try{message=Message.from(intent);need(message.serialize().equals(intent),'MESSAGE');}
  catch(error){if(error instanceof MiningPublicationWireError)throw error;throw new MiningPublicationWireError('MESSAGE');}
  need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0,'WIRE');
  need(message.accountKeys[0]?.equals(signer),'SIGNER');
  const tx=Transaction.from(wire);
  need(tx.signatures.length===1&&tx.feePayer?.equals(signer)&&tx.signatures[0]!.publicKey.equals(signer),'SIGNER');
  need(tx.serializeMessage().equals(intent),'MESSAGE');
  // Match the existing withdrawal acceptance boundary's local Ed25519 check.
  need(tx.signatures[0]!.signature!==null&&tx.verifySignatures(true),'SIGNATURE');
  need(tx.serialize({requireAllSignatures:true,verifySignatures:false}).equals(wire),'WIRE');
  const signature=bs58.encode(tx.signatures[0]!.signature),wireSha256=digest(wire),messageSha256=digest(intent);
  return Object.freeze({signature,wireSha256,messageSha256,get signedTransaction(){return Uint8Array.from(wire);}});
 }catch(error){if(error instanceof MiningPublicationWireError)throw error;throw new MiningPublicationWireError('WIRE');}
}
