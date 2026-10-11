/** D153.181 single-leader consent uses the accepted canonical v0 verifier.
 * This proves exact bytes and Ed25519 consent only, never tournament admission. */
import {PublicKey} from '@solana/web3.js';
import {verifyCharterCreationSignedWire,type CharterCreationSignedWire} from './charterCreationWire';
export interface CharterLockSignedWireInput {readonly intentBytes:Uint8Array;readonly signedTransaction:Uint8Array;readonly leader:PublicKey}
export type CharterLockSignedWire=CharterCreationSignedWire;
export function verifyCharterLockSignedWire(input:CharterLockSignedWireInput):CharterLockSignedWire{
 return verifyCharterCreationSignedWire({intentBytes:input.intentBytes,signedTransaction:input.signedTransaction,wallet:input.leader});
}
