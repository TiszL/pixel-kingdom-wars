/** Bind an owner's historical tax attestation to local immutable consent and
 * signatures. No browser RPC, chain-finality proof, current admission or durable
 * archive decision is performed here. Server receipt flags retain their meaning
 * as server assertions, not independently authenticated browser authority. */
import {Buffer} from 'buffer';
import {MiningTaxClaimPreparationSchema,type MiningTaxClaimPreparation,type MiningTaxClaimPrepareRequest} from '@shardkeep/shared/miningTaxClaimsApi';
import {validateMiningTaxClaimRecoveryEnvelope,type MiningTaxClaimRecoveryEnvelope} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import {prepareMiningTaxClaimSigning,verifySignedMiningTaxClaim,MiningTaxClaimSigningError,type MiningTaxClaimSigningTrust} from './signing';
export class MiningTaxClaimSettlementError extends Error{constructor(readonly code:'INPUT'|'ORIGINAL'|'TRUST'|'WIRE'|'SETTLEMENT'){super(`Mining tax settlement refused: ${code}`);this.name='MiningTaxClaimSettlementError';}}
function need(v:unknown,code:MiningTaxClaimSettlementError['code']):asserts v{if(!v)throw new MiningTaxClaimSettlementError(code);}
export interface MiningTaxClaimLocalWire {ordinal:number;wire:string;signature:string;messageSha256:string;wireSha256:string}
export interface MiningTaxClaimLocalEvidence {wallet:string;request:MiningTaxClaimPrepareRequest;preparation:MiningTaxClaimPreparation;wires:MiningTaxClaimLocalWire[]}
function exact(v:unknown,names:string):Record<string,unknown>{
 need(v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null),'INPUT');const fields=names.split(' '),keys=Reflect.ownKeys(v);need(keys.length===fields.length&&keys.every(k=>typeof k==='string'&&fields.includes(k)&&'value' in Object.getOwnPropertyDescriptor(v,k)!),'INPUT');return v as Record<string,unknown>;
}
export function ownMiningTaxClaimLocalEvidence(value:unknown):MiningTaxClaimLocalEvidence{
 const v=exact(value,'wallet request preparation wires'),p=MiningTaxClaimPreparationSchema.parse(v.preparation),r=exact(v.request,'idempotencyKey round spot caps'),caps=exact(r.caps,'maxFeeLamports maxRentLamports maxTotalLamports');
 // Compare against the already bounded saved preparation before copying. No
 // historical request is re-admitted using today's spot/tuning constraints.
 need(v.wallet===p.wallet&&r.idempotencyKey===p.idempotencyKey&&r.round===p.round&&r.spot===p.spot&&Object.entries(p.caps).every(([name,amount])=>caps[name]===amount),'ORIGINAL');
 need(Array.isArray(v.wires)&&v.wires.length<=2,'INPUT');const wires=v.wires.map((entry):MiningTaxClaimLocalWire=>{
  const w=exact(entry,'ordinal wire signature messageSha256 wireSha256');need(typeof w.ordinal==='number'&&Number.isInteger(w.ordinal)&&w.ordinal>=0&&w.ordinal<=1&&typeof w.wire==='string'&&w.wire.length>=88&&w.wire.length<=1644&&typeof w.signature==='string'&&w.signature.length>=64&&w.signature.length<=88&&typeof w.messageSha256==='string'&&/^[0-9a-f]{64}$/.test(w.messageSha256)&&typeof w.wireSha256==='string'&&/^[0-9a-f]{64}$/.test(w.wireSha256),'INPUT');
  return {ordinal:w.ordinal,wire:w.wire,signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256};
 });return {wallet:p.wallet,request:{idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:{...p.caps}},preparation:p,wires};
}
export interface BoundMiningTaxClaimSettlement {
 readonly phase:'setup'|'settled';readonly recovery:MiningTaxClaimRecoveryEnvelope;
 readonly browserFinalityVerified:false;readonly currentSigningAuthorized:false;readonly broadcastAuthorized:false;readonly journalClearingAuthorized:false;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Require the locally saved actual signed prefix for this receipt. Additional
 * custody may be returned by the owner or held locally; it is crypto-checked but
 * never promoted to setup/payment evidence. Every input is owned before await. */
export async function verifyMiningTaxClaimSettlement(original:unknown,raw:unknown,trust:MiningTaxClaimSigningTrust):Promise<BoundMiningTaxClaimSettlement>{
 let local:MiningTaxClaimLocalEvidence,recovery:MiningTaxClaimRecoveryEnvelope;
 try{local=ownMiningTaxClaimLocalEvidence(original);recovery=validateMiningTaxClaimRecoveryEnvelope(raw);}catch(error){if(error instanceof MiningTaxClaimSettlementError)throw error;throw new MiningTaxClaimSettlementError('INPUT');}
 const p=local.preparation,s=recovery.settlement;
 need(s&&recovery.preparation&&(recovery.status==='setup'||recovery.status==='settled'),'SETTLEMENT');
 need(local.wallet===p.wallet&&local.wallet===recovery.wallet&&same(local.request,{idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:p.caps})&&same(p,recovery.preparation),'ORIGINAL');
 for(const [i,w] of local.wires.entries())need(w.ordinal<p.transactions.length&&w.ordinal>(local.wires[i-1]?.ordinal??-1),'WIRE');
 const localByOrdinal=new Map(local.wires.map(w=>[w.ordinal,w])),serverByOrdinal=new Map(recovery.wires.map(w=>[w.ordinal,w]));
 for(let ordinal=0;ordinal<=s.ordinal;ordinal++)need(localByOrdinal.has(ordinal)&&serverByOrdinal.has(ordinal),'WIRE');
 for(const server of recovery.wires){const saved=localByOrdinal.get(server.ordinal);if(saved)need(saved.wire===Buffer.from(server.signedTransactionHex,'hex').toString('base64')&&saved.signature===server.signature&&saved.messageSha256===server.messageSha256&&saved.wireSha256===server.wireSha256,'WIRE');}
 need(trust&&typeof trust==='object','TRUST');
 const pins:MiningTaxClaimSigningTrust={genesisHash:trust.genesisHash,programId:trust.programId,configAddress:trust.configAddress,keepMint:trust.keepMint,reserveOwner:trust.reserveOwner,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256};
 // This validates all original messages/PDAs/rosters and hashes, and only creates
 // a static proof. No wallet callback or live admission is invoked.
 try{await prepareMiningTaxClaimSigning(p,pins);}catch(error){throw new MiningTaxClaimSettlementError(error instanceof MiningTaxClaimSigningError&&error.code==='TRUST'?'TRUST':'WIRE');}
 try{
  for(const saved of local.wires){const verified=await verifySignedMiningTaxClaim(p,saved.wire,saved.ordinal);need(verified.signature===saved.signature&&verified.messageSha256===saved.messageSha256&&verified.wireSha256===saved.wireSha256,'WIRE');}
  for(const server of recovery.wires){const verified=await verifySignedMiningTaxClaim(p,Buffer.from(server.signedTransactionHex,'hex').toString('base64'),server.ordinal);need(verified.signature===server.signature&&verified.messageSha256===server.messageSha256&&verified.wireSha256===server.wireSha256,'WIRE');}
 }catch{throw new MiningTaxClaimSettlementError('WIRE');}
 // The strict shared envelope already binds the actual receipt prefix to these
 // exact signatures/hash strings, original term, intended payment and explicit
 // saved user caps. It does not expose raw chain accounts/CPI here, so none are
 // fabricated or represented as an independently browser-verified receipt.
 return Object.freeze({phase:recovery.status,recovery,browserFinalityVerified:false,currentSigningAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false});
}
