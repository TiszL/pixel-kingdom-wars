/** Actor-bound unsigned consent preparation. Source reads happen outside locks;
 * immutable recovery precedes new admission. Never signs, submits or settles. */
import {randomBytes} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {createSeekerRealmSaleQuoteReader,SeekerRealmSaleQuoteError,type SeekerRealmSaleQuoteRpc,type SeekerRealmSaleQuotePolicy,type SeekerRealmSaleQuote} from '@shardkeep/chain/seeker-realm-sale-quote';
import {buildRealmSaleMessage} from '@shardkeep/chain/seeker-realm-sale-message';
import type {Db} from '../db/client';
import {phaseESeekerEnabled} from '../config';
import {getRealmSalePreparation,saveRealmSalePreparation,validateRealmSalePreparation,RealmSalePreparationStoreError,type RealmSalePreparation} from './realmSalePreparationStore';
// Operational resource bounds, not game economics. Timed-out work retains its
// entry until the underlying operation settles, including ignored cancellation.
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000;
export type RealmSalePreparationErrorCode='INVALID_INPUT'|'REQUEST_CONFLICT'|'DISABLED'|'BUSY'|'TIMEOUT'|'QUOTE_UNAVAILABLE'|'SOURCE_CONFLICT'|'STORAGE_UNAVAILABLE';
export class RealmSalePreparationError extends Error {
 constructor(readonly code:RealmSalePreparationErrorCode,readonly reason?:SeekerRealmSaleQuoteError['code']){super(`Realm sale preparation refused: ${code}`);this.name='RealmSalePreparationError';}
}
function fail(code:RealmSalePreparationErrorCode):never{throw new RealmSalePreparationError(code);}
const P=PHASE_E_POLICY.seekerIsland;
export const realmSalePreparationRequestSchema=z.object({idempotencyKey:z.uuid().transform(v=>v.toLowerCase()),spot:z.number().int().min(0).max(P.totalSpots-1),realm:z.number().int().min(0).max(P.realmCount-1)}).strict();
export type RealmSalePreparationRequest=z.infer<typeof realmSalePreparationRequestSchema>;
export interface RealmSalePreparationSources {readonly connect:(signal:AbortSignal)=>SeekerRealmSaleQuoteRpc;readonly policy:SeekerRealmSaleQuotePolicy;readonly timeoutMs?:number}
export interface RealmSalePreparationProvider {
 prepare(authenticatedWallet:string,value:unknown):Promise<RealmSalePreparation>;
 get(authenticatedWallet:string,idempotencyKey:string):Promise<RealmSalePreparation|null>;
}
function actor(value:string):string{
 if(typeof value!=='string'||value.length<32||value.length>44)fail('INVALID_INPUT');
 try{const p=new PublicKey(value);if(p.toBase58()!==value||p.equals(PublicKey.default)||!PublicKey.isOnCurve(p.toBytes()))fail('INVALID_INPUT');return value;}catch{fail('INVALID_INPUT');}
}
function own(value:unknown,names:readonly string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!names.includes(k)))fail('INVALID_INPUT');}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function policyCopy(value:SeekerRealmSaleQuotePolicy):SeekerRealmSaleQuotePolicy{
 try{
  const t=value.term,a=value.access,k=(p:PublicKey)=>new PublicKey(p.toBytes());
  return Object.freeze({revision:value.revision,term:Object.freeze({...t,programId:k(t.programId),config:k(t.config),mint:k(t.mint),prizeOwner:k(t.prizeOwner),prizeAta:k(t.prizeAta),genesisHash:k(t.genesisHash),deployment:Object.freeze({...t.deployment})}),
   access:Object.freeze({...a,programId:k(a.programId),developer:k(a.developer),upgradeAuthority:a.upgradeAuthority===null?null:k(a.upgradeAuthority)})});
 }catch{fail('INVALID_INPUT');}
}
function artifact(wallet:string,request:RealmSalePreparationRequest,saleId:Buffer,q:SeekerRealmSaleQuote):RealmSalePreparation{
 try{
  const a=q.args,s=q.source;
  if(q.buyer!==wallet||q.spot!==request.spot||q.realm!==request.realm||a.spot!==request.spot||a.realm!==request.realm||!Buffer.from(a.saleId).equals(saleId)
   ||q.paymentAuthorized!==false||q.admissionAuthorized!==false||q.quoteSlot!==s.admissionSlot)fail('SOURCE_CONFLICT');
  const plan=buildRealmSaleMessage(new PublicKey(s.programId),{wallet:new PublicKey(wallet),args:a,blockhash:q.blockhash,needsAccess:!q.accessExists,needsQuota:!q.quotaExists});
  if(!Buffer.from(q.messageBytes).equals(Buffer.from(plan.messageBytes))||q.messageSha256!==plan.messageSha256||q.packetBytes!==plan.packetBytes||q.paymentDebitLamports!==plan.buyerNetPaymentLamports)fail('SOURCE_CONFLICT');
  // Quote observation order is not instruction creation order. Match each
  // canonical address before storing the builder's exact expected account order.
  const rentByAddress=new Map(q.rents.map(r=>[r.address,r]));if(rentByAddress.size!==q.rents.length||rentByAddress.size!==plan.expectedNewAccounts.length)fail('SOURCE_CONFLICT');
  const rents=plan.expectedNewAccounts.map(expected=>{const r=rentByAddress.get(expected.address);if(!r||r.bytes!==expected.space)fail('SOURCE_CONFLICT');
   return {address:r.address,space:expected.space,minimumBalanceLamports:r.minimumBalanceLamports.toString(),existingLamports:r.existingLamports.toString(),maxIncreaseLamports:r.lamports.toString()};});
  return validateRealmSalePreparation({version:1,wallet,idempotencyKey:request.idempotencyKey,saleId:saleId.toString('hex'),spot:request.spot,realm:request.realm,
   terms:{round:a.round.toString(),day:a.day.toString(),seller:a.seller.toBase58(),developer:a.developer.toBase58(),priorExpiry:a.priorExpiry.toString(),validAfter:a.validAfter.toString(),validUntil:a.validUntil.toString()},
   source:{revision:s.revision,genesisHash:s.genesisHash,programId:s.programId,programDataSha256:s.programDataSha256,reviewedDeploymentSlot:s.reviewedDeploymentSlot,
    termProofHash:s.termProofHash,snapshotHash:s.snapshotHash,termSlot:s.termSlot,initialSlot:s.initialSlot,blockhashSlot:s.blockhashSlot,feeSlot:s.feeSlot,costSlot:s.costSlot,admissionSlot:s.admissionSlot},
   quote:{blockhash:q.blockhash,lastValidBlockHeight:q.lastValidBlockHeight,unixTimestamp:q.unixTimestamp.toString(),needsAccess:!q.accessExists,needsQuota:!q.quotaExists,quotaRemaining:q.quotaRemaining,
    messageHex:Buffer.from(plan.messageBytes).toString('hex'),messageSha256:plan.messageSha256,packetBytes:plan.packetBytes,rents,feeLamports:q.feeLamports.toString(),rentLamports:q.rentLamports.toString(),
    paymentDebitLamports:q.paymentDebitLamports.toString(),requiredLamports:q.requiredLamports.toString(),payerLamports:q.payerLamports.toString()},
   state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false});
 }catch(error){if(error instanceof RealmSalePreparationError)throw error;fail('SOURCE_CONFLICT');}
}
export function createRealmSalePreparer(db:Db,sources:RealmSalePreparationSources):RealmSalePreparationProvider{
 own(sources,['connect','policy','timeoutMs']);if(typeof sources.connect!=='function')fail('INVALID_INPUT');const connect=sources.connect,policy=policyCopy(sources.policy),timeout=sources.timeoutMs??MAX_TIMEOUT_MS;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)fail('INVALID_INPUT');
 // Eagerly validate server-owned trust. Each request binds a fresh abort scope to
 // this same copied policy; request JSON can never substitute source authority.
 try{createSeekerRealmSaleQuoteReader(connect,policy);}catch{fail('INVALID_INPUT');}
 const pending=new Map<string,{spot:number;realm:number;reply:Promise<RealmSalePreparation>}>();
 const match=(saved:RealmSalePreparation,r:RealmSalePreparationRequest)=>{if(saved.spot!==r.spot||saved.realm!==r.realm)fail('REQUEST_CONFLICT');return freeze(saved);};
 async function prepareNew(wallet:string,request:RealmSalePreparationRequest,signal:AbortSignal,trackedConnect:(signal:AbortSignal)=>SeekerRealmSaleQuoteRpc){
  const alive=()=>{if(signal.aborted)fail('TIMEOUT');},admitted=()=>{alive();if(!phaseESeekerEnabled())fail('DISABLED');};
  const lookup={wallet,idempotencyKey:request.idempotencyKey},prior=await getRealmSalePreparation(db,lookup);alive();if(prior)return match(prior,request);
  admitted();let saleId:Buffer;do{saleId=randomBytes(16);}while(saleId.every(v=>v===0));
  const read=createSeekerRealmSaleQuoteReader(inner=>trackedConnect(AbortSignal.any([inner,signal])),policy,{deadlineMs:timeout});
  const q=await read({buyer:new PublicKey(wallet),spot:request.spot,realm:request.realm},{saleId});admitted();
  const value=artifact(wallet,request,saleId,q);admitted();
  // No chain RPC in this transaction. Repeated checks also roll back INSERT if
  // timeout/pause occurs while a store lookup or SQL write is awaited. A lost
  // commit response remains recoverable by the original immutable actor/key.
  return db.transaction(async tx=>{
   const saved=await getRealmSalePreparation(tx,lookup);alive();if(saved)return match(saved,request);admitted();
   const result=await saveRealmSalePreparation(tx,value);admitted();return match(result,request);
  });
 }
 return {
  async prepare(authenticatedWallet,value){
   const wallet=actor(authenticatedWallet);own(value,['idempotencyKey','spot','realm']);const parsed=realmSalePreparationRequestSchema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');const request=parsed.data;
   const key=`${wallet}:${request.idempotencyKey}`,existing=pending.get(key);if(existing){if(existing.spot!==request.spot||existing.realm!==request.realm)fail('REQUEST_CONFLICT');return existing.reply;}
   if(pending.size>=MAX_PENDING)fail('BUSY');const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   // A nested reader may stop waiting before an abort-ignoring transport stops.
   // Retain capacity until every concrete RPC promise settles; wrapping only the
   // outer quote would permit unlimited abandoned network work after deadlines.
   const outstanding=new Set<Promise<unknown>>();let workDone=false;
   let release=()=>{};
   const trackedConnect=(signal:AbortSignal):SeekerRealmSaleQuoteRpc=>{
    signal.throwIfAborted();const rpc=connect(signal);
    const track=<T>(invoke:()=>Promise<T>):Promise<T>=>{
     if(signal.aborted)return Promise.reject(new RealmSalePreparationError('TIMEOUT'));
     let operation:Promise<T>;try{operation=Promise.resolve(invoke());}catch(error){operation=Promise.reject(error);}
     outstanding.add(operation);const settled=()=>{outstanding.delete(operation);release();};void operation.then(settled,settled);return operation;
    };
    return {getGenesisHash:()=>track(()=>rpc.getGenesisHash()),getSlot:(...a)=>track(()=>rpc.getSlot(...a)),
     getMultipleAccountsInfoAndContext:(...a)=>track(()=>rpc.getMultipleAccountsInfoAndContext(...a)),
     getSignaturesForAddress:(...a)=>track(()=>rpc.getSignaturesForAddress(...a)),getTransaction:(...a)=>track(()=>rpc.getTransaction(...a)),
     getBlock:((...a:Parameters<SeekerRealmSaleQuoteRpc['getBlock']>)=>track(()=>rpc.getBlock(...a))) as SeekerRealmSaleQuoteRpc['getBlock'],
     getLatestBlockhashAndContext:(...a)=>track(()=>rpc.getLatestBlockhashAndContext(...a)),getFeeForMessage:(...a)=>track(()=>rpc.getFeeForMessage(...a)),
     getMinimumBalanceForRentExemption:(...a)=>track(()=>rpc.getMinimumBalanceForRentExemption(...a)),getBlockHeight:(...a)=>track(()=>rpc.getBlockHeight(...a))};
   };
   const work=prepareNew(wallet,request,controller.signal,trackedConnect).catch(error=>{
    if(error instanceof RealmSalePreparationError)throw error;
    if(error instanceof SeekerRealmSaleQuoteError)throw new RealmSalePreparationError(controller.signal.aborted?'TIMEOUT':'QUOTE_UNAVAILABLE',error.code);
    if(error instanceof RealmSalePreparationStoreError)fail(error.code==='REQUEST_CONFLICT'?'REQUEST_CONFLICT':'SOURCE_CONFLICT');fail('STORAGE_UNAVAILABLE');
   });
   const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RealmSalePreparationError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
   const entry={spot:request.spot,realm:request.realm,reply};pending.set(key,entry);
   release=()=>{if(workDone&&outstanding.size===0&&pending.get(key)===entry)pending.delete(key);};
   const finished=()=>{workDone=true;controller.abort();release();};void work.then(finished,finished);return reply;
  },
  async get(authenticatedWallet,idempotencyKey){const wallet=actor(authenticatedWallet),parsed=z.uuid().safeParse(idempotencyKey);if(!parsed.success)fail('INVALID_INPUT');
   try{const found=await getRealmSalePreparation(db,{wallet,idempotencyKey:parsed.data.toLowerCase()});return found?freeze(found):null;}
   catch(error){if(error instanceof RealmSalePreparationStoreError)fail('SOURCE_CONFLICT');throw error;}
  },
 };
}
