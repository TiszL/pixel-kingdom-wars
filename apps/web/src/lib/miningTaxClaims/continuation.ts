/** Bind an immutable owner continuation to saved consent/setup and a distinct
 * additional request. This is historical consistency, never fresh admission,
 * independent chain finality, offline-signing prevention or clearing authority. */
import {MiningTaxClaimContinuationEnvelopeSchema,MiningTaxClaimContinuationRequestSchema,type MiningTaxClaimContinuationRequest} from '@shardkeep/shared/miningTaxClaimContinuationApi';
import {validateMiningTaxClaimRecoveryEnvelope,type MiningTaxClaimRecoveryEnvelope} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import {ownMiningTaxClaimLocalEvidence,verifyMiningTaxClaimSettlement,MiningTaxClaimSettlementError,type MiningTaxClaimLocalEvidence} from './settlement';
import {prepareMiningTaxClaimSigning,MiningTaxClaimSigningError,type MiningTaxClaimSigningTrust} from './signing';
export class MiningTaxClaimContinuationError extends Error{constructor(readonly code:'INPUT'|'ORIGINAL'|'REQUEST'|'SETUP'|'TRUST'|'WIRE'|'CONTINUATION'){super(`Mining tax continuation binding refused: ${code}`);this.name='MiningTaxClaimContinuationError';}}
function need(value:unknown,code:MiningTaxClaimContinuationError['code']):asserts value{if(!value)throw new MiningTaxClaimContinuationError(code);}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function exact(value:unknown,names:string):Record<string,unknown>{
 need(value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'INPUT');const fields=names.split(' '),keys=Reflect.ownKeys(value);need(keys.length===fields.length&&keys.every(k=>typeof k==='string'&&fields.includes(k)&&'value' in Object.getOwnPropertyDescriptor(value,k)!),'INPUT');return value as Record<string,unknown>;
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
type Envelope=ReturnType<typeof MiningTaxClaimContinuationEnvelopeSchema.parse>;
export interface BoundMiningTaxClaimContinuation{
 readonly envelope:Envelope;readonly browserFinalityVerified:false;readonly currentSigningAuthorized:false;readonly broadcastAuthorized:false;readonly relayAuthorized:false;readonly settlementAuthorized:false;readonly journalClearingAuthorized:false;
}
/** Every mutable input is owned before the first digest. Late local parent
 * custody remains historical evidence; callers must separately forbid starting
 * continuation after a claim1 signing marker and durably hold late races. */
export async function verifyMiningTaxClaimContinuation(original:unknown,savedSetup:unknown,pendingRequest:unknown,raw:unknown,trust:MiningTaxClaimSigningTrust):Promise<BoundMiningTaxClaimContinuation>{
 let local:MiningTaxClaimLocalEvidence,setup:MiningTaxClaimRecoveryEnvelope,request:MiningTaxClaimContinuationRequest,envelope:Envelope;
 try{
  local=ownMiningTaxClaimLocalEvidence(original);setup=validateMiningTaxClaimRecoveryEnvelope(savedSetup);
  const input=exact(pendingRequest,'idempotencyKey caps');exact(input.caps,'maxFeeLamports maxRentLamports maxTotalLamports');request=MiningTaxClaimContinuationRequestSchema.parse(input);envelope=MiningTaxClaimContinuationEnvelopeSchema.parse(raw);
 }catch{throw new MiningTaxClaimContinuationError('INPUT');}
 const c=envelope.continuation;need(envelope.status==='continued'&&c,'CONTINUATION');
 need(local.wallet===envelope.wallet&&local.request.idempotencyKey===envelope.parentIdempotencyKey&&same(local.preparation,c.parentPreparation),'ORIGINAL');
 need(request.idempotencyKey===c.childPreparation.idempotencyKey&&same(request.caps,c.childPreparation.caps),'REQUEST');
 need(setup.status==='setup'&&setup.settlement&&same(setup.preparation,c.parentPreparation)&&same(setup.settlement,c.parentSetup)&&same(setup.wires.find(w=>w.ordinal===0),c.parentWire),'SETUP');
 need(trust&&typeof trust==='object','TRUST');
 const pins:MiningTaxClaimSigningTrust={genesisHash:trust.genesisHash,programId:trust.programId,configAddress:trust.configAddress,keepMint:trust.keepMint,reserveOwner:trust.reserveOwner,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256};
 // The established setup binder checks exact local signatures and all original
 // messages; the child then receives the same independent historical ABI/PDA,
 // message-hash and deployment-pin checks without invoking any wallet callback.
 try{await verifyMiningTaxClaimSettlement(local,setup,pins);}catch(error){throw new MiningTaxClaimContinuationError(error instanceof MiningTaxClaimSettlementError&&error.code==='TRUST'?'TRUST':'WIRE');}
 try{await prepareMiningTaxClaimSigning(c.childPreparation,pins);}catch(error){throw new MiningTaxClaimContinuationError(error instanceof MiningTaxClaimSigningError&&error.code==='TRUST'?'TRUST':'WIRE');}
 return freeze({envelope,browserFinalityVerified:false,currentSigningAuthorized:false,broadcastAuthorized:false,relayAuthorized:false,settlementAuthorized:false,journalClearingAuthorized:false});
}
