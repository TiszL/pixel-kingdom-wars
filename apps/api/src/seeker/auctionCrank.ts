/** Chain-state-driven SA-3 core. The existing worker owns scheduling, lifecycle,
 * the default-off gate and key-file loading. One pass submits at most one
 * canonical transaction; this module creates no runner, journal or connection.
 * Pending signatures survive every ambiguous response in this instance. A new
 * instance resumes landed chain bitmaps, without an exactly-once promise across
 * process loss. Nothing here changes the public reader's round horizon.
 */
import { createPublicKey,verify } from 'node:crypto';
import { z } from 'zod';
import bs58 from 'bs58';
import { Keypair,Message,PACKET_DATA_SIZE,PublicKey,TransactionMessage,VersionedTransaction,
 type SignatureStatus,type TransactionInstruction } from '@solana/web3.js';
import { PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { buildOpenTermIx,buildOpenAuctionTx,buildSettleIx } from '@shardkeep/chain/seeker-auction-instructions';
import { encodeSeekerActionPermit,hashOpenSeekerAuctionPayload,type SeekerActionPermit } from '@shardkeep/chain/seeker-auction-protocol';
import type { createCharterPolicyIssuerClient } from '../charterPolicyIssuerClient';
import type { CharterIssuerReceipt } from '../charterPolicyIssuerJournal';
import { readSeekerAuctionRound,readSeekerAuctionPrivateRound,seekerAuctionTermsFromRead,
 type SeekerAuctionReadRpc,type SeekerAuctionReadSource,type SeekerAuctionReadResult } from './auctionReadModel';

const A=PHASE_E_SEEKER_AUCTION,R=PHASE_E_SEEKER_AUCTION_RUNTIME;
const U64_MAX=(1n<<64n)-1n,I64_MAX=(1n<<63n)-1n;
// Operational deadline, not auction calendar or economic policy. Ignored aborts
// retain the re-entry guard until the outstanding call actually settles.
const PASS_DEADLINE_MS=30_000;
const requestIdSchema=z.uuid().refine(value=>value===value.toLowerCase());

export interface SeekerAuctionCrankRpc extends SeekerAuctionReadRpc {
 getLatestBlockhashAndContext(options:{commitment:'finalized';minContextSlot:number}):Promise<{
  context:{slot:number};value:{blockhash:string;lastValidBlockHeight:number};
 }>;
 getEpochInfo(options:{commitment:'finalized';minContextSlot:number}):Promise<{absoluteSlot:number;blockHeight?:number}>;
 getSignatureStatuses(signatures:string[],options:{searchTransactionHistory:true}):Promise<{
  context:{slot:number};value:readonly(SignatureStatus|null)[];
 }>;
 sendRawTransaction(wire:Uint8Array,options:{maxRetries:0;preflightCommitment:'finalized';minContextSlot:number}):Promise<string>;
}
export interface SeekerAuctionCrankSource extends SeekerAuctionReadSource {
 readonly connect:(signal:AbortSignal)=>SeekerAuctionCrankRpc;
}
export type SeekerAuctionCrankAction =
 | Readonly<{kind:'open-term';round:string}>
 | Readonly<{kind:'open-auction';round:string;spot:number}>
 | Readonly<{kind:'settle';round:string;spots:readonly number[]}>;
export interface SeekerAuctionCrankAlarm {
 readonly code:'OPEN_DEADLINE'|'OPEN_WINDOW_MISSED'|'POLICY_KEY_MISMATCH'|'ISSUER_REFUSED';readonly round:string;
 readonly spots:readonly number[];readonly auctionStart:string;
}
export type SeekerAuctionCrankEvent =
 | Readonly<{type:'alarm';alarm:SeekerAuctionCrankAlarm}>
 | Readonly<{type:'pending'|'submitted'|'finalized'|'failed'|'expired';signature:string;action:SeekerAuctionCrankAction}>;
export interface SeekerAuctionCrankOptions {
 readonly source:SeekerAuctionCrankSource;readonly crankPublicKey:string;readonly dryRun:boolean;
 /** Independent configured issuer identity. Only read-only previews may omit it. */
 readonly issuerPublicKey?:string;
 /** Worker-owned capability, called only for a proved action in a live pass. */
 readonly loadSigner:(signal:AbortSignal)=>Promise<Keypair>;
 readonly issuer:Pick<ReturnType<typeof createCharterPolicyIssuerClient>,'issueOnce'>;
 /** Worker supplies a fresh canonical UUID per issuance attempt. */
 readonly nextRequestId:()=>string;
 readonly onEvent?:(event:SeekerAuctionCrankEvent)=>void;
}
export interface SeekerAuctionCrankResult {
 readonly status:'idle'|'held'|'dry-run'|'busy'|'pending'|'submitted'|'finalized'|'failed';
 readonly actions:readonly SeekerAuctionCrankAction[];readonly alarms:readonly SeekerAuctionCrankAlarm[];
 readonly signature:string|null;
}
interface Selection {readonly action:SeekerAuctionCrankAction;readonly state:SeekerAuctionReadResult}
export interface SeekerAuctionCrankPendingAttempt {
 readonly action:SeekerAuctionCrankAction;readonly signature:string;readonly lastValidBlockHeight:number;readonly slot:number;
}
interface OpenProof {readonly requestId:string;readonly policyKey:string;readonly messageHex:string;readonly signatureHex:string;readonly permit:SeekerActionPermit}
function need(value:unknown,label:string):asserts value {if(!value)throw new Error(`Seeker auction crank unavailable: ${label}`);}
function safe(value:unknown,label:string):number {need(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0,label);return value;}
function address(value:string):PublicKey {
 need(typeof value==='string','address type');const key=new PublicKey(value);
 need(key.toBase58()===value&&!key.equals(PublicKey.default),'canonical identity');return key;
}
function freezeAction(action:SeekerAuctionCrankAction):SeekerAuctionCrankAction {
 return action.kind==='settle'?Object.freeze({...action,spots:Object.freeze([...action.spots])}):Object.freeze({...action});
}
function result(status:SeekerAuctionCrankResult['status'],actions:readonly SeekerAuctionCrankAction[]=[],
 alarms:readonly SeekerAuctionCrankAlarm[]=[],signature:string|null=null):SeekerAuctionCrankResult {
 return Object.freeze({status,actions:Object.freeze(actions.map(freezeAction)),alarms:Object.freeze([...alarms]),signature});
}
function verifiedSignature(publicKey:string,message:Uint8Array,signature:Uint8Array):boolean {
 if(signature.length!==64)return false;
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),address(publicKey).toBuffer()]),format:'der',type:'spki'});
 return verify(null,message,key,signature);
}
/** Copy the issuer response before using it. The transport's verified receipt
 * remains bound independently to these exact requested bytes and current key. */
