/** One explicit send of durable tax consent. Reads owner receipts but cannot
 * write one, sign, replace a packet, authorize archival or schedule another send. */
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {getMiningTaxClaimSigned} from './taxClaimSignedStore';
import {getMiningTaxClaimFailure} from './taxClaimFailure';
import {hasMiningTaxClaimContinuation} from './taxClaimContinuation';
import {getMiningTaxClaimSettlement,type MiningTaxClaimSettlement} from './taxClaimSettlement';
import {createMiningTaxClaimAdmission,type MiningTaxClaimAdmissionSources} from './taxClaimAdmission';

const MAX_TIMEOUT_MS=30_000,MAX_FLIGHTS=32;
const requestSchema=z.object({wallet:z.string().min(32).max(44).refine(value=>{if(value.length<32||value.length>44)return false;try{const key=new PublicKey(value);return key.toBase58()===value&&PublicKey.isOnCurve(key.toBytes())&&!key.equals(PublicKey.default);}catch{return false;}}),
 idempotencyKey:z.uuid().refine(value=>value===value.toLowerCase()),ordinal:z.number().int().min(0).max(1)}).strict();
export type MiningTaxClaimReconcileRequest=Readonly<z.infer<typeof requestSchema>>;
export interface MiningTaxClaimTransport{
 getGenesisHash():Promise<string>;
 /** Null permits this same wire only; it never proves finalized absence. */
 getSignatureStatuses(signatures:readonly string[],options:{searchTransactionHistory:true}):Promise<unknown>;
 getBlockHeight(options:{commitment:'finalized';minContextSlot:number}):Promise<number>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
/** Reviewed server sources only. No admission-result or owner-writer injection. */
export interface MiningTaxClaimRelaySources{readonly admission:MiningTaxClaimAdmissionSources;readonly transport:(signal:AbortSignal)=>MiningTaxClaimTransport;readonly timeoutMs?:number}
export type MiningTaxClaimReconcileReason='INVALID_INPUT'|'BUSY'|'NOT_SIGNED'|'SOURCE_CONFLICT'|'SETTLEMENT_HELD'|'CLAIM_FAILED_CHECK_RECEIPT'|'TRANSPORT_UNAVAILABLE'|'IDENTITY'|'OBSERVED_TRANSACTION'|'FINALIZED_ERROR_UNVERIFIED'|'EXPIRED_UNRESOLVED'|'ADMISSION_HELD'|'PAUSED'|'SEND_UNCERTAIN'|'TIMEOUT'|'CONTINUED';
/** ordinal identifies the requested wire. A saved terminal settlement may cover
 * a later prefix; settlement.ordinal remains its actual verified prefix. */
export type MiningTaxClaimReconcileResult=
 |Readonly<MiningTaxClaimReconcileRequest&{status:'settled';signature:string;settlement:MiningTaxClaimSettlement;claimFinalized:true}>
 |Readonly<MiningTaxClaimReconcileRequest&{status:'setup';signature:string;settlement:MiningTaxClaimSettlement;claimFinalized:false}>
 |Readonly<MiningTaxClaimReconcileRequest&{status:'submitted';signature:string;wireSha256:string;claimFinalized:false}>
 |Readonly<MiningTaxClaimReconcileRequest&{status:'held';signature?:string;reason:MiningTaxClaimReconcileReason;claimFinalized:false}>;
const safe=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const fields=(value:unknown,allowed:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&allowed.includes(key));
const held=(request:MiningTaxClaimReconcileRequest,reason:MiningTaxClaimReconcileReason,signature?:string):MiningTaxClaimReconcileResult=>Object.freeze({...request,status:'held',reason,claimFinalized:false,...(signature?{signature}:{})});
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

export function createMiningTaxClaimReconciler(db:Db,input:MiningTaxClaimRelaySources){
 if(!fields(input,['admission','transport','timeoutMs'])||typeof input.transport!=='function')throw Error('Invalid mining tax relay sources');
 const timeout=input.timeoutMs??MAX_TIMEOUT_MS,transport=input.transport;
 if(!safe(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)throw Error('Invalid mining tax relay deadline');
 // Eager source validation performs no RPC. Each flight constructs its own
 // admission reader, so a previous observation can never authorize another send.
 createMiningTaxClaimAdmission(db,input.admission);
 const connect=input.admission.connect,policy=copyPolicy(input.admission),now=policy.now??(()=>new Date()),flights=new Map<string,Promise<MiningTaxClaimReconcileResult>>();
 return function step(value:MiningTaxClaimReconcileRequest):Promise<MiningTaxClaimReconcileResult>{
  if(!fields(value,['wallet','idempotencyKey','ordinal']))return Promise.resolve(held({wallet:'',idempotencyKey:'',ordinal:0},'INVALID_INPUT'));
  const parsed=requestSchema.safeParse(value);if(!parsed.success)return Promise.resolve(held({wallet:'',idempotencyKey:'',ordinal:0},'INVALID_INPUT'));
  const request=parsed.data,key=`${request.wallet}:${request.idempotencyKey}:${request.ordinal}`,old=flights.get(key);if(old)return old;
  if(flights.size>=MAX_FLIGHTS)return Promise.resolve(held(request,'BUSY'));
  const controller=new AbortController(),pending=new Set<Promise<unknown>>();let workDone=false,replyDone=false,signature:string|undefined,reply:Promise<MiningTaxClaimReconcileResult>;
  const active=()=>controller.signal.throwIfAborted();
  const release=()=>{if(workDone&&replyDone&&pending.size===0&&flights.get(key)===reply)flights.delete(key);};
  function guarded<T extends object>(rpc:T):T{return new Proxy(rpc,{get(target,name,receiver){const method=Reflect.get(target,name,receiver);if(typeof method!=='function')return method;
   return async(...args:unknown[])=>{active();const call=Promise.resolve().then(()=>{active();return method.apply(target,args);});pending.add(call);try{const result=await call;active();return result;}finally{pending.delete(call);release();}};
  }});}
  const recover=async():Promise<MiningTaxClaimReconcileResult|null>=>{
   if(await hasMiningTaxClaimContinuation(db,{wallet:request.wallet,idempotencyKey:request.idempotencyKey})){active();return held(request,'CONTINUED',signature);}active();
   // An exact failed packet stays held even while paused or providerless. Its
   // owner proof is exposed only by GET; it never completes the whole plan.
   const failure=await getMiningTaxClaimFailure(db,request);active();
   if(failure){signature=failure.receipt.signature;return held(request,'CLAIM_FAILED_CHECK_RECEIPT',signature);}
   // The final prefix also suppresses a stale request to resend its setup.
   let saved=await getMiningTaxClaimSettlement(db,{...request,ordinal:1});active();
   if(!saved&&request.ordinal===0){saved=await getMiningTaxClaimSettlement(db,request);active();}
   if(!saved)return null;const original=saved.receipt.transactions[request.ordinal];if(!original)throw Error('Saved receipt lacks requested wire');
   return saved.claimFinalized?freeze({...request,status:'settled',signature:original.signature,settlement:saved,claimFinalized:true}):freeze({...request,status:'setup',signature:original.signature,settlement:saved,claimFinalized:false});
  };
  const run=async():Promise<MiningTaxClaimReconcileResult>=>{
   try{const prior=await recover();if(prior)return prior;}catch{active();return held(request,'SETTLEMENT_HELD');}
   const saved=await getMiningTaxClaimSigned(db,{wallet:request.wallet,idempotencyKey:request.idempotencyKey});active();
   const original=saved?.wires.find(wire=>wire.ordinal===request.ordinal);if(!saved||!original)return held(request,'NOT_SIGNED');
   const p=saved.preparation,bytes=Buffer.from(original.signedTransactionHex,'hex'),floor=Math.max(p.source.snapshotSlot,p.source.blockhashSlot);signature=original.signature;
   const consent=():MiningTaxClaimReconcileResult|null=>{active();if(!phaseEMiningEnabled())return held(request,'PAUSED',signature);const at=now();
    if(!(at instanceof Date)||!Number.isFinite(+at))return held(request,'SOURCE_CONFLICT',signature);
    return +at<Date.parse(p.preparedAt)||+at>=Date.parse(p.expiresAt)?held(request,'EXPIRED_UNRESOLVED',signature):null;};
   const firstHold=consent();if(firstHold)return firstHold;
   let rpc:MiningTaxClaimTransport,firstHeight:number;
   try{
    rpc=guarded(transport(controller.signal));if(await rpc.getGenesisHash()!==p.source.genesisHash)return held(request,'IDENTITY',signature);
    const raw=await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true});active();
    if(!raw||typeof raw!=='object'||!('context'in raw)||!('value'in raw))return held(request,'TRANSPORT_UNAVAILABLE',signature);
    const context=raw.context;if(!context||typeof context!=='object'||!('slot'in context)||!safe(context.slot)||context.slot<floor||!Array.isArray(raw.value)||raw.value.length!==1)return held(request,'TRANSPORT_UNAVAILABLE',signature);
    const observed=raw.value[0];if(observed!==null){
     if(!observed||typeof observed!=='object'||!safe(observed.slot)||observed.slot>context.slot||!('err'in observed)||!('confirmations'in observed)||!(observed.confirmations===null||safe(observed.confirmations))||!['processed','confirmed','finalized',undefined].includes(observed.confirmationStatus))return held(request,'TRANSPORT_UNAVAILABLE',signature);
     return held(request,observed.confirmationStatus==='finalized'&&observed.err!==null?'FINALIZED_ERROR_UNVERIFIED':'OBSERVED_TRANSACTION',signature);
    }
    firstHeight=await rpc.getBlockHeight({commitment:'finalized',minContextSlot:floor});if(!safe(firstHeight)||firstHeight<p.blockHeight)return held(request,'TRANSPORT_UNAVAILABLE',signature);
    if(await rpc.getGenesisHash()!==p.source.genesisHash)return held(request,'IDENTITY',signature);
    if(firstHeight>p.lastValidBlockHeight)return held(request,'EXPIRED_UNRESOLVED',signature);
   }catch{active();return held(request,'TRANSPORT_UNAVAILABLE',signature);}
   let admitted;
   try{const admit=createMiningTaxClaimAdmission(db,{...policy,connect:signal=>{const combined=AbortSignal.any([signal,controller.signal]);combined.throwIfAborted();return guarded(connect(combined));}});admitted=await admit(request);}
   catch{active();return held(request,phaseEMiningEnabled()?'ADMISSION_HELD':'PAUSED',signature);}active();
   if(admitted.wallet!==request.wallet||admitted.idempotencyKey!==request.idempotencyKey||admitted.claimId!==p.claimId||admitted.ordinal!==request.ordinal||admitted.signature!==signature||admitted.messageSha256!==original.messageSha256||admitted.wireSha256!==original.wireSha256||admitted.signedTransactionHex!==original.signedTransactionHex||
    admitted.source.genesisHash!==p.source.genesisHash||admitted.source.programId!==p.source.programId||admitted.source.reviewedDeploymentSlot!==p.source.reviewedDeploymentSlot||admitted.source.reviewedProgramDataSha256!==p.source.reviewedProgramDataSha256||admitted.source.lastValidBlockHeight!==p.lastValidBlockHeight)return held(request,'SOURCE_CONFLICT',signature);
   try{const prior=await recover();if(prior)return prior;}catch{active();return held(request,'SETTLEMENT_HELD',signature);}
   const minContextSlot=Math.max(admitted.source.snapshotSlot,admitted.source.feeSlot);
   try{
    const height=await rpc.getBlockHeight({commitment:'finalized',minContextSlot});if(!safe(height)||height<Math.max(p.blockHeight,firstHeight,admitted.source.blockHeight))return held(request,'TRANSPORT_UNAVAILABLE',signature);
    if(height>p.lastValidBlockHeight)return held(request,'EXPIRED_UNRESOLVED',signature);
    if(await rpc.getGenesisHash()!==p.source.genesisHash)return held(request,'IDENTITY',signature);
   }catch{active();return held(request,'TRANSPORT_UNAVAILABLE',signature);}
   // Final transport reads may outlive another worker's owner proof. Recheck
   // saved outcomes after those awaits, then recheck consent before the send.
   try{const prior=await recover();if(prior)return prior;}catch{active();return held(request,'SETTLEMENT_HELD',signature);}
   const finalHold=consent();if(finalHold)return finalHold;
   try{const ack=await rpc.sendRawTransaction(Uint8Array.from(bytes),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot});active();
    if(ack!==signature)return held(request,'SEND_UNCERTAIN',signature);
    return Object.freeze({...request,status:'submitted',signature,wireSha256:original.wireSha256,claimFinalized:false});
   }catch{active();return held(request,'SEND_UNCERTAIN',signature);}
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  const work=run().catch(()=>held(request,controller.signal.aborted?'TIMEOUT':'SOURCE_CONFLICT',signature));void work.then(()=>{workDone=true;release();});
  reply=Promise.race([work,new Promise<MiningTaxClaimReconcileResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(held(request,'TIMEOUT',signature));},timeout);})]).finally(()=>{if(timer!==undefined)clearTimeout(timer);controller.abort();replyDone=true;release();});
  flights.set(key,reply);return reply;
 };
}
function copyPolicy(s:MiningTaxClaimAdmissionSources):Omit<MiningTaxClaimAdmissionSources,'connect'>{
 const m=s.trust.mining,t=s.trust.seeker,k=(value:PublicKey)=>new PublicKey(value.toBytes());
 return {...(s.timeoutMs===undefined?{}:{timeoutMs:s.timeoutMs}),...(s.now===undefined?{}:{now:s.now}),trust:{mining:{...m,programId:k(m.programId),keepMint:k(m.keepMint),reserveOwner:k(m.reserveOwner)},
  seeker:{...t,programId:k(t.programId),config:k(t.config),mint:k(t.mint),prizeOwner:k(t.prizeOwner),prizeAta:k(t.prizeAta),genesisHash:k(t.genesisHash),deployment:{...t.deployment}}}};
}
