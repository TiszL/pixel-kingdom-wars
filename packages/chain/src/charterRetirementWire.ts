/** Single-leader retirement consent uses the accepted canonical v0 verifier.
 * This proves exact bytes and Ed25519 consent only, never backend dissolution. */
import {PublicKey} from '@solana/web3.js';
import {verifyCharterCreationSignedWire,type CharterCreationSignedWire} from './charterCreationWire';
export interface CharterRetirementSignedWireInput {readonly intentBytes:Uint8Array;readonly signedTransaction:Uint8Array;readonly leader:PublicKey}
export type CharterRetirementSignedWire=CharterCreationSignedWire;
export function verifyCharterRetirementSignedWire(input:CharterRetirementSignedWireInput):CharterRetirementSignedWire{
 return verifyCharterCreationSignedWire({intentBytes:input.intentBytes,signedTransaction:input.signedTransaction,wallet:input.leader});
}