function receiptProof(receipt:CharterIssuerReceipt,requestId:string,policyKey:string,message:Buffer):Readonly<{signatureHex:string}> {
 need(receipt&&typeof receipt==='object'&&Reflect.ownKeys(receipt).sort().join(' ')==='message publicKey requestId signature','issuer receipt shape');
 const receivedId=receipt.requestId,receivedKey=receipt.publicKey,receivedMessage=receipt.message,receivedSignature=receipt.signature;
 need(receivedMessage instanceof Uint8Array&&receivedSignature instanceof Uint8Array,'issuer receipt bytes');
 const bytes=Buffer.from(receivedMessage),signature=Buffer.from(receivedSignature);
 need(receivedId===requestId&&receivedKey===policyKey&&bytes.equals(message),'issuer receipt binding');
 need(verifiedSignature(policyKey,bytes,signature),'issuer receipt signature');return Object.freeze({signatureHex:signature.toString('hex')});
}
function complete(action:SeekerAuctionCrankAction,state:SeekerAuctionReadResult):boolean {
 if(action.kind==='open-term')return state.term!==null;
 if(action.kind==='open-auction')return state.auctions[action.spot]!=null;
 return action.spots.every(spot=>state.auctions[spot]?.settled===true);
}
function eligible(action:SeekerAuctionCrankAction,state:SeekerAuctionReadResult):SeekerAuctionCrankAction|null {
 need(state.view.round===action.round,'action round');
 if(action.kind==='open-term')return state.term===null&&!state.authority.admissionPaused?action:null;
 if(action.kind==='open-auction')return state.term&&!state.authority.admissionPaused&&state.nowSec<state.term.auctionStart
  &&state.auctions[action.spot]===null?action:null;
 if(!state.term||state.nowSec<state.term.auctionEnd+state.config.graceSec)return null;
 const spots=action.spots.filter(spot=>state.auctions[spot]!==null&&state.auctions[spot]?.settled===false);
 return spots.length?freezeAction({kind:'settle',round:action.round,spots}):null;
}

