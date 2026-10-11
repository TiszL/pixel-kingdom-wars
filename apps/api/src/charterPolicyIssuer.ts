/** D153.166: independent current-chain policy, API-owned original entitlement.
 * Dedicated local signing capability only; no Db, wallet transaction or relay. */
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_PREPARATION,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {createCharterAdmissionReader} from '@shardkeep/chain/charter-admission';
import type {CharterCreationEvidenceRpc,CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import {decodeSeekerActionPermit,hashOpenSeekerAuctionPayload} from '@shardkeep/chain/seeker-auction-protocol';
import {SeekerWithdrawPrepareRequestSchema} from '@shardkeep/shared/seekerAuctionApi';
import {readSeekerAuctionPrivateRound,seekerAuctionTermsFromRead,type SeekerAuctionReadSource} from './seeker/auctionReadModel';
import {charterIssuerReceipt,charterIssuerRequestId,copyCharterIssuerAttempt,copyCharterIssuerDomain,issuerNeed,openCharterIssuerJournal,
 type CharterIssuerKind,type CharterIssuerReceipt,CharterIssuerError} from './charterPolicyIssuerJournal';
export type {CharterIssuerReceipt} from './charterPolicyIssuerJournal';
export interface CharterPolicyIssueRequest {readonly kind:CharterIssuerKind;readonly requestId:string;readonly message:Uint8Array;
 readonly auction?:Readonly<{round:string;spot:number}>|undefined}
export interface CharterPolicyIssuerOptions {
 readonly journalFile:string;
 readonly trust:CharterCreationEvidenceTrust;
 readonly connect:(signal:AbortSignal)=>CharterCreationEvidenceRpc;
 /** A dedicated in-process capability. It signs synchronously and never sends. */
 readonly signer:Readonly<{publicKey:string;sign:(message:Uint8Array)=>Uint8Array}>;
 readonly timeoutMs?:number;readonly monotonicNow?:()=>number;
 /** Independent issuer-owned trust and crank identity. Absent closes kind 7. */
 readonly seekerAuction?:Readonly<{source:SeekerAuctionReadSource;crankPublicKey:string}>;
}
const originalRequest=z.object({kind:z.enum(['charter-registration-v1','charter-transfer-v1','charter-lock-v1','charter-retirement-v1']),requestId:z.string(),message:z.instanceof(Uint8Array).refine(v=>v.byteLength===161)}).strict();
const requestSchema=z.union([originalRequest,originalRequest.extend({kind:z.literal('seeker-auction-open-v1'),auction:SeekerWithdrawPrepareRequestSchema}).strict()]);
/** The key and read provider are issuer-owned, never supplied in a request.
 * Constructing this core does not mount it or activate any deployment pin. */
export async function createCharterPolicyIssuer(options:CharterPolicyIssuerOptions){
 const trust=structuredClone(options.trust),connect=options.connect,sign=options.signer.sign.bind(options.signer),publicKey=options.signer.publicKey;
 issuerNeed(typeof connect==='function'&&typeof sign==='function','CONFIGURATION');
 const key=new PublicKey(publicKey);issuerNeed(key.toBase58()===publicKey&&!key.equals(PublicKey.default),'CONFIGURATION');
 const domain=copyCharterIssuerDomain({genesisHash:trust.expectedGenesisHash,economyProgram:trust.economy.programId});
 const seekerAuction=options.seekerAuction?{crankPublicKey:options.seekerAuction.crankPublicKey,
  source:{trust:structuredClone(options.seekerAuction.source.trust),connect:options.seekerAuction.source.connect}}:undefined;
 if(seekerAuction){const crank=new PublicKey(seekerAuction.crankPublicKey);issuerNeed(crank.toBase58()===seekerAuction.crankPublicKey&&PublicKey.isOnCurve(crank.toBytes())
  &&seekerAuction.source.trust.programId===domain.economyProgram&&seekerAuction.source.trust.genesisHash===domain.genesisHash,'CONFIGURATION');}
 const now=options.monotonicNow??(()=>performance.now()),timeout=options.timeoutMs??PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs;
 issuerNeed(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs,'CONFIGURATION');
 // Validate captured reviewed trust without any network I/O.
 createCharterAdmissionReader(connect,trust,publicKey,{deadlineMs:timeout});
 const journal=await openCharterIssuerJournal(options.journalFile,domain),lifetime=new AbortController();let pending=0;
 async function run<T>(outer:AbortSignal,operation:(active:()=>void,signal:AbortSignal,track:<V>(call:()=>Promise<V>)=>Promise<V>)=>Promise<T>):Promise<T>{
  issuerNeed(!lifetime.signal.aborted&&!outer.aborted,'ABORTED');issuerNeed(pending<PHASE_E_CHARTER_PREPARATION.maxPending,'BUSY');
  const started=now();issuerNeed(Number.isFinite(started)&&started>=0,'STALE');let previous=started;
  const controller=new AbortController(),signal=AbortSignal.any([outer,lifetime.signal,controller.signal]);pending++;
  let outstanding=0,done=false,released=false;
  const release=()=>{if(done&&outstanding===0&&!released){released=true;pending--;}};
  const active=()=>{issuerNeed(!signal.aborted,'ABORTED');const sample=now();issuerNeed(Number.isFinite(sample)&&sample>=previous&&sample-started<=PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs,'STALE');previous=sample;};
  async function track<V>(call:()=>Promise<V>){active();outstanding++;try{const value=await call();active();return value;}finally{outstanding--;release();}}
  let abort!:()=>void;const interrupted=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new CharterIssuerError('ABORTED'));signal.addEventListener('abort',abort,{once:true});});
  const timer=setTimeout(()=>controller.abort(),timeout),work=Promise.resolve().then(()=>{active();return operation(active,signal,track);});
  void work.then(()=>{done=true;release();},()=>{done=true;release();});
  try{return await Promise.race([work,interrupted]);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
 }
 async function issueOnce(input:CharterPolicyIssueRequest,signal:AbortSignal):Promise<CharterIssuerReceipt>{
  const request=requestSchema.parse(input),requestId=charterIssuerRequestId(request.requestId);
  const parsed=copyCharterIssuerAttempt({requestId,kind:request.kind,messageHex:Buffer.from(request.message).toString('hex'),publicKey,
   ...('auction'in request?{auction:request.auction}:{})},domain);
  return run(signal,async(active,ownSignal,track)=>{
   // Request/body deduplication precedes fresh policy. Historical receipts retain
   // their original signer across rotation and never cause another signature.
   const prior=await journal.read(requestId);active();
   if(prior){issuerNeed(prior.attempt.kind===parsed.attempt.kind&&prior.attempt.messageHex===parsed.attempt.messageHex
    &&prior.attempt.auction?.round===parsed.attempt.auction?.round&&prior.attempt.auction?.spot===parsed.attempt.auction?.spot,'CONFLICT');const receipt=charterIssuerReceipt(prior);issuerNeed(receipt,'PENDING');return receipt;}
   // Fresh disabled or locally invalid kind-7 requests must not consume journal capacity.
   // Existing completed/pending/conflicting requests retain their priority above.
   if(request.kind==='seeker-auction-open-v1'){
    issuerNeed(seekerAuction,'PURPOSE');
    const permit=decodeSeekerActionPermit(Buffer.from(parsed.attempt.messageHex,'hex'));
    issuerNeed(permit.kind===7&&permit.wallet.toBase58()===seekerAuction.crankPublicKey,'PURPOSE');
   }
   const committed=await journal.begin(parsed.attempt);active();
   if(!committed.inserted){const receipt=charterIssuerReceipt(committed.entry);issuerNeed(receipt,'PENDING');return receipt;}
   let unixTimestamp:bigint;
   if(request.kind==='seeker-auction-open-v1'){
    issuerNeed(seekerAuction,'PURPOSE');const target=parsed.attempt.auction!;
    const permit=decodeSeekerActionPermit(Buffer.from(parsed.attempt.messageHex,'hex'));
    issuerNeed(permit.kind===7&&permit.wallet.toBase58()===seekerAuction.crankPublicKey,'PURPOSE');
    const ownSource:SeekerAuctionReadSource={trust:seekerAuction.source.trust,connect:signal=>{
     const rpc=seekerAuction.source.connect(AbortSignal.any([ownSignal,signal]));return {
      getGenesisHash:()=>track(()=>rpc.getGenesisHash()),getMultipleAccountsInfoAndContext:(addresses,settings)=>track(()=>rpc.getMultipleAccountsInfoAndContext(addresses,settings))};}};
    const observed=await readSeekerAuctionPrivateRound(ownSource,seekerAuction.crankPublicKey,BigInt(target.round),ownSignal);active();
    issuerNeed(observed.term&&!observed.authority.admissionPaused&&observed.authority.currentPolicyKey===publicKey,'POLICY');
    issuerNeed(observed.nowSec<observed.term.auctionStart&&observed.auctions[target.spot]===null,'AUCTION_OPEN');
    issuerNeed(Buffer.from(permit.payloadHash).equals(hashOpenSeekerAuctionPayload(seekerAuctionTermsFromRead(observed,target.spot))),'PAYLOAD');
    unixTimestamp=observed.nowSec;
   }else{
    const read=createCharterAdmissionReader(internalSignal=>{
    const rpc=connect(AbortSignal.any([ownSignal,internalSignal]));
    return {getGenesisHash:()=>track(()=>rpc.getGenesisHash()),getSlot:commitment=>track(()=>rpc.getSlot(commitment)),
     getMultipleAccountsInfoAndContext:(addresses,settings)=>track(()=>rpc.getMultipleAccountsInfoAndContext(addresses,settings))};
   },trust,publicKey,{deadlineMs:timeout});
    const observation=await read();active();unixTimestamp=observation.unixTimestamp;
   }
   issuerNeed(parsed.expiry>unixTimestamp&&parsed.expiry-unixTimestamp<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),'EXPIRY');
   // No await between final age/abort check and dedicated synchronous signing.
   const signature=sign(Buffer.from(parsed.attempt.messageHex,'hex'));active();
   issuerNeed(signature instanceof Uint8Array&&signature.byteLength===64,'SIGNATURE');
   const signatureHex=Buffer.from(signature).toString('hex');charterIssuerReceipt({attempt:parsed.attempt,signatureHex});
   const receipt=await journal.complete(requestId,signatureHex);active();return receipt;
  });
 }
 async function lookup(id:string,signal:AbortSignal):Promise<CharterIssuerReceipt|null>{
  const requestId=charterIssuerRequestId(id);return run(signal,async active=>{const entry=await journal.read(requestId);active();return entry?charterIssuerReceipt(entry):null;});
 }
 return Object.freeze({issueOnce,lookup,close:async()=>{lifetime.abort();await journal.close();}});
}
