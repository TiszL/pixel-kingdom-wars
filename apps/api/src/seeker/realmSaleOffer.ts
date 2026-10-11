/** Authenticated display observations. No database, signer, relay or receipt
 * writer is accepted here. Real preparation must quote again before consent. */
import {randomBytes} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {createSeekerRealmSaleQuoteReader,SeekerRealmSaleQuoteError,type SeekerRealmSaleQuotePolicy,type SeekerRealmSaleQuoteRpc} from '@shardkeep/chain/seeker-realm-sale-quote';
import {createSeekerRealmAccessSnapshotReader,type SeekerRealmAccessRpc} from '@shardkeep/chain/seeker-realm-access-snapshot';
import {realmAccessPda} from '@shardkeep/chain/seeker-realm-sale';
import {RealmSaleOfferSchema,RealmSaleCoverageSchema,RealmSaleOfferSelectionSchema,RealmSaleCoverageSelectionSchema,type RealmSaleOfferView,type RealmSaleCoverageView} from '@shardkeep/shared/realmSaleOfferApi';
import {phaseESeekerEnabled} from '../config';
import type {RealmSalePreparationSources} from './realmSalePreparation';
// Operational limits only. Expired replies do not free abort-ignoring RPC work.
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000;
export class RealmSaleOfferError extends Error {readonly code='INVALID_INPUT';constructor(){super('Invalid realm sale observation request');}}
function actor(value:string):string{try{if(typeof value!=='string'||value.length<32||value.length>44)throw new Error();const p=new PublicKey(value);if(p.toBase58()!==value||p.equals(PublicKey.default)||!PublicKey.isOnCurve(p.toBytes()))throw new Error();return value;}catch{throw new RealmSaleOfferError();}}
function own(value:unknown,names:readonly string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!names.includes(k)))throw new RealmSaleOfferError();}
function copy(value:SeekerRealmSaleQuotePolicy):SeekerRealmSaleQuotePolicy{
 const t=value.term,a=value.access,k=(p:PublicKey)=>new PublicKey(p.toBytes());
 return Object.freeze({revision:value.revision,term:Object.freeze({...t,programId:k(t.programId),config:k(t.config),mint:k(t.mint),prizeOwner:k(t.prizeOwner),prizeAta:k(t.prizeAta),genesisHash:k(t.genesisHash),deployment:Object.freeze({...t.deployment})}),
  access:Object.freeze({...a,programId:k(a.programId),developer:k(a.developer),upgradeAuthority:a.upgradeAuthority===null?null:k(a.upgradeAuthority)})});
}
export function createRealmSaleOfferReader(sources?:RealmSalePreparationSources|null){
 const connect=sources?.connect,timeout=sources?.timeoutMs??MAX_TIMEOUT_MS,policy=sources?copy(sources.policy):null;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)throw new RealmSaleOfferError();
 if(sources){own(sources,['connect','policy','timeoutMs']);if(typeof connect!=='function')throw new RealmSaleOfferError();createSeekerRealmSaleQuoteReader(connect,policy!);}
 let pending=0;
 async function observe<T>(run:(connect:(signal:AbortSignal)=>SeekerRealmSaleQuoteRpc,signal:AbortSignal)=>Promise<T>):Promise<T|null>{
  if(!connect||!policy||pending>=MAX_PENDING)return null;pending++;
  const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let workDone=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(!released&&workDone&&outstanding.size===0){released=true;pending--;}};
  const trackedConnect=(inner:AbortSignal):SeekerRealmSaleQuoteRpc=>{
   const signal=AbortSignal.any([inner,controller.signal]);signal.throwIfAborted();const rpc=connect(signal);
   const track=<R>(invoke:()=>Promise<R>)=>{if(signal.aborted)return Promise.reject(new Error('Observation expired'));let operation:Promise<R>;try{operation=Promise.resolve(invoke());}catch(error){operation=Promise.reject(error);}
    outstanding.add(operation);const settled=()=>{outstanding.delete(operation);release();};void operation.then(settled,settled);return operation;};
   return {getGenesisHash:()=>track(()=>rpc.getGenesisHash()),getSlot:(...a)=>track(()=>rpc.getSlot(...a)),getMultipleAccountsInfoAndContext:(...a)=>track(()=>rpc.getMultipleAccountsInfoAndContext(...a)),
    getSignaturesForAddress:(...a)=>track(()=>rpc.getSignaturesForAddress(...a)),getTransaction:(...a)=>track(()=>rpc.getTransaction(...a)),
    getBlock:((...a:Parameters<SeekerRealmSaleQuoteRpc['getBlock']>)=>track(()=>rpc.getBlock(...a))) as SeekerRealmSaleQuoteRpc['getBlock'],
    getLatestBlockhashAndContext:(...a)=>track(()=>rpc.getLatestBlockhashAndContext(...a)),getFeeForMessage:(...a)=>track(()=>rpc.getFeeForMessage(...a)),
    getMinimumBalanceForRentExemption:(...a)=>track(()=>rpc.getMinimumBalanceForRentExemption(...a)),getBlockHeight:(...a)=>track(()=>rpc.getBlockHeight(...a))};
  };
  const work=Promise.resolve().then(()=>run(trackedConnect,controller.signal)).catch(()=>null);
  const finished=()=>{workDone=true;controller.abort();release();};void work.then(finished,finished);
  try{return await Promise.race([work,new Promise<null>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},timeout);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
 }
 return {
  async offer(authenticatedWallet:string,value:unknown):Promise<RealmSaleOfferView>{
   const wallet=actor(authenticatedWallet);own(value,['spot','realm']);const parsed=RealmSaleOfferSelectionSchema.safeParse(value);if(!parsed.success)throw new RealmSaleOfferError();const selection=parsed.data;
   const base={version:1 as const,wallet,...selection,authorization:'none' as const},paused=():RealmSaleOfferView=>({...base,status:'blocked',reason:'PAUSED',offer:null});
   if(!phaseESeekerEnabled())return paused();
   const result=await observe(async(tracked,signal):Promise<RealmSaleOfferView>=>{
    try{
     let saleId:Buffer;do{saleId=randomBytes(16);}while(saleId.every(b=>b===0));
     const q=await createSeekerRealmSaleQuoteReader(tracked,policy!,{deadlineMs:timeout})({buyer:new PublicKey(wallet),...selection},{saleId});signal.throwIfAborted();
     if(!phaseESeekerEnabled())return paused();
     const a=q.args,s=q.source,bps=BigInt(PHASE_E_POLICY.basisPoints);
     if(q.buyer!==wallet||q.spot!==selection.spot||q.realm!==selection.realm||q.paymentAuthorized!==false||q.admissionAuthorized!==false)throw new Error('Observation identity differs');
     return RealmSaleOfferSchema.parse({...base,status:'available',reason:null,offer:{source:{revision:s.revision,genesisHash:s.genesisHash,programId:s.programId,reviewedDeploymentSlot:s.reviewedDeploymentSlot,programDataSha256:s.programDataSha256},
      slot:q.quoteSlot,unixTimestamp:q.unixTimestamp.toString(),round:q.round.toString(),day:q.day.toString(),seller:q.seller,developer:q.developer,priorExpiry:q.priorExpiry.toString(),validUntil:q.validUntil.toString(),quotaRemaining:q.quotaRemaining,
      priceLamports:a.priceLamports.toString(),sellerLamports:(a.priceLamports*BigInt(a.sellerBps)/bps).toString(),developerLamports:(a.priceLamports*BigInt(a.developerBps)/bps).toString(),durationSec:Number(a.durationSec),
      feeLamports:q.feeLamports.toString(),rentLamports:q.rentLamports.toString(),paymentDebitLamports:q.paymentDebitLamports.toString(),requiredLamports:q.requiredLamports.toString(),payerLamports:q.payerLamports.toString()}});
    }catch(error){
     signal.throwIfAborted();if(!phaseESeekerEnabled())return paused();
     if(error instanceof SeekerRealmSaleQuoteError&&['PAUSED','UNSOLD','REALM','NO_QUOTA','INSUFFICIENT_SOL'].includes(error.code))return RealmSaleOfferSchema.parse({...base,status:'blocked',reason:error.code,offer:null});throw error;
    }
   });
   if(!phaseESeekerEnabled())return paused();return result??{...base,status:'unavailable',reason:'SOURCE_UNAVAILABLE',offer:null};
  },
  async coverage(authenticatedWallet:string,value:unknown):Promise<RealmSaleCoverageView>{
   const wallet=actor(authenticatedWallet);own(value,['realm']);const parsed=RealmSaleCoverageSelectionSchema.safeParse(value);if(!parsed.success)throw new RealmSaleOfferError();const {realm}=parsed.data;
   const base={version:1 as const,wallet,realm,authorization:'none' as const};
   const result=await observe(async(tracked,signal)=>{
    const read=createSeekerRealmAccessSnapshotReader(inner=>{
     const rpc=tracked(inner);const adapted:SeekerRealmAccessRpc={getGenesisHash:()=>rpc.getGenesisHash(),getSlot:c=>rpc.getSlot(c),getMultipleAccountsInfoAndContext:async(addresses,options)=>{
      const response=await rpc.getMultipleAccountsInfoAndContext(addresses,options);
      if(response.value.length!==addresses.length)throw new Error('Observation account count differs');
      return {context:response.context,value:response.value.map((row,i)=>row===null?null:{address:addresses[i]!,owner:row.owner,executable:row.executable,data:row.data})};
     }};return adapted;
    },policy!.access,{deadlineMs:timeout});
    const snapshot=await read({wallet:new PublicKey(wallet),realm});signal.throwIfAborted();const s=snapshot.source;
    if(snapshot.wallet!==wallet||snapshot.realm!==realm)throw new Error('Observation identity differs');
    return RealmSaleCoverageSchema.parse({...base,status:'observed',coverage:{address:realmAccessPda(policy!.access.programId,new PublicKey(wallet),realm).toBase58(),accountState:snapshot.accessState,
     slot:snapshot.slot,unixTimestamp:snapshot.unixTimestamp.toString(),expiresAt:snapshot.expiresAt?.toString()??null,active:snapshot.active,
     source:{revision:policy!.revision,genesisHash:s.genesisHash,programId:s.programId,reviewedDeploymentSlot:s.reviewedDeploymentSlot,programDataSha256:s.reviewedProgramDataSha256}}});
   });return result??{...base,status:'unavailable',coverage:null};
  },
 };
}
