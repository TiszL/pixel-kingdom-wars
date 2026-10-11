/** Historical owner-attestation binding. Packet failure neither proves a whole
 * split plan finished nor independently authenticates chain finality. */
import {Buffer} from 'buffer';
import {MiningTaxClaimFailureEnvelopeSchema,type MiningTaxClaimFailureEnvelope} from '@shardkeep/shared/miningTaxClaimFailureApi';
import {ownMiningTaxClaimLocalEvidence,verifyMiningTaxClaimSettlement,type MiningTaxClaimLocalEvidence} from './settlement';
import {prepareMiningTaxClaimSigning,verifySignedMiningTaxClaim,type MiningTaxClaimSigningTrust} from './signing';
export class MiningTaxClaimFailureError extends Error{constructor(readonly code:'INPUT'|'ORIGINAL'|'TRUST'|'WIRE'|'FAILURE'){super(`Mining tax failure evidence refused: ${code}`);this.name='MiningTaxClaimFailureError';}}
function need(value:unknown,code:MiningTaxClaimFailureError['code']):asserts value{if(!value)throw new MiningTaxClaimFailureError(code);}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export interface BoundMiningTaxClaimFailure{
 readonly envelope:MiningTaxClaimFailureEnvelope;readonly browserFinalityVerified:false;readonly currentSigningAuthorized:false;readonly broadcastAuthorized:false;readonly journalClearingAuthorized:false;
}
export async function verifyMiningTaxClaimFailure(original:unknown,raw:unknown,trust:MiningTaxClaimSigningTrust):Promise<BoundMiningTaxClaimFailure>{
 let local:MiningTaxClaimLocalEvidence,envelope:MiningTaxClaimFailureEnvelope;
 try{local=ownMiningTaxClaimLocalEvidence(original);envelope=MiningTaxClaimFailureEnvelopeSchema.parse(raw);}catch{throw new MiningTaxClaimFailureError('INPUT');}
 const p=local.preparation,r=envelope.recovery;need(envelope.failures.length&&r.preparation,'FAILURE');
 need(r.wallet===local.wallet&&same(p,r.preparation),'ORIGINAL');
 need(trust&&typeof trust==='object','TRUST');
 const pins:MiningTaxClaimSigningTrust={genesisHash:trust.genesisHash,programId:trust.programId,configAddress:trust.configAddress,keepMint:trust.keepMint,reserveOwner:trust.reserveOwner,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256};
 for(const [index,w] of local.wires.entries())need(w.ordinal<p.transactions.length&&w.ordinal>(local.wires[index-1]?.ordinal??-1),'WIRE');
 const byOrdinal=new Map(local.wires.map(w=>[w.ordinal,w]));
 for(const failed of envelope.failures)need(byOrdinal.has(failed.ordinal),'WIRE');
 for(const server of r.wires){const saved=byOrdinal.get(server.ordinal);if(saved)need(saved.wire===Buffer.from(server.signedTransactionHex,'hex').toString('base64')&&saved.signature===server.signature&&saved.messageSha256===server.messageSha256&&saved.wireSha256===server.wireSha256,'WIRE');}
 try{await prepareMiningTaxClaimSigning(p,pins);}catch{throw new MiningTaxClaimFailureError('TRUST');}
 try{
  for(const saved of local.wires){const verified=await verifySignedMiningTaxClaim(p,saved.wire,saved.ordinal);need(verified.signature===saved.signature&&verified.messageSha256===saved.messageSha256&&verified.wireSha256===saved.wireSha256,'WIRE');}
  for(const server of r.wires){const verified=await verifySignedMiningTaxClaim(p,Buffer.from(server.signedTransactionHex,'hex').toString('base64'),server.ordinal);need(verified.signature===server.signature&&verified.messageSha256===server.messageSha256&&verified.wireSha256===server.wireSha256,'WIRE');}
  // A successful setup coexisting with claim failure still needs its complete
  // original signed prefix. Failure evidence cannot bypass the success binder.
  if(r.settlement)await verifyMiningTaxClaimSettlement(local,r,pins);
 }catch{throw new MiningTaxClaimFailureError('WIRE');}
 return freeze({envelope,browserFinalityVerified:false,currentSigningAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false});
}
