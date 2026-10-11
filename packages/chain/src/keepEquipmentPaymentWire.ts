/** Exact retained KEEP payment consent, with no RPC, signing or relay.
 * The application supplies bytes from its immutable, reviewed preparation; this
 * helper does not choose/rebuild terms or resolve LUTs. ATA rent consent is saved
 * separately by that preparation: it is not encoded in the SPL instruction.
 * A rejected replacement never makes the original packet unpaid or releasable. */
import {PACKET_DATA_SIZE,PublicKey} from '@solana/web3.js';
import {MiningClaimWireError,verifyMiningClaimSignedWire} from './miningClaimWire';
import {CharterCreationWireError,verifyCharterCreationSignedWire} from './charterCreationWire';

type Code='INPUT'|'WIRE'|'MESSAGE'|'SIGNER'|'SIGNATURE';
const SIGNED_PREFIX_BYTES=1+64;
export class KeepEquipmentPaymentWireError extends Error {
 readonly fenceReleaseAuthorized=false;readonly unpaidProven=false;
 constructor(readonly code:Code){super(`KEEP equipment signed wire refused: ${code}`);this.name='KeepEquipmentPaymentWireError';}
}
function need(value:unknown,code:Code):asserts value{if(!value)throw new KeepEquipmentPaymentWireError(code);}
export interface KeepEquipmentPaymentSignedWireInput {
 readonly preparedMessageBytes:Uint8Array;
 readonly signedTransaction:Uint8Array;
 readonly buyer:PublicKey;
}
export interface KeepEquipmentPaymentSignedWire {
 readonly version:'legacy'|0;
 readonly signature:string;
 readonly wireSha256:string;
 readonly messageSha256:string;
 /** Fresh owned bytes on every access. */
 readonly signedTransaction:Uint8Array;
 readonly finalityVerified:false;
 readonly broadcastAuthorized:false;
 readonly deliveryAuthorized:false;
 readonly fenceReleaseAuthorized:false;
 readonly unpaidProven:false;
}
export function verifyKeepEquipmentPaymentSignedWire(input:KeepEquipmentPaymentSignedWireInput):KeepEquipmentPaymentSignedWire {
 try{
  need(input&&typeof input==='object'&&!Array.isArray(input),'INPUT');
  const message=input.preparedMessageBytes,wire=input.signedTransaction,buyer=input.buyer;
  // Reject bounds/types before either compact-vector decoder is reachable.
  need(message instanceof Uint8Array&&wire instanceof Uint8Array&&buyer instanceof PublicKey,'INPUT');
  need(message.length>0&&message.length<=PACKET_DATA_SIZE-SIGNED_PREFIX_BYTES&&wire.length>SIGNED_PREFIX_BYTES&&wire.length<=PACKET_DATA_SIZE,'INPUT');
  need(wire[0]===1&&(message[0]===1||message[0]===0x80),'WIRE');
  const version=message[0]===1?'legacy':0;
  // These existing pure primitives already bind exact message bytes, writable
  // sole payer, canonical serialization and genuine Ed25519 signatures. Their
  // names do not grant mining/Charter authority; vehicle proofs reuse them too.
  const proof=(version==='legacy'?verifyMiningClaimSignedWire:verifyCharterCreationSignedWire)({intentBytes:message,signedTransaction:wire,wallet:buyer});
  return Object.freeze({version,signature:proof.signature,wireSha256:proof.wireSha256,messageSha256:proof.messageSha256,
   get signedTransaction(){return proof.signedTransaction;},finalityVerified:false as const,broadcastAuthorized:false as const,deliveryAuthorized:false as const,fenceReleaseAuthorized:false as const,unpaidProven:false as const});
 }catch(error){
  if(error instanceof KeepEquipmentPaymentWireError)throw error;
  if(error instanceof MiningClaimWireError||error instanceof CharterCreationWireError)throw new KeepEquipmentPaymentWireError(error.code);
  throw new KeepEquipmentPaymentWireError('WIRE');
 }
}
