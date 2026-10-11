/** D153.214 exact original payer consent. No RPC, signing, delivery or renewal. */
import {PublicKey} from '@solana/web3.js';
import {normalizeVehicleIssuanceOriginal} from './vehicleIssuanceAccounts';
import {verifyVehicleRequestLegacyMessage} from './vehicleIssuanceRequest';
import {verifyMiningClaimSignedWire,type MiningClaimSignedWire} from './miningClaimWire';

export interface VehicleRequestSignedWireInput {
 readonly original:unknown;
 readonly policyAuthority:string;
 readonly policySignature:Uint8Array;
 readonly recentBlockhash:string;
 readonly intentBytes:Uint8Array;
 readonly signedTransaction:Uint8Array;
}
export type VehicleRequestSignedWire=MiningClaimSignedWire;

/** First bind the saved intent to the complete vehicle request, then use the
 * accepted pure single-payer legacy signature verifier. Its mining-named helper
 * carries no mining entitlement logic. This proves only consent to these bytes;
 * saved source/fee observations are not current signing or relay authority. */
export function verifyVehicleRequestSignedWire(input:VehicleRequestSignedWireInput):VehicleRequestSignedWire {
 const original=normalizeVehicleIssuanceOriginal(input.original);
 verifyVehicleRequestLegacyMessage(input.intentBytes,original,input.policyAuthority,input.policySignature,input.recentBlockhash);
 return verifyMiningClaimSignedWire({intentBytes:input.intentBytes,signedTransaction:input.signedTransaction,wallet:new PublicKey(original.buyer)});
}
