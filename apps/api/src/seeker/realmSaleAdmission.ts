/** Fresh measured admission facts for one ORIGINAL immutable consent packet.
 * No reservation, signing, relay, payment or replacement consent authority.
 * The program's pause/day/term/quota/coverage CAS remains authoritative at execution. */
import {Message,PublicKey} from '@solana/web3.js';
import {createSeekerRealmSaleQuoteReader,SeekerRealmSaleQuoteError,type SeekerRealmSaleQuoteRpc,type SeekerRealmSaleQuotePolicy} from '@shardkeep/chain/seeker-realm-sale-quote';
import {phaseESeekerEnabled} from '../config';
import {validateRealmSalePreparation,realmSalePreparationArgs,type RealmSalePreparation} from './realmSalePreparationStore';
// Operational transport bounds; no game policy or economic defaults here.
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000;
export type RealmSaleAdmissionErrorCode='INVALID_INPUT'|'INVALID_PREPARATION'|'DISABLED'|'BUSY'|'TIMEOUT'|'QUOTE_UNAVAILABLE'|'RECOVERY_REQUIRED'|'CONSENT_CHANGED'|'COST_EXCEEDED'|'BLOCKHASH_EXPIRED'|'SOURCE_UNAVAILABLE';
export class RealmSaleAdmissionError extends Error{constructor(readonly code:RealmSaleAdmissionErrorCode,readonly reason?:SeekerRealmSaleQuoteError['code']){super(`Realm sale admission held: ${code}`);this.name='RealmSaleAdmissionError';}}
function fail(code:RealmSaleAdmissionErrorCode):never{throw new RealmSaleAdmissionError(code);}
function need(value:unknown,code:RealmSaleAdmissionErrorCode):asserts value{if(!value)fail(code);}
function safe(value:unknown):number{need(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0,'SOURCE_UNAVAILABLE');return value;}
function policyCopy(value:SeekerRealmSaleQuotePolicy):SeekerRealmSaleQuotePolicy{
 try{const t=value.term,a=value.access,k=(p:PublicKey)=>new PublicKey(p.toBytes());return Object.freeze({revision:value.revision,
  term:Object.freeze({...t,programId:k(t.programId),config:k(t.config),mint:k(t.mint),prizeOwner:k(t.prizeOwner),prizeAta:k(t.prizeAta),genesisHash:k(t.genesisHash),deployment:Object.freeze({...t.deployment})}),
  access:Object.freeze({...a,programId:k(a.programId),developer:k(a.developer),upgradeAuthority:a.upgradeAuthority===null?null:k(a.upgradeAuthority)})});}catch{fail('INVALID_INPUT');}
}
export interface RealmSaleAdmissionSources{readonly connect:(signal:AbortSignal)=>SeekerRealmSaleQuoteRpc;readonly policy:SeekerRealmSaleQuotePolicy;readonly timeoutMs?:number}
export interface RealmSaleAdmission{
 readonly version:1;readonly saleId:string;readonly wallet:string;readonly messageSha256:string;readonly sourceRevision:string;readonly snapshotHash:string;
 readonly quoteSlot:number;readonly unixTimestamp:bigint;readonly feeSlot:number;readonly bracketSlot:number;readonly blockHeight:number;
 readonly feeLamports:bigint;readonly rentLamports:bigint;readonly paymentDebitLamports:bigint;readonly requiredLamports:bigint;readonly payerLamports:bigint;readonly quotaRemaining:number;
 readonly rents:readonly Readonly<{address:string;lamports:bigint}>[];
 readonly admissionEligible:true;readonly signingAuthorized:false;readonly paymentAuthorized:false;readonly submissionAuthorized:false;readonly reservation:false;
}
export type RealmSaleAdmissionReader=(saved:RealmSalePreparation)=>Promise<RealmSaleAdmission>;
export function createRealmSaleAdmissionReader(sources:RealmSaleAdmissionSources):RealmSaleAdmissionReader{
 need(sources&&typeof sources==='object'&&!Array.isArray(sources)&&Reflect.ownKeys(sources).every(k=>['connect','policy','timeoutMs'].includes(k as string))&&typeof sources.connect==='function','INVALID_INPUT');
 const connect=sources.connect,policy=policyCopy(sources.policy),timeout=sources.timeoutMs??MAX_TIMEOUT_MS;need(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=MAX_TIMEOUT_MS,'INVALID_INPUT');
 try{createSeekerRealmSaleQuoteReader(connect,policy,{deadlineMs:timeout});}catch{fail('INVALID_INPUT');}
 let pending=0;
 return async input=>{
  // Parser reconstructs the exact reviewed message and owns nested copies before
  // the first await. Neither caller mutation nor JSON can invent source trust.
  let saved:RealmSalePreparation;try{saved=validateRealmSalePreparation(input);}catch{fail('INVALID_PREPARATION');}
  const old=saved.source,original=realmSalePreparationArgs(saved),originalMessage=Buffer.from(saved.quote.messageHex,'hex');
  need(old.revision===policy.revision&&old.programId===policy.term.programId.toBase58()&&old.genesisHash===policy.term.genesisHash.toBase58()
   &&old.programDataSha256===policy.access.reviewedProgramDataSha256&&old.reviewedDeploymentSlot===policy.access.reviewedDeploymentSlot
   &&original.round===policy.term.round&&original.developer.equals(policy.access.developer),'CONSENT_CHANGED');
  if(!phaseESeekerEnabled())fail('DISABLED');if(pending>=MAX_PENDING)fail('BUSY');pending++;
  const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let workDone=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(workDone&&!released&&outstanding.size===0){released=true;pending--;}};
  const check=()=>{if(controller.signal.aborted)fail('TIMEOUT');if(!phaseESeekerEnabled())fail('DISABLED');};
  const trackedConnect=(inner:AbortSignal):SeekerRealmSaleQuoteRpc=>{
   const signal=AbortSignal.any([inner,controller.signal]);signal.throwIfAborted();const rpc=connect(signal);
   const track=<T>(invoke:()=>Promise<T>):Promise<T>=>{if(signal.aborted)return Promise.reject(new RealmSaleAdmissionError('TIMEOUT'));
    let operation:Promise<T>;try{operation=Promise.resolve(invoke());}catch(error){operation=Promise.reject(error);}outstanding.add(operation);
    const settled=()=>{outstanding.delete(operation);release();};void operation.then(settled,settled);return operation;};
   return {getGenesisHash:()=>track(()=>rpc.getGenesisHash()),getSlot:(...a)=>track(()=>rpc.getSlot(...a)),
    getMultipleAccountsInfoAndContext:(...a)=>track(()=>rpc.getMultipleAccountsInfoAndContext(...a)),getSignaturesForAddress:(...a)=>track(()=>rpc.getSignaturesForAddress(...a)),
    getTransaction:(...a)=>track(()=>rpc.getTransaction(...a)),getBlock:((...a:Parameters<SeekerRealmSaleQuoteRpc['getBlock']>)=>track(()=>rpc.getBlock(...a))) as SeekerRealmSaleQuoteRpc['getBlock'],
    getLatestBlockhashAndContext:(...a)=>track(()=>rpc.getLatestBlockhashAndContext(...a)),getFeeForMessage:(...a)=>track(()=>rpc.getFeeForMessage(...a)),
    getMinimumBalanceForRentExemption:(...a)=>track(()=>rpc.getMinimumBalanceForRentExemption(...a)),getBlockHeight:(...a)=>track(()=>rpc.getBlockHeight(...a))};
  };
  const work=(async():Promise<RealmSaleAdmission>=>{
   check();const q=await createSeekerRealmSaleQuoteReader(trackedConnect,policy,{deadlineMs:timeout})({buyer:new PublicKey(saved.wallet),spot:saved.spot,realm:saved.realm},{saleId:original.saleId});check();
   const a=q.args,s=q.source;
   need(['revision','programId','genesisHash','programDataSha256','reviewedDeploymentSlot','termProofHash'].every(k=>s[k as keyof typeof s]===old[k as keyof typeof old])
    &&q.quoteSlot>=old.admissionSlot&&q.quoteSlot===s.admissionSlot&&q.buyer===saved.wallet&&q.spot===saved.spot&&q.realm===saved.realm,'CONSENT_CHANGED');
   need(Buffer.from(a.saleId).equals(Buffer.from(original.saleId))&&a.seller.equals(original.seller)&&a.developer.equals(original.developer)
    &&(['version','spot','realm','round','day','registryVersion','priceLamports','durationSec','sellerBps','developerBps','priorExpiry'] as const).every(k=>a[k]===original[k])
    &&q.unixTimestamp>=original.validAfter&&q.unixTimestamp<=original.validUntil&&!q.accessExists===saved.quote.needsAccess&&!q.quotaExists===saved.quote.needsQuota
    &&q.paymentAuthorized===false&&q.admissionAuthorized===false,'CONSENT_CHANGED');
   const caps=new Map(saved.quote.rents.map(r=>[r.address,r]));need(caps.size===q.rents.length,'CONSENT_CHANGED');
   for(const r of q.rents){const cap=caps.get(r.address);need(cap&&cap.space===r.bytes,'CONSENT_CHANGED');need(r.lamports<=BigInt(cap.maxIncreaseLamports),'COST_EXCEEDED');}
   need(q.feeLamports<=BigInt(saved.quote.feeLamports)&&q.rentLamports<=BigInt(saved.quote.rentLamports)&&q.paymentDebitLamports===BigInt(saved.quote.paymentDebitLamports),'COST_EXCEEDED');
   // The refreshed quote is solely a measurement. Check the ORIGINAL legacy
   // message's fee/blockhash; never replace its blockhash, args or instructions.
   const rpc=trackedConnect(controller.signal);need(await rpc.getGenesisHash()===old.genesisHash,'SOURCE_UNAVAILABLE');check();
   const before=safe(await rpc.getSlot('finalized'));check();need(before>=q.quoteSlot,'SOURCE_UNAVAILABLE');
   const fee=await rpc.getFeeForMessage(Message.from(originalMessage),'finalized');check();const feeSlot=safe(fee.context.slot),feeLamports=BigInt(safe(fee.value));need(feeSlot>=before,'SOURCE_UNAVAILABLE');need(feeLamports<=BigInt(saved.quote.feeLamports),'COST_EXCEEDED');
   const blockHeight=safe(await rpc.getBlockHeight({commitment:'finalized',minContextSlot:feeSlot}));check();need(blockHeight<=saved.quote.lastValidBlockHeight,'BLOCKHASH_EXPIRED');
   const bracketSlot=safe(await rpc.getSlot('finalized'));check();need(bracketSlot>=feeSlot,'SOURCE_UNAVAILABLE');need(await rpc.getGenesisHash()===old.genesisHash,'SOURCE_UNAVAILABLE');check();
   const requiredLamports=q.paymentDebitLamports+q.rentLamports+feeLamports;need(requiredLamports<=BigInt(saved.quote.requiredLamports),'COST_EXCEEDED');
   if(q.payerLamports<requiredLamports)throw new RealmSaleAdmissionError('QUOTE_UNAVAILABLE','INSUFFICIENT_SOL');
   // These are explicitly observed facts, not a transaction reservation. A
   // later authority/quota/access change is still refused by the original wire.
   return Object.freeze({version:1,saleId:saved.saleId,wallet:saved.wallet,messageSha256:saved.quote.messageSha256,sourceRevision:s.revision,snapshotHash:s.snapshotHash,
    quoteSlot:q.quoteSlot,unixTimestamp:q.unixTimestamp,feeSlot,bracketSlot,blockHeight,feeLamports,rentLamports:q.rentLamports,paymentDebitLamports:q.paymentDebitLamports,requiredLamports,payerLamports:q.payerLamports,quotaRemaining:q.quotaRemaining,
    rents:Object.freeze(q.rents.map(r=>Object.freeze({address:r.address,lamports:r.lamports}))),admissionEligible:true,signingAuthorized:false,paymentAuthorized:false,submissionAuthorized:false,reservation:false});
  })().catch(error=>{if(error instanceof RealmSaleAdmissionError)throw error;if(controller.signal.aborted)fail('TIMEOUT');if(error instanceof SeekerRealmSaleQuoteError)throw new RealmSaleAdmissionError(error.code==='ALREADY_RECORDED'?'RECOVERY_REQUIRED':error.code==='DEADLINE'?'TIMEOUT':'QUOTE_UNAVAILABLE',error.code);fail('SOURCE_UNAVAILABLE');});
  const done=()=>{workDone=true;controller.abort();release();};void work.then(done,done);
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RealmSaleAdmissionError('TIMEOUT'));},timeout);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
 };
}