export function createSeekerAuctionCrank(options:SeekerAuctionCrankOptions){
 const wallet=address(options.crankPublicKey),walletText=wallet.toBase58(),dryRun=options.dryRun;
 need(PublicKey.isOnCurve(wallet.toBytes())&&typeof dryRun==='boolean','worker configuration');
 const issuerPublicKey=options.issuerPublicKey===undefined?undefined:address(options.issuerPublicKey).toBase58();
 need(dryRun||issuerPublicKey!==undefined,'independent issuer public key');
 need(typeof options.source?.connect==='function'&&typeof options.loadSigner==='function'
  &&typeof options.issuer?.issueOnce==='function'&&typeof options.nextRequestId==='function','worker capabilities');
 need(Number.isSafeInteger(R.settleBatchMax)&&R.settleBatchMax>0&&Number.isSafeInteger(R.readRoundsBack)&&R.readRoundsBack>=0,'operational bounds');
 // Capture owned pins/capabilities; later caller mutations cannot repoint a run.
 const trust=Object.freeze({...options.source.trust}),connect=options.source.connect.bind(options.source),loadSigner=options.loadSigner,
  issueOnce=options.issuer.issueOnce.bind(options.issuer),nextRequestId=options.nextRequestId,onEvent=options.onEvent;
 const deploymentSlot=safe(trust.deploymentSlot,'deployment slot');
 let running=false,pending:SeekerAuctionCrankPendingAttempt|null=null,lastRequestId:string|null=null;
 /** The worker retains its global queue slot while this is non-null, including
  * after a thrown status-read error. Inspection cannot mutate internal state. */
 function pendingAttempt():SeekerAuctionCrankPendingAttempt|null {
  return pending===null?null:Object.freeze({...pending,action:freezeAction(pending.action)});
 }
 function emit(event:SeekerAuctionCrankEvent):void {
  // A logger must never erase a pending signature or turn a known send into a
  // retry. Re-entry through a callback still sees the held running guard.
  try{void Promise.resolve(onEvent?.(Object.freeze(event))).catch(()=>{});}catch{/* observational callback only */}
 }
 async function runOnce(caller:AbortSignal):Promise<SeekerAuctionCrankResult> {
  caller.throwIfAborted();if(running)return result('busy');
  const signal=AbortSignal.any([caller,AbortSignal.timeout(PASS_DEADLINE_MS)]),alarms=new Map<string,SeekerAuctionCrankAlarm>();
  running=true;
  let keyMaterial:Uint8Array|undefined,signer:Keypair|undefined,floor=deploymentSlot;
  const active=()=>signal.throwIfAborted();
  const readSource:SeekerAuctionReadSource={trust,connect:inner=>{
   const rpc=connect(AbortSignal.any([signal,inner]));return {
    getGenesisHash:()=>rpc.getGenesisHash(),
    getMultipleAccountsInfoAndContext:async(addresses,settings)=>{
     const minimum=Math.max(floor,settings.minContextSlot),response=await rpc.getMultipleAccountsInfoAndContext(addresses,{...settings,minContextSlot:minimum});active();
     const slot=safe(response.context?.slot,'read context');need(slot>=minimum,'regressing read context');floor=Math.max(floor,slot);return response;
    },
   };
  }};
  function alarm(state:SeekerAuctionReadResult):void {
   const spots=state.auctions.flatMap((auction,spot)=>auction===null?[spot]:[]),start=BigInt(state.view.auctionStart);
   if(!spots.length||state.nowSec<start-BigInt(R.openAlarmLeadSec))return;
   const code=state.nowSec>=start?'OPEN_WINDOW_MISSED':'OPEN_DEADLINE';
   const value=Object.freeze({code,round:state.view.round,spots:Object.freeze(spots),auctionStart:start.toString()});
   const id=`${code}:${value.round}`;if(!alarms.has(id)){alarms.set(id,value);emit({type:'alarm',alarm:value});}
  }
  const listedAlarms=()=>[...alarms.values()];
  function issuanceAlarm(code:'POLICY_KEY_MISMATCH'|'ISSUER_REFUSED',action:Extract<SeekerAuctionCrankAction,{kind:'open-auction'}>,state:SeekerAuctionReadResult):void {
   const value=Object.freeze({code,round:action.round,spots:Object.freeze([action.spot]),auctionStart:state.view.auctionStart});
   const id=`${code}:${action.round}`;if(!alarms.has(id)){alarms.set(id,value);emit({type:'alarm',alarm:value});}
  }
  function policyMismatch(action:SeekerAuctionCrankAction,state:SeekerAuctionReadResult):boolean {
   if(action.kind!=='open-auction'||state.authority.currentPolicyKey===issuerPublicKey)return false;
   issuanceAlarm('POLICY_KEY_MISMATCH',action,state);return true;
  }
  const readTarget=async(action:SeekerAuctionCrankAction)=>{
   const round=BigInt(action.round);
   const state=action.kind==='settle'?await readSeekerAuctionRound(readSource,walletText,round,signal)
    :await readSeekerAuctionPrivateRound(readSource,walletText,round,signal);
   active();alarm(state);return state;
  };
  async function plan():Promise<{selected:Selection|null;held:boolean}> {
   const current=await readSeekerAuctionRound(readSource,walletText,undefined,signal);active();alarm(current);
   const bidding=BigInt(current.view.biddingRound),first=bidding>BigInt(R.readRoundsBack)?bidding-BigInt(R.readRoundsBack):0n;
   let prerequisite:SeekerAuctionReadResult|null=null;
   // Oldest visible settlement first; one batch cannot starve later passes.
   for(let round=first;round<bidding;round++){
    const state=await readSeekerAuctionRound(readSource,walletText,round,signal);active();alarm(state);
    if(!state.term){need(current.term===null,'missing historical predecessor');prerequisite??=state;continue;}
    if(state.nowSec>=state.term.auctionEnd+state.config.graceSec){
     const spots=state.auctions.flatMap((auction,spot)=>auction&&!auction.settled?[spot]:[]).slice(0,R.settleBatchMax);
     if(spots.length)return {selected:{action:freezeAction({kind:'settle',round:round.toString(),spots}),state},held:false};
    }
   }
   function open(state:SeekerAuctionReadResult):Selection|null {
    if(state.authority.admissionPaused)return null;
    // Terms have no clock gate. A missed initial term remains a necessary
    // predecessor; its late auctions remain prohibited and alarmed separately.
    if(!state.term)return {action:freezeAction({kind:'open-term',round:state.view.round}),state};
    if(state.nowSec>=state.term.auctionStart)return null;
    const spot=state.auctions.findIndex(auction=>auction===null);
    return spot<0?null:{action:freezeAction({kind:'open-auction',round:state.view.round,spot}),state};
   }
   const candidate=prerequisite??current,chosen=open(candidate);
   if(chosen)return {selected:chosen,held:false};
   let held=candidate.authority.admissionPaused&&(candidate.term===null||candidate.auctions.some(a=>a===null));
   // Never recurse into further successors or invent a missing predecessor.
   if(!current.term||prerequisite)return {selected:null,held};
   if(bidding===U64_MAX)return {selected:null,held};
   const successor=await readSeekerAuctionPrivateRound(readSource,walletText,bidding+1n,signal);active();alarm(successor);
   const next=open(successor);held ||= successor.authority.admissionPaused&&(successor.term===null||successor.auctions.some(a=>a===null));
   return {selected:next,held:next?false:held};
  }
  try{
   active();let expired=false;
   if(pending){
    const retained=pending,rpc=connect(signal);floor=Math.max(floor,retained.slot);
    need(await rpc.getGenesisHash()===trust.genesisHash,'pending chain identity');active();
    // A later status read must cover the finalized bank that supplied height.
    const epoch=await rpc.getEpochInfo({commitment:'finalized',minContextSlot:floor});active();
    const bankSlot=safe(epoch.absoluteSlot,'finalized slot'),height=safe(epoch.blockHeight,'finalized height');need(bankSlot>=floor,'stale finalized slot');
    const statuses=await rpc.getSignatureStatuses([retained.signature],{searchTransactionHistory:true});active();
    const context=safe(statuses.context?.slot,'status context');need(context>=bankSlot&&Array.isArray(statuses.value)&&statuses.value.length===1,'stale/incomplete status');
    const status=statuses.value[0];need(status===null||status&&typeof status==='object','status row');floor=Math.max(floor,bankSlot,context);
    if(status!==null){
     need(safe(status.slot,'transaction slot')<=context&&Object.hasOwn(status,'err'),'transaction status');
     need(status.err===null||typeof status.err==='string'&&status.err.length>0
      ||status.err&&typeof status.err==='object'&&!Array.isArray(status.err),'transaction error shape');
     need(status.confirmations===null||Number.isSafeInteger(status.confirmations)&&status.confirmations>=0,'confirmation count');
     need(['processed','confirmed','finalized'].includes(status.confirmationStatus??''),'confirmation status');
     if(status.confirmationStatus!=='finalized')return result('pending',[],listedAlarms(),retained.signature);
     need(status.confirmations===null,'finalized confirmation count');
     need(await rpc.getGenesisHash()===trust.genesisHash,'finalized chain identity');active();
     if(status.err!==null){pending=null;emit({type:'failed',signature:retained.signature,action:retained.action});return result('failed',[retained.action],listedAlarms(),retained.signature);}
     const observed=await readTarget(retained.action);need(complete(retained.action,observed),'finalized transaction absent from chain state');
     pending=null;emit({type:'finalized',signature:retained.signature,action:retained.action});return result('finalized',[retained.action],listedAlarms(),retained.signature);
    }else if(height>retained.lastValidBlockHeight)expired=true;
    else return result('pending',[],listedAlarms(),retained.signature);
   }
   // Keep the retained attempt if this fresh read fails. Expiry alone does not
   // authorize reconstructing an action from stale cached bitmaps.
   const planned=await plan();active();
   if(expired&&pending){const retained=pending;pending=null;emit({type:'expired',signature:retained.signature,action:retained.action});}
   if(!planned.selected)return result(planned.held?'held':'idle',[],listedAlarms());
   let {action,state}=planned.selected;
   // Prove canonical predecessor even for a missing current/historical term.
   state=await readTarget(action);const firstEligible=eligible(action,state);
   if(!firstEligible)return result(state.authority.admissionPaused?'held':'idle',[],listedAlarms());action=firstEligible;
   if(dryRun)return result('dry-run',[action],listedAlarms());
   if(policyMismatch(action,state))return result('held',[],listedAlarms());
   const loaded=await loadSigner(signal);active();need(loaded?.publicKey?.toBase58()===walletText,'worker public key');
   need(loaded.secretKey instanceof Uint8Array&&loaded.secretKey.length===64,'worker signing capability');keyMaterial=Uint8Array.from(loaded.secretKey);
   signer=Keypair.fromSecretKey(keyMaterial);need(signer.publicKey.equals(wallet),'worker key identity');
   state=await readTarget(action);const afterKey=eligible(action,state);
   if(!afterKey)return result(state.authority.admissionPaused?'held':'idle',[],listedAlarms());action=afterKey;
   if(policyMismatch(action,state))return result('held',[],listedAlarms());
   let proof:OpenProof|undefined;
   if(action.kind==='open-auction'){
    const requestId=requestIdSchema.parse(nextRequestId());need(requestId!==lastRequestId,'fresh issuance request id');lastRequestId=requestId;
    const permitId=Buffer.from(requestId.replaceAll('-',''),'hex'),terms=seekerAuctionTermsFromRead(state,action.spot);
    const expiry=state.nowSec+BigInt(A.issuedPolicyPermitTtlSec);need(expiry<=I64_MAX&&expiry>state.nowSec,'permit expiry');
    const permit:SeekerActionPermit={genesisHash:address(trust.genesisHash),programId:address(trust.programId),kind:7,
     permitId,wallet,expiry,payloadHash:hashOpenSeekerAuctionPayload(terms)};
    const requested=encodeSeekerActionPermit(permit),sentMessage=Uint8Array.from(requested),policyKey=state.authority.currentPolicyKey;
    let response:CharterIssuerReceipt;
    try{response=await issueOnce({kind:'seeker-auction-open-v1',requestId,auction:{round:action.round,spot:action.spot},message:sentMessage},signal);}
    catch{
     // Cancellation remains cancellation; transport details never enter alarms.
     active();issuanceAlarm('ISSUER_REFUSED',action,state);return result('held',[],listedAlarms());
    }
    active();
    need(Buffer.from(sentMessage).equals(requested),'issuer mutated request');const verified=receiptProof(response,requestId,policyKey,requested);
    proof=Object.freeze({requestId,policyKey,messageHex:requested.toString('hex'),signatureHex:verified.signatureHex,permit});
   }
   const rpc=connect(signal),latest=await rpc.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:floor});active();
   const hashSlot=safe(latest.context?.slot,'blockhash context'),lastValidBlockHeight=safe(latest.value?.lastValidBlockHeight,'blockhash height');
   need(hashSlot>=floor,'stale blockhash');const blockhash=address(latest.value.blockhash).toBase58();floor=hashSlot;
   // Re-admit after every external key/issuer/blockhash await, then build and
   // sign synchronously. All fields come from this final admitted snapshot.
   state=await readTarget(action);const finalEligible=eligible(action,state);
   if(!finalEligible)return result(state.authority.admissionPaused?'held':'idle',[],listedAlarms());action=finalEligible;
   const program=address(state.config.programId),round=BigInt(action.round);let message:Message;
   if(action.kind==='open-auction'){
    need(proof&&proof.policyKey===state.authority.currentPolicyKey&&proof.permit.expiry>state.nowSec
     &&proof.permit.expiry-state.nowSec<=BigInt(A.maxPolicyPermitTtlSec),'current open permit');
    const terms=seekerAuctionTermsFromRead(state,action.spot);
    need(Buffer.from(proof.permit.payloadHash).equals(hashOpenSeekerAuctionPayload(terms))
     &&encodeSeekerActionPermit(proof.permit).toString('hex')===proof.messageHex,'immutable open terms');
    message=Message.from(buildOpenAuctionTx(program,{payer:wallet,terms,permit:proof.permit,policyKey:address(proof.policyKey),
     policySignature:Buffer.from(proof.signatureHex,'hex'),blockhash}).messageBytes);
   }else{
    const instructions:TransactionInstruction[]=action.kind==='open-term'?[buildOpenTermIx(program,{payer:wallet,round})]
     :action.spots.map(spot=>{const auction=state.auctions[spot];need(auction&&!auction.settled,'settlement target');
      return buildSettleIx(program,{wallet,mint:address(state.config.mint),round,spot,prizeOwner:address(state.config.prizeOwner),
       highBidder:auction.highBidder===null?null:address(auction.highBidder),highBid:auction.highBid});});
    need(instructions.length>0&&(action.kind!=='settle'||instructions.length<=R.settleBatchMax),'transaction work bound');
    message=new TransactionMessage({payerKey:wallet,recentBlockhash:blockhash,instructions}).compileToLegacyMessage();
   }
   active();need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&message.accountKeys[0]?.equals(wallet),'one worker signer');
   const transaction=new VersionedTransaction(message);transaction.sign([signer]);const wire=transaction.serialize(),signatureBytes=transaction.signatures[0]!;
   need(wire.length<=PACKET_DATA_SIZE&&transaction.signatures.length===1&&verifiedSignature(walletText,message.serialize(),signatureBytes),'canonical signed transaction');
   const signature=bs58.encode(signatureBytes);pending=Object.freeze({signature,lastValidBlockHeight,slot:state.slot,action:freezeAction(action)});
   // Save before relay (or callbacks): a thrown send or observer is ambiguity,
   // never evidence that the transaction failed to reach the network.
   emit({type:'pending',signature,action:pending.action});
   try{
    const returned=await rpc.sendRawTransaction(wire,{maxRetries:0,preflightCommitment:'finalized',minContextSlot:state.slot});
    if(returned!==signature)return result('pending',[action],listedAlarms(),signature);
    emit({type:'submitted',signature,action:pending.action});return result('submitted',[action],listedAlarms(),signature);
   }catch{return result('pending',[action],listedAlarms(),signature);}
  }finally{keyMaterial?.fill(0);if(signer)signer.secretKey.fill(0);running=false;}
 }
 return Object.freeze({runOnce,pendingAttempt});
}
