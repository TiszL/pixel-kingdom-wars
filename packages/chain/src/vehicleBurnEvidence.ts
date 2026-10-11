/** Exact direct uncompressed Core burn evidence, conditional on the supplied
 * transaction. This pure verifier does NOT establish finality or pre-burn owner:
 * Core burn delegates can sign too. Only the independent finalized history
 * reader plus the private server registry may authorize installation. */
import {Message,PublicKey,PACKET_DATA_SIZE,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {buildVehicleBurnMessage,type VehicleBurnMessageInput} from './vehicleBurnMessage';
import {buildVehicleServiceBurnMessage,type VehicleServiceBurnMessageInput} from './vehicleServiceBurnMessage';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
type Code='INPUT'|'SIGNATURE'|'TRANSACTION'|'UNAVAILABLE'|'FAILED'|'BALANCES';
export class VehicleBurnEvidenceError extends Error {
 readonly reservationReleaseAuthorized=false;
 constructor(readonly code:Code){super(`Vehicle burn evidence refused: ${code}`);this.name='VehicleBurnEvidenceError';}
}
function need(v:unknown,code:Code):asserts v{if(!v)throw new VehicleBurnEvidenceError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export interface VehicleBurnExpectation {
 readonly plan:VehicleBurnMessageInput;
 readonly preparedMessageBytes:Uint8Array;
 readonly signedTransaction:Uint8Array;
}
// Both public protocols rebuild their own fixed message. No caller can supply
// a builder or a preverified proof to this module-private transaction core.
function verifyExactBurnEvidence(tx:VersionedTransactionResponse|null,input:VehicleBurnExpectation,plan:ReturnType<typeof buildVehicleBurnMessage>){
 try{
  need(input&&typeof input==='object'&&!Array.isArray(input),'INPUT');
  const fields=Reflect.ownKeys(input);need(fields.length===3&&fields.every(k=>['plan','preparedMessageBytes','signedTransaction'].includes(k as string)),'INPUT');
  const wanted=Message.from(plan.messageBytes),keys=wanted.accountKeys;
  need(input.preparedMessageBytes instanceof Uint8Array&&input.preparedMessageBytes.length<=PACKET_DATA_SIZE
   &&Buffer.from(input.preparedMessageBytes).equals(Buffer.from(plan.messageBytes)),'INPUT');
  let signed;try{signed=verifyMiningClaimSignedWire({wallet:new PublicKey(plan.wallet),intentBytes:plan.messageBytes,signedTransaction:input.signedTransaction});}
  catch{throw new VehicleBurnEvidenceError('SIGNATURE');}
  need(tx&&tx.meta,'UNAVAILABLE');need(safe(tx.slot)&&(tx.version===undefined||tx.version==='legacy'),'TRANSACTION');
  need(tx.blockTime===undefined||tx.blockTime===null||safe(tx.blockTime),'TRANSACTION');
  const raw=tx.transaction?.message,meta=tx.meta;
  need(raw&&raw.version==='legacy'&&Array.isArray(raw.accountKeys)&&raw.accountKeys.length===keys.length
   &&Array.isArray(raw.instructions)&&raw.instructions.length===wanted.instructions.length,'TRANSACTION');
  need(raw.header&&safe(raw.header.numRequiredSignatures)&&safe(raw.header.numReadonlySignedAccounts)&&safe(raw.header.numReadonlyUnsignedAccounts)
   &&typeof raw.recentBlockhash==='string'&&raw.recentBlockhash.length>=32&&raw.recentBlockhash.length<=44,'TRANSACTION');
  const index=(n:number)=>{need(safe(n)&&n<keys.length,'TRANSACTION');return n;};
  // Own a bounded raw-field reconstruction; do not trust RPC object's methods.
  const canonical=new Message({header:{numRequiredSignatures:raw.header.numRequiredSignatures,
   numReadonlySignedAccounts:raw.header.numReadonlySignedAccounts,numReadonlyUnsignedAccounts:raw.header.numReadonlyUnsignedAccounts},
   accountKeys:Array.from(raw.accountKeys,(k,i)=>{need(k instanceof PublicKey&&k.equals(keys[i]!),'TRANSACTION');return new PublicKey(k.toBytes());}),
   recentBlockhash:raw.recentBlockhash,instructions:Array.from(raw.instructions,ix=>{
    need(ix&&typeof ix.data==='string'&&ix.data.length<=1683&&Array.isArray(ix.accounts)&&ix.accounts.length<=keys.length,'TRANSACTION');
    const data=bs58.decode(ix.data);need(data.length<=PACKET_DATA_SIZE&&bs58.encode(data)===ix.data,'TRANSACTION');
    return {programIdIndex:index(ix.programIdIndex),accounts:Array.from(ix.accounts,index),data:ix.data};
   })});
  need(canonical.serialize().equals(Buffer.from(plan.messageBytes))&&Array.isArray(tx.transaction.signatures)
   &&tx.transaction.signatures.length===1&&tx.transaction.signatures[0]===signed.signature,'TRANSACTION');
  need(meta.err!==undefined,'UNAVAILABLE');need(meta.err===null,'FAILED');
  need(!meta.loadedAddresses||Array.isArray(meta.loadedAddresses.readonly)&&Array.isArray(meta.loadedAddresses.writable)
   &&meta.loadedAddresses.readonly.length===0&&meta.loadedAddresses.writable.length===0,'TRANSACTION');
  // The supported ordinary burn uses direct lamport mutation, no CPI. Any
  // plugin/hook/CPI path needs a separately reviewed execution contract.
  need(meta.innerInstructions!==null&&meta.innerInstructions!==undefined,'UNAVAILABLE');
  need(Array.isArray(meta.innerInstructions)&&meta.innerInstructions.length===0,'TRANSACTION');
  for(const balances of [meta.preTokenBalances,meta.postTokenBalances])need(balances===undefined||balances===null||Array.isArray(balances)&&balances.length===0,'BALANCES');
  need(safe(meta.fee)&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===keys.length
   &&meta.postBalances.length===keys.length&&Array.from(meta.preBalances).every(safe)&&Array.from(meta.postBalances).every(safe),'BALANCES');
  const asset=keys.findIndex(k=>k.toBase58()===plan.identity.assetId),pre=meta.preBalances.map(BigInt),post=meta.postBalances.map(BigInt),fee=BigInt(meta.fee);
  const refund=pre[asset]!-post[asset]!;need(refund>=0n,'BALANCES');
  for(let i=0;i<keys.length;i++)need(post[i]!-pre[i]! === (i===0?refund-fee:i===asset?-refund:0n),'BALANCES');
  return Object.freeze({version:1 as const,reservationId:plan.reservationId,wallet:plan.wallet,identity:plan.identity,
   signature:signed.signature,slot:tx.slot,blockTime:tx.blockTime??null,originalMessageSha256:signed.messageSha256,
   signedTransactionSha256:signed.wireSha256,feeLamports:fee.toString(),assetRefundLamports:refund.toString(),
   transactionEvidenceVerified:true as const,finalityVerified:false as const,preBurnOwnershipVerified:false as const,
   registryMembershipVerified:false as const,installationAuthorized:false as const});
 }catch(error){if(error instanceof VehicleBurnEvidenceError)throw error;throw new VehicleBurnEvidenceError('INPUT');}
}
export function verifyVehicleBurnEvidence(tx:VersionedTransactionResponse|null,input:VehicleBurnExpectation){
 try{return verifyExactBurnEvidence(tx,input,buildVehicleBurnMessage(input.plan));}
 catch(error){if(error instanceof VehicleBurnEvidenceError)throw error;throw new VehicleBurnEvidenceError('INPUT');}
}
export interface VehicleServiceBurnExpectation extends Omit<VehicleBurnExpectation,'plan'> {readonly plan:VehicleServiceBurnMessageInput}
export function verifyVehicleServiceBurnEvidence(tx:VersionedTransactionResponse|null,input:VehicleServiceBurnExpectation){
 try{
  const plan=buildVehicleServiceBurnMessage(input.plan),proof=verifyExactBurnEvidence(tx,input,plan);
  return Object.freeze({...proof,version:2 as const,purpose:'vehicle_service' as const,service:plan.service,serviceSha256:plan.serviceSha256,serviceAuthorized:false as const});
 }catch(error){if(error instanceof VehicleBurnEvidenceError)throw error;throw new VehicleBurnEvidenceError('INPUT');}
}
export type VehicleBurnEvidence=ReturnType<typeof verifyVehicleBurnEvidence>;
export type VehicleServiceBurnEvidence=ReturnType<typeof verifyVehicleServiceBurnEvidence>;
