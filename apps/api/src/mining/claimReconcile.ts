/** One recovery/send step using only the saved claimant wire. No signing,
 * replacement blockhash, cursor invention, scheduler or automatic activation. */
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { MiningClaimSnapshotReader,MiningClaimSnapshotTrust } from '@shardkeep/chain/mining-claim-snapshot';
import type { MiningClaimReceiptReader,MiningClaimReceiptTrust } from '@shardkeep/chain/mining-claim-receipt';
import { createMiningClaimFailure,getMiningClaimFailure,type MiningClaimFailure } from './claimFailure';
import { phaseEMiningEnabled } from '../config';
import type { Db } from '../db/client';
import { getMiningClaimSigned } from './claimSignedStore';
import { createMiningClaimAdmission } from './claimAdmission';
import { createMiningClaimSettlement,getMiningClaimSettlement,type MiningClaimSettlement } from './claimSettlement';
const MAX_TIMEOUT_MS=30_000,MAX_FLIGHTS=32;
const requestSchema=z.object({wallet:z.string().min(32).max(44),claimId:z.uuid(),ordinal:z.number().int().min(0).max(1)}).strict();
export type MiningClaimReconcileRequest=z.infer<typeof requestSchema>;
export interface MiningClaimTransport {
 getGenesisHash():Promise<string>;
 /** Null is never finalized absence proof; it only allows the same wire retry. */
 getSignatureStatuses(signatures:readonly string[],options:{searchTransactionHistory:true}):Promise<unknown>;
 getBlockHeight(options:{commitment:'finalized';minContextSlot:number}):Promise<number>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
interface MiningClaimReconcileCommon {
 admission:{reader:MiningClaimSnapshotReader;trust:MiningClaimSnapshotTrust};
 transport:(signal:AbortSignal)=>MiningClaimTransport;now?:()=>Date;timeoutMs?:number;
}
export interface MiningClaimTrustedReconcileSources extends MiningClaimReconcileCommon {
 mode?:'trusted-verifier';settlement:{reader:MiningClaimReceiptReader;trust:MiningClaimReceiptTrust};
}
export interface MiningClaimRuntimeRelaySources extends MiningClaimReconcileCommon {
 mode:'read-saved-receipt';settlement?:never;
}
export type MiningClaimReconcileSources=MiningClaimTrustedReconcileSources|MiningClaimRuntimeRelaySources;
type Reason='INVALID_INPUT'|'BUSY'|'NOT_SIGNED'|'SOURCE_CONFLICT'|'SETTLEMENT_HELD'|'TRANSPORT_UNAVAILABLE'|'IDENTITY'|'OBSERVED_TRANSACTION'|'FINALIZED_ERROR_UNVERIFIED'|'EXPIRED_UNRESOLVED'|'ADMISSION_HELD'|'CLAIM_PROOF_STALE'|'PAUSED'|'SEND_UNCERTAIN'|'TIMEOUT';
export type MiningClaimReconcileResult=
 |Readonly<{status:'settled';claimId:string;ordinal:number;signature:string;settlement:MiningClaimSettlement}>
 |Readonly<{status:'failed';claimId:string;ordinal:number;signature:string;failure:MiningClaimFailure}>
 |Readonly<{status:'submitted';claimId:string;ordinal:number;signature:string;wireSha256:string;claimFinalized:false}>
 |Readonly<{status:'held';claimId:string;ordinal:number;signature?:string;reason:Reason}>;
const held=(claimId:string,ordinal:number,reason:Reason,signature?:string):MiningClaimReconcileResult=>Object.freeze({status:'held',claimId,ordinal,reason,...(signature?{signature}:{})});
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function code(e:unknown):string|undefined{return e&&typeof e==='object'&&'code'in e&&typeof e.code==='string'?e.code:undefined;}
function copied<T extends MiningClaimSnapshotTrust>(t:T):T{return {...t,programId:new PublicKey(t.programId.toBytes()),keepMint:new PublicKey(t.keepMint.toBytes()),reserveOwner:new PublicKey(t.reserveOwner.toBytes())};}
export function createMiningClaimReconciler(db:Db,input:MiningClaimReconcileSources){
 if(input.mode==='read-saved-receipt'&&'settlement'in input)throw Error('Runtime mining relay cannot receive a settlement source');
 if(input.mode!==undefined&&input.mode!=='trusted-verifier'&&input.mode!=='read-saved-receipt')throw Error('Invalid mining claim reconcile mode');
 const admissionTrust=copied(input.admission.trust),connect=input.transport,now=input.now??(()=>new Date());
 const receiptSource=input.mode==='read-saved-receipt'?null:{reader:input.settlement.reader,trust:copied(input.settlement.trust)};
 const admissionSource=input.admission.reader,timeout=input.timeoutMs??MAX_TIMEOUT_MS;
 if(!safe(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)throw Error('Invalid mining claim reconcile deadline');
 if(receiptSource){
  for(const k of ['expectedGenesisHash','reviewedDeploymentSlot','reviewedProgramDataSha256'] as const)if(admissionTrust[k]!==receiptSource.trust[k])throw Error('Mining claim source identity mismatch');
  for(const k of ['programId','keepMint','reserveOwner'] as const)if(!admissionTrust[k].equals(receiptSource.trust[k]))throw Error('Mining claim source identity mismatch');
 }
 const flights=new Map<string,Promise<MiningClaimReconcileResult>>();
 return function step(value:MiningClaimReconcileRequest):Promise<MiningClaimReconcileResult>{
  const parsed=requestSchema.safeParse(value);if(!parsed.success)return Promise.resolve(held('',0,'INVALID_INPUT'));const request=parsed.data,key=`${request.wallet}:${request.claimId}:${request.ordinal}`;
  const old=flights.get(key);if(old)return old;if(flights.size>=MAX_FLIGHTS)return Promise.resolve(held(request.claimId,request.ordinal,'BUSY'));
  const controller=new AbortController(),pending=new Set<Promise<unknown>>();let signature:string|undefined,workDone=false,replyDone=false,reply:Promise<MiningClaimReconcileResult>;
  const active=()=>controller.signal.throwIfAborted();
  const release=()=>{if(workDone&&replyDone&&pending.size===0&&flights.get(key)===reply)flights.delete(key);};
  function guarded<T extends object>(reader:T):T{return new Proxy(reader,{get(target,name,receiver){const v=Reflect.get(target,name,receiver);if(typeof v!=='function')return v;
   return async(...args:unknown[])=>{active();const call=Promise.resolve().then(()=>{active();return v.apply(target,args);});pending.add(call);try{const result=await call;active();return result;}finally{pending.delete(call);release();}};
  }});}
  const run=async():Promise<MiningClaimReconcileResult>=>{
   // Both modes recover saved outcomes before flags or live readers. A read
   // failure never opens the send path; runtime has no terminal writer.
   try{
    const failure=await getMiningClaimFailure(db,request),settlement=await getMiningClaimSettlement(db,request);active();
    if(failure&&settlement)return held(request.claimId,request.ordinal,'SETTLEMENT_HELD');
    if(failure){signature=failure.signature;return Object.freeze({status:'failed',claimId:request.claimId,ordinal:request.ordinal,signature,failure});}
    if(settlement){signature=settlement.signature;return Object.freeze({status:'settled',claimId:request.claimId,ordinal:request.ordinal,signature,settlement});}
   }catch{active();return held(request.claimId,request.ordinal,'SETTLEMENT_HELD');}
   const saved=await getMiningClaimSigned(db,{wallet:request.wallet,claimId:request.claimId});active();const original=saved?.wires.find(w=>w.ordinal===request.ordinal);
   if(!saved||!original)return held(request.claimId,request.ordinal,'NOT_SIGNED');signature=original.signature;const p=saved.preparation,wire=Buffer.from(original.signedTransactionHex,'hex');
   if(receiptSource){
    const settle=createMiningClaimSettlement(db,{reader:guarded(receiptSource.reader),trust:receiptSource.trust,timeoutMs:timeout});
    let successCode:string|undefined;
    try{const settlement=await settle(request);active();return Object.freeze({status:'settled',claimId:request.claimId,ordinal:request.ordinal,signature,settlement});}
    catch(e){active();successCode=code(e);}
    const fail=createMiningClaimFailure(db,{reader:guarded(receiptSource.reader),trust:receiptSource.trust,timeoutMs:timeout});
    try{const failure=await fail(request);active();return Object.freeze({status:'failed',claimId:request.claimId,ordinal:request.ordinal,signature,failure});}
    catch(e){active();if(successCode!=='RECEIPT_UNAVAILABLE'||code(e)!=='RECEIPT_UNAVAILABLE')return held(request.claimId,request.ordinal,'SETTLEMENT_HELD',signature);}

   }
   if(p.header.genesisHash!==admissionTrust.expectedGenesisHash||p.header.programId!==admissionTrust.programId.toBase58())return held(request.claimId,request.ordinal,'SOURCE_CONFLICT',signature);
   if(!phaseEMiningEnabled())return held(request.claimId,request.ordinal,'PAUSED',signature);
   const floor=p.blockhashContextSlot;let rpc:MiningClaimTransport;
   try{
    rpc=guarded(connect(controller.signal));if(await rpc.getGenesisHash()!==p.header.genesisHash)return held(request.claimId,request.ordinal,'IDENTITY',signature);
    const raw=await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true});active();
    if(!raw||typeof raw!=='object'||!('context'in raw)||!('value'in raw))return held(request.claimId,request.ordinal,'TRANSPORT_UNAVAILABLE',signature);
    const context=raw.context;if(!context||typeof context!=='object'||!('slot'in context)||!safe(context.slot)||context.slot<floor||!Array.isArray(raw.value)||raw.value.length!==1)return held(request.claimId,request.ordinal,'TRANSPORT_UNAVAILABLE',signature);
    const observed=raw.value[0];if(observed!==null){
     if(!observed||typeof observed!=='object'||!safe(observed.slot)||observed.slot>context.slot||!('err'in observed)||!('confirmations'in observed)||!(observed.confirmations===null||safe(observed.confirmations))||!['processed','confirmed','finalized',undefined].includes(observed.confirmationStatus))return held(request.claimId,request.ordinal,'TRANSPORT_UNAVAILABLE',signature);
     // Status alone is not our exact finalized failed-transaction proof. Keep
     // the original signature; do not mark it paid, replace it or clear it.
     return held(request.claimId,request.ordinal,observed.confirmationStatus==='finalized'&&observed.err!==null?'FINALIZED_ERROR_UNVERIFIED':'OBSERVED_TRANSACTION',signature);
    }
    const height=await rpc.getBlockHeight({commitment:'finalized',minContextSlot:floor});if(!safe(height))return held(request.claimId,request.ordinal,'TRANSPORT_UNAVAILABLE',signature);
    if(await rpc.getGenesisHash()!==p.header.genesisHash)return held(request.claimId,request.ordinal,'IDENTITY',signature);
    if(height>p.lastValidBlockHeight)return held(request.claimId,request.ordinal,'EXPIRED_UNRESOLVED',signature);
   }catch{active();return held(request.claimId,request.ordinal,'TRANSPORT_UNAVAILABLE',signature);}
   let admitted;try{admitted=await createMiningClaimAdmission(db,{reader:guarded(admissionSource),trust:admissionTrust,now,timeoutMs:timeout})(request);}catch(e){active();return held(request.claimId,request.ordinal,code(e)==='CLAIM_PROOF_STALE'?'CLAIM_PROOF_STALE':'ADMISSION_HELD',signature);}active();
   if(admitted.signature!==signature||!Buffer.from(admitted.signedTransaction).equals(wire))return held(request.claimId,request.ordinal,'SOURCE_CONFLICT',signature);
   const at=now();if(!(at instanceof Date)||!Number.isFinite(+at)||+at>=Date.parse(p.expiresAt)||+at<Date.parse(p.preparedAt))return held(request.claimId,request.ordinal,'ADMISSION_HELD',signature);
   if(!phaseEMiningEnabled())return held(request.claimId,request.ordinal,'PAUSED',signature);active();
   try{const ack=await rpc.sendRawTransaction(Uint8Array.from(wire),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:admitted.snapshotSlot});active();
    if(ack!==signature)return held(request.claimId,request.ordinal,'SEND_UNCERTAIN',signature);
    return Object.freeze({status:'submitted',claimId:request.claimId,ordinal:request.ordinal,signature,wireSha256:original.wireSha256,claimFinalized:false});
   }catch{active();return held(request.claimId,request.ordinal,'SEND_UNCERTAIN',signature);}
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  const work=run().catch(()=>held(request.claimId,request.ordinal,controller.signal.aborted?'TIMEOUT':'SOURCE_CONFLICT',signature));void work.then(()=>{workDone=true;release();});
  reply=Promise.race([work,new Promise<MiningClaimReconcileResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(held(request.claimId,request.ordinal,'TIMEOUT',signature));},timeout);})]).finally(()=>{if(timer)clearTimeout(timer);controller.abort();replyDone=true;release();});
  flights.set(key,reply);return reply;
 };
}
