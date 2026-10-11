/** One explicit recovery/send step. No signer, scheduler, new intent or release. */
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { MiningBackingReader,MiningBackingTrust } from '@shardkeep/chain/mining-backing';
import type { MiningPublicationReader,MiningPublicationTrust } from '@shardkeep/chain/mining-publication';
import type { Db } from '../db/client';
import { phaseEMiningEnabled } from '../config';
import { createMiningPublicationOutbox,type MiningPublicationOutboxRequest } from './publicationOutbox';
import { createMiningPublicationSettlement,createResourceMiningPublicationSettlement,type MiningPublicationSettlement,type ResourceMiningPublicationSettlement } from './publicationSettlement';
const MAX_TIMEOUT_MS=30_000;
const requestSchema=z.object({epochId:z.uuid(),attemptKey:z.string().min(8).max(128).refine(v=>v.trim()===v)}).strict();
export interface MiningPublicationTransport{
 getGenesisHash():Promise<string>;
 /** RPC status context is NOT finalized absence authority. Null only permits
  * retrying the same persisted wire, and can never release reserved inventory. */
 getSignatureStatuses(signatures:readonly string[],options:{searchTransactionHistory:true}):Promise<unknown>;
 getBlockHeight(options:{commitment:'finalized';minContextSlot:number}):Promise<number>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
export interface MiningPublicationReconcileSources{
 /** Application-owned custody domain. Historical callers retain ingot recovery. */
 domain?:'ingots'|'resources';
 backing:{reader:MiningBackingReader;trust:MiningBackingTrust};
 settlement:{reader:MiningPublicationReader;trust:MiningPublicationTrust};
 transport:(signal:AbortSignal)=>MiningPublicationTransport;
 /** Application-only technical test/deadline setting, never request input. */
 timeoutMs?:number;
}
type Reason='INVALID_INPUT'|'OWNER_REQUIRED'|'NOT_SIGNED'|'SOURCE_CONFLICT'|'SETTLEMENT_HELD'|'TRANSPORT_UNAVAILABLE'|'IDENTITY'|'OBSERVED_TRANSACTION'|'FINALIZED_ERROR'|'EXPIRED_UNRESOLVED'|'ADMISSION_HELD'|'PAUSED'|'SEND_UNCERTAIN'|'TIMEOUT';
type PublicationSettlement=MiningPublicationSettlement|ResourceMiningPublicationSettlement;
export type MiningPublicationReconcileResult<S extends PublicationSettlement=PublicationSettlement>=
 |Readonly<{status:'settled';epochId:string;signature:string;settlement:S}>
 |Readonly<{status:'submitted';epochId:string;signature:string;wireSha256:string;publicationFinalized:false}>
 |Readonly<{status:'held';epochId:string;signature?:string;reason:Reason}>;
const held=(epochId:string,reason:Reason,signature?:string):MiningPublicationReconcileResult=>Object.freeze({status:'held',epochId,reason,...(signature?{signature}:{})});
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function code(error:unknown):string|undefined{return error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:undefined;}
function copiedTrust<T extends MiningPublicationTrust>(v:T):T{return {...v,programId:new PublicKey(v.programId.toBytes()),keepMint:new PublicKey(v.keepMint.toBytes()),reserveOwner:new PublicKey(v.reserveOwner.toBytes())};}

/** Dependencies are application-owned raw readers; callers cannot inject a
 * successful receipt/admission or supply replacement bytes through this step. */
export function createMiningPublicationReconciler(db:Db,input:MiningPublicationReconcileSources&{domain:'resources'}):(value:MiningPublicationOutboxRequest)=>Promise<MiningPublicationReconcileResult<ResourceMiningPublicationSettlement>>;
export function createMiningPublicationReconciler(db:Db,input:MiningPublicationReconcileSources&{domain?:'ingots'}):(value:MiningPublicationOutboxRequest)=>Promise<MiningPublicationReconcileResult<MiningPublicationSettlement>>;
export function createMiningPublicationReconciler(db:Db,input:MiningPublicationReconcileSources):(value:MiningPublicationOutboxRequest)=>Promise<MiningPublicationReconcileResult>;
export function createMiningPublicationReconciler(db:Db,input:MiningPublicationReconcileSources){
 const domain=input.domain===undefined?'ingots':input.domain;
 if(domain!=='ingots'&&domain!=='resources')throw Error('Invalid mining reconciliation domain');
 const backingTrust=copiedTrust(input.backing.trust),receiptTrust=copiedTrust(input.settlement.trust),connect=input.transport;
 const backingSource=input.backing.reader,receiptSource=input.settlement.reader,timeout=input.timeoutMs??MAX_TIMEOUT_MS;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)throw Error('Invalid mining reconciliation deadline');
 for(const k of ['expectedGenesisHash','reviewedDeploymentSlot','reviewedProgramDataSha256'] as const)if(backingTrust[k]!==receiptTrust[k])throw Error('Mining reconciliation source identity mismatch');
 for(const k of ['programId','keepMint','reserveOwner'] as const)if(!backingTrust[k].equals(receiptTrust[k]))throw Error('Mining reconciliation source identity mismatch');
 type Flight={attemptKey:string;reply:Promise<MiningPublicationReconcileResult>};
 const flights=new Map<string,Flight>();
 return function step(value:MiningPublicationOutboxRequest):Promise<MiningPublicationReconcileResult>{
  const parsed=requestSchema.safeParse(value);if(!parsed.success)return Promise.resolve(held(typeof value?.epochId==='string'?value.epochId:'','INVALID_INPUT'));
  const request=parsed.data,existing=flights.get(request.epochId);if(existing)return existing.attemptKey===request.attemptKey?existing.reply:Promise.resolve(held(request.epochId,'SOURCE_CONFLICT'));
  const controller=new AbortController(),pending=new Set<Promise<unknown>>();let signature:string|undefined,workDone=false,replyDone=false,entry:Flight;
  const active=()=>controller.signal.throwIfAborted();
  const release=()=>{if(workDone&&replyDone&&pending.size===0&&flights.get(request.epochId)===entry)flights.delete(request.epochId);};
  // Track the raw call, not just a wrapper's timeout race. A non-cooperative
  // reader may outlive the response deadline; it must drain before another step.
  function guarded<T extends object>(reader:T):T{return new Proxy(reader,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);if(typeof v!=='function')return v;
   return async(...args:unknown[])=>{active();const call=Promise.resolve().then(()=>{active();return v.apply(target,args);});pending.add(call);
    try{const result=await call;active();return result;}finally{pending.delete(call);release();}
   };}});}
  const run=async():Promise<MiningPublicationReconcileResult>=>{
   const outbox=createMiningPublicationOutbox(db,{reader:guarded(backingSource),trust:backingTrust});
   let record;try{record=await outbox.get(request.epochId);}catch(e){active();return held(request.epochId,code(e)==='OWNER_REQUIRED'?'OWNER_REQUIRED':'SOURCE_CONFLICT');}active();
   if(!record?.signed)return held(request.epochId,'NOT_SIGNED');signature=record.signed.signature;
   if(record.attemptKey!==request.attemptKey||record.genesisHash!==backingTrust.expectedGenesisHash||record.programId!==backingTrust.programId.toBase58())return held(request.epochId,'SOURCE_CONFLICT',signature);
   const original=record.signed,wire=Buffer.from(original.signedTransactionHex,'hex');
   const settle=domain==='resources'?createResourceMiningPublicationSettlement(db,{reader:guarded(receiptSource),trust:receiptTrust}):createMiningPublicationSettlement(db,{reader:guarded(receiptSource),trust:receiptTrust});
   try{const settlement=await settle({...request,signature,signedTransaction:wire});active();return Object.freeze({status:'settled',epochId:request.epochId,signature,settlement});}
   catch(error){active();if(code(error)!=='RECEIPT_UNAVAILABLE')return held(request.epochId,code(error)==='OWNER_REQUIRED'?'OWNER_REQUIRED':'SETTLEMENT_HELD',signature);}
   if(!phaseEMiningEnabled())return held(request.epochId,'PAUSED',signature);
   const reservedSlot=record.backing['slot'];if(!safe(reservedSlot)||!safe(record.blockhashContextSlot)||!safe(record.lastValidBlockHeight))return held(request.epochId,'SOURCE_CONFLICT',signature);
   const floor=Math.max(reservedSlot,record.blockhashContextSlot);let rpc:MiningPublicationTransport;
   try{
    rpc=guarded(connect(controller.signal));if(await rpc.getGenesisHash()!==record.genesisHash)return held(request.epochId,'IDENTITY',signature);
    const raw=await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true});active();
    if(!raw||typeof raw!=='object'||!('context'in raw)||!('value'in raw))return held(request.epochId,'TRANSPORT_UNAVAILABLE',signature);
    const context=raw.context;if(!context||typeof context!=='object'||!('slot'in context)||!safe(context.slot)||context.slot<floor||!Array.isArray(raw.value)||raw.value.length!==1)return held(request.epochId,'TRANSPORT_UNAVAILABLE',signature);
    const observed=raw.value[0];
    if(observed!==null){
     if(!observed||typeof observed!=='object'||!safe(observed.slot)||observed.slot>context.slot||!('err'in observed)
      ||!('confirmations'in observed)||!(observed.confirmations===null||safe(observed.confirmations))
      ||!['processed','confirmed','finalized',undefined].includes(observed.confirmationStatus))return held(request.epochId,'TRANSPORT_UNAVAILABLE',signature);
     return held(request.epochId,observed.confirmationStatus==='finalized'&&observed.err!==null?'FINALIZED_ERROR':'OBSERVED_TRANSACTION',signature);
    }
    const height=await rpc.getBlockHeight({commitment:'finalized',minContextSlot:floor});active();
    if(!safe(height))return held(request.epochId,'TRANSPORT_UNAVAILABLE',signature);
    if(await rpc.getGenesisHash()!==record.genesisHash)return held(request.epochId,'IDENTITY',signature);
    if(height>record.lastValidBlockHeight)return held(request.epochId,'EXPIRED_UNRESOLVED',signature);
   }catch{active();return held(request.epochId,'TRANSPORT_UNAVAILABLE',signature);}
   let admitted;try{admitted=await outbox.admitBroadcast(request);}catch{active();return held(request.epochId,'ADMISSION_HELD',signature);}active();
   if(admitted.signature!==signature||admitted.outbox.signed?.wireSha256!==original.wireSha256||!Buffer.from(admitted.signedTransaction).equals(wire))return held(request.epochId,'SOURCE_CONFLICT',signature);
   // No await between final pause/deadline checks and entering this single send.
   if(!phaseEMiningEnabled())return held(request.epochId,'PAUSED',signature);active();
   try{const ack=await rpc.sendRawTransaction(Uint8Array.from(wire),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:admitted.backing.slot});active();
    if(ack!==signature)return held(request.epochId,'SEND_UNCERTAIN',signature);
    return Object.freeze({status:'submitted',epochId:request.epochId,signature,wireSha256:original.wireSha256,publicationFinalized:false});
   }catch{active();return held(request.epochId,'SEND_UNCERTAIN',signature);}
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  const work=run().catch(()=>held(request.epochId,controller.signal.aborted?'TIMEOUT':'SOURCE_CONFLICT',signature));
  void work.then(()=>{workDone=true;release();});
  const reply=Promise.race([work,new Promise<MiningPublicationReconcileResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(held(request.epochId,'TIMEOUT',signature));},timeout);})])
   .finally(()=>{if(timer)clearTimeout(timer);controller.abort();replyDone=true;release();});
  entry={attemptKey:request.attemptKey,reply};flights.set(request.epochId,entry);return reply;
 };
}
