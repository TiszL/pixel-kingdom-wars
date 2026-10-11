/** Pure acceptance of externally signed claimant bytes; no RPC, signing or relay.
 * The canonical prepared artifact supplies setup/combined/claim meaning and all
 * instruction authority. This helper proves only the expected claimant signed
 * that exact retained message (legacy unless the ordered format is explicit); it does not infer claim eligibility. */
import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto';
import {Message,MessageV0,PACKET_DATA_SIZE,PublicKey,Transaction,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {copyMiningClaimFormat,miningClaimV0Accounts,type MiningClaimFormat} from './miningClaimFormat';

const SIGNATURE_BYTES=64,SIGNED_PREFIX_BYTES=1+SIGNATURE_BYTES;
type Code='INPUT'|'WIRE'|'MESSAGE'|'SIGNER'|'SIGNATURE';
export class MiningClaimWireError extends Error {
 constructor(readonly code:Code){super(`Mining claim wire refused: ${code}`);this.name='MiningClaimWireError';}
}
function need(value:unknown,code:Code):asserts value{if(!value)throw new MiningClaimWireError(code);}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export interface MiningClaimSignedWireInput {
 readonly intentBytes:Uint8Array;
 readonly signedTransaction:Uint8Array;
 readonly wallet:PublicKey;
 readonly format?:MiningClaimFormat;
}
export interface MiningClaimSignedWire {
 readonly signature:string;
 readonly wireSha256:string;
 readonly messageSha256:string;
 /** A fresh owned copy on every access. */
 readonly signedTransaction:Uint8Array;
}
export function verifyMiningClaimSignedWire(input:MiningClaimSignedWireInput):MiningClaimSignedWire {
 try{
  // Bound before any Solana decoder, including compact-vector allocation.
  need(input&&input.intentBytes instanceof Uint8Array&&input.signedTransaction instanceof Uint8Array,'INPUT');
  need(input.intentBytes.length>0&&input.intentBytes.length<=PACKET_DATA_SIZE-SIGNED_PREFIX_BYTES
   &&input.signedTransaction.length>SIGNED_PREFIX_BYTES&&input.signedTransaction.length<=PACKET_DATA_SIZE,'INPUT');
  const intent=Buffer.from(input.intentBytes),wire=Buffer.from(input.signedTransaction);
  // Exactly one signature has the canonical compact-u16 prefix 0x01. A legacy
  // message starts with its signature count; a versioned prefix sets the high bit.
  const format=input.format===undefined?undefined:copyMiningClaimFormat(input.format),prefix=format?0x80:1;
  need(wire[0]===1&&intent[0]===prefix&&wire[SIGNED_PREFIX_BYTES]===prefix,'WIRE');
  need(wire.length===SIGNED_PREFIX_BYTES+intent.length&&wire.subarray(SIGNED_PREFIX_BYTES).equals(intent),'MESSAGE');
  need(input.wallet instanceof PublicKey,'INPUT');const wallet=new PublicKey(input.wallet.toBytes());
  if(format){
   const message=MessageV0.deserialize(intent);need(Buffer.from(message.serialize()).equals(intent),'MESSAGE');
   need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0,'WIRE');need(message.staticAccountKeys[0]?.equals(wallet),'SIGNER');miningClaimV0Accounts(message,format);
   const tx=VersionedTransaction.deserialize(wire);need(tx.version===0&&tx.signatures.length===1&&Buffer.from(tx.serialize()).equals(wire),'WIRE');
   const signature=Buffer.from(tx.signatures[0]!),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),wallet.toBuffer()]),format:'der',type:'spki'});
   need(verifySignature(null,intent,key,signature),'SIGNATURE');
   return Object.freeze({signature:bs58.encode(signature),wireSha256:digest(wire),messageSha256:digest(intent),get signedTransaction(){return Uint8Array.from(wire);}});
  }
  let message:Message;
  try{message=Message.from(intent);need(message.serialize().equals(intent),'MESSAGE');}
  catch(error){if(error instanceof MiningClaimWireError)throw error;throw new MiningClaimWireError('MESSAGE');}
  need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0,'WIRE');
  need(message.accountKeys[0]?.equals(wallet),'SIGNER');
  const tx=Transaction.from(wire);
  need(tx.signatures.length===1&&tx.feePayer?.equals(wallet)&&tx.signatures[0]!.publicKey.equals(wallet),'SIGNER');
  need(tx.serializeMessage().equals(intent),'MESSAGE');
  // Use the existing custody boundary's local Ed25519 signature verification.
  need(tx.signatures[0]!.signature!==null&&tx.verifySignatures(true),'SIGNATURE');
  need(tx.serialize({requireAllSignatures:true,verifySignatures:false}).equals(wire),'WIRE');
  const signature=bs58.encode(tx.signatures[0]!.signature),wireSha256=digest(wire),messageSha256=digest(intent);
  return Object.freeze({signature,wireSha256,messageSha256,get signedTransaction(){return Uint8Array.from(wire);}});
 }catch(error){if(error instanceof MiningClaimWireError)throw error;throw new MiningClaimWireError('WIRE');}
}
