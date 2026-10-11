/** One explicit delivery attempt of already durable wallet consent. No signing,
 * replacement transaction, owner receipt writer, scheduler or activation. */
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import type {Db} from '../db/client';
import {phaseESeekerEnabled} from '../config';
import {getRealmSaleSigned,type RealmSaleSignedKey} from './realmSaleSignedStore';
import {getRealmSaleSettlement,type RealmSaleSettlement} from './realmSaleSettlement';
import {getRealmSaleFailure} from './realmSaleFailure';
import {createRealmSaleAdmissionReader,type RealmSaleAdmissionSources} from './realmSaleAdmission';
const MAX_TIMEOUT_MS=30_000,MAX_FLIGHTS=32;
const requestSchema=z.object({wallet:z.string().min(32).max(44).refine(value=>{if(value.length<32||value.length>44)return false;try{return new PublicKey(value).toBase58()===value;}catch{return false;}}),idempotencyKey:z.uuid().refine(v=>v===v.toLowerCase())}).strict();
export interface RealmSaleTransport{
 getGenesisHash():Promise<string>;
 /** Null allows retrying this wire only, never proof of finalized absence. */
 getSignatureStatuses(signatures:readonly string[],options:{searchTransactionHistory:true}):Promise<unknown>;
 getBlockHeight(options:{commitment:'finalized';minContextSlot:number}):Promise<number>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
export interface RealmSaleRelaySources{admission:RealmSaleAdmissionSources;transport:(signal:AbortSignal)=>RealmSaleTransport;timeoutMs?:number}
type Reason='INVALID_INPUT'|'BUSY'|'NOT_SIGNED'|'SOURCE_CONFLICT'|'SETTLEMENT_HELD'|'TRANSPORT_UNAVAILABLE'|'IDENTITY'|'OBSERVED_TRANSACTION'|'FINALIZED_ERROR_UNVERIFIED'|'FINALIZED_FAILURE'|'EXPIRED_UNRESOLVED'|'ADMISSION_HELD'|'PAUSED'|'SEND_UNCERTAIN'|'TIMEOUT';
export type RealmSaleReconcileResult=
 |Readonly<RealmSaleSignedKey&{status:'settled';signature:string;settlement:RealmSaleSettlement}>
 |Readonly<RealmSaleSignedKey&{status:'submitted';signature:string;wireSha256:string;purchaseFinalized:false}>
 |Readonly<RealmSaleSignedKey&{status:'held';signature?:string;reason:Reason}>;
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const held=(key:RealmSaleSignedKey,reason:Reason,signature?:string):RealmSaleReconcileResult=>Object.freeze({...key,status:'held',reason,...(signature?{signature}:{})});
export function createRealmSaleReconciler(db:Db,input:RealmSaleRelaySources){
 if(!input||typeof input!=='object'||!Reflect.ownKeys(input).every(k=>['admission','transport','timeoutMs'].includes(k as string))||typeof input.transport!=='function')throw Error('Invalid realm sale relay sources');
 const timeout=input.timeoutMs??MAX_TIMEOUT_MS,transport=input.transport;
 if(!safe(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)throw Error('Invalid realm sale relay deadline');
 // The admission constructor copies and eagerly validates the server policy.
 // Each flight supplies a transport wrapper; there is no caller boolean reader.
 const admissionSources=input.admission,admissionConnect=admissionSources.connect;
 createRealmSaleAdmissionReader(admissionSources);
 const policy=structuredPolicy(admissionSources),flights=new Map<string,Promise<RealmSaleReconcileResult>>();
 return function step(value:RealmSaleSignedKey):Promise<RealmSaleReconcileResult>{
  const parsed=requestSchema.safeParse(value);
  if(!parsed.success||Reflect.ownKeys(value).some(k=>!['wallet','idempotencyKey'].includes(k as string)))return Promise.resolve(held({wallet:'',idempotencyKey:''},'INVALID_INPUT'));
  const request=parsed.data,key=`${request.wallet}:${request.idempotencyKey}`,old=flights.get(key);if(old)return old;
  if(flights.size>=MAX_FLIGHTS)return Promise.resolve(held(request,'BUSY'));
  const controller=new AbortController(),pending=new Set<Promise<unknown>>();let workDone=false,replyDone=false,signature:string|undefined,reply:Promise<RealmSaleReconcileResult>;
  const active=()=>controller.signal.throwIfAborted();
  const release=()=>{if(workDone&&replyDone&&pending.size===0&&flights.get(key)===reply)flights.delete(key);};
  function guarded<T extends object>(rpc:T):T{return new Proxy(rpc,{get(target,name,receiver){const method=Reflect.get(target,name,receiver);if(typeof method!=='function')return method;
   return async(...args:unknown[])=>{active();const call=Promise.resolve().then(()=>{active();return method.apply(target,args);});pending.add(call);try{const result=await call;active();return result;}finally{pending.delete(call);release();}};
  }});}
  // Absence of failure must be the final awaited observation: its owner can
  // commit while the success lookup is pending. Opposite outcomes remain held.
  const recover=async()=>{const saved=await getRealmSaleSettlement(db,request);active();const failure=await getRealmSaleFailure(db,request);active();if(failure)return held(request,'FINALIZED_FAILURE',failure.receipt.signature);return saved?Object.freeze({...request,status:'settled' as const,signature:saved.signature,settlement:saved}):null;};
  const run=async():Promise<RealmSaleReconcileResult>=>{
   // Runtime can read verified history but cannot create or release an outcome.
   try{const prior=await recover();if(prior)return prior;}catch{active();return held(request,'SETTLEMENT_HELD');}
   const saved=await getRealmSaleSigned(db,request);active();if(!saved?.wire)return held(request,'NOT_SIGNED');
   const {preparation:p,wire:original}=saved;signature=original.signature;const bytes=Buffer.from(original.signedTransactionHex,'hex'),floor=p.source.admissionSlot;
   if(!phaseESeekerEnabled())return held(request,'PAUSED',signature);
   let rpc:RealmSaleTransport;
   try{
    rpc=guarded(transport(controller.signal));if(await rpc.getGenesisHash()!==p.source.genesisHash)return held(request,'IDENTITY',signature);
    const raw=await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true});active();
    if(!raw||typeof raw!=='object'||!('context'in raw)||!('value'in raw))return held(request,'TRANSPORT_UNAVAILABLE',signature);
    const context=raw.context;if(!context||typeof context!=='object'||!('slot'in context)||!safe(context.slot)||context.slot<floor||!Array.isArray(raw.value)||raw.value.length!==1)return held(request,'TRANSPORT_UNAVAILABLE',signature);
    const observed=raw.value[0];if(observed!==null){
     if(!observed||typeof observed!=='object'||!safe(observed.slot)||observed.slot>context.slot||!('err'in observed)||!('confirmations'in observed)||!(observed.confirmations===null||safe(observed.confirmations))||!['processed','confirmed','finalized',undefined].includes(observed.confirmationStatus))return held(request,'TRANSPORT_UNAVAILABLE',signature);
     return held(request,observed.confirmationStatus==='finalized'&&observed.err!==null?'FINALIZED_ERROR_UNVERIFIED':'OBSERVED_TRANSACTION',signature);
    }
    const height=await rpc.getBlockHeight({commitment:'finalized',minContextSlot:floor});if(!safe(height))return held(request,'TRANSPORT_UNAVAILABLE',signature);
    if(await rpc.getGenesisHash()!==p.source.genesisHash)return held(request,'IDENTITY',signature);
    if(height>p.quote.lastValidBlockHeight)return held(request,'EXPIRED_UNRESOLVED',signature);
   }catch{active();return held(request,'TRANSPORT_UNAVAILABLE',signature);}
   let admitted;try{const reader=createRealmSaleAdmissionReader({...policy,connect:signal=>{const combined=AbortSignal.any([signal,controller.signal]);combined.throwIfAborted();return guarded(admissionConnect(combined));}});admitted=await reader(p);}
   catch{active();return held(request,phaseESeekerEnabled()?'ADMISSION_HELD':'PAUSED',signature);}active();
   if(admitted.wallet!==p.wallet||admitted.saleId!==p.saleId||admitted.messageSha256!==original.messageSha256||admitted.admissionEligible!==true)return held(request,'SOURCE_CONFLICT',signature);
   // A concurrently finalized purchase may already have been persisted while
   // admission was reading. Recovery always takes precedence over another send.
   try{const prior=await recover();if(prior)return prior;}catch{active();return held(request,'SETTLEMENT_HELD',signature);}
   try{if(await rpc.getGenesisHash()!==p.source.genesisHash)return held(request,'IDENTITY',signature);}catch{active();return held(request,'TRANSPORT_UNAVAILABLE',signature);}
   // The final transport await can race an owner outcome write too. No send may
   // follow an observed failure, and lookup outages remain a held original.
   try{const prior=await recover();if(prior)return prior;}catch{active();return held(request,'SETTLEMENT_HELD',signature);}
   if(!phaseESeekerEnabled())return held(request,'PAUSED',signature);active();
   try{const ack=await rpc.sendRawTransaction(Uint8Array.from(bytes),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:admitted.bracketSlot});active();
    if(ack!==signature)return held(request,'SEND_UNCERTAIN',signature);
    return Object.freeze({...request,status:'submitted',signature,wireSha256:original.wireSha256,purchaseFinalized:false});
   }catch{active();return held(request,'SEND_UNCERTAIN',signature);}
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  const work=run().catch(()=>held(request,controller.signal.aborted?'TIMEOUT':'SOURCE_CONFLICT',signature));void work.then(()=>{workDone=true;release();});
  reply=Promise.race([work,new Promise<RealmSaleReconcileResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(held(request,'TIMEOUT',signature));},timeout);})]).finally(()=>{if(timer)clearTimeout(timer);controller.abort();replyDone=true;release();});
  flights.set(key,reply);return reply;
 };
}
function structuredPolicy(s:RealmSaleAdmissionSources):Omit<RealmSaleAdmissionSources,'connect'>{
 const t=s.policy.term,a=s.policy.access,k=(v:PublicKey)=>new PublicKey(v.toBytes());
 return {...(s.timeoutMs===undefined?{}:{timeoutMs:s.timeoutMs}),policy:{revision:s.policy.revision,term:{...t,programId:k(t.programId),config:k(t.config),mint:k(t.mint),prizeOwner:k(t.prizeOwner),prizeAta:k(t.prizeAta),genesisHash:k(t.genesisHash),deployment:{...t.deployment}},access:{...a,programId:k(a.programId),developer:k(a.developer),upgradeAuthority:a.upgradeAuthority===null?null:k(a.upgradeAuthority)}}};
}
