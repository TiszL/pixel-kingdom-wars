/** Default-off authenticated auction transport. All intents are reconstructed
 * from finalized accounts. No database, cached quote, or client DTO is authority. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bs58 from 'bs58';
import { ComputeBudgetProgram, Message, PublicKey, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { buildBidMessage, buildWithdrawMessage, seekerAuctionAccountHint, seekerPlayerInstructionHint, type SeekerUnsignedMessage } from '@shardkeep/chain/seeker-auction-instructions';
import { assertPlayerSignedSeekerTx } from '@shardkeep/chain/seeker-auction-signed';
import { SeekerAuctionSourcedRoundViewSchema, SeekerBidPrepareRequestSchema, SeekerWithdrawPrepareRequestSchema,
 SeekerAuctionPreparedSchema, SeekerAuctionSubmitRequestSchema, SeekerAuctionTxStatusSchema,
 type SeekerAuctionPrepared, type SeekerAuctionTxStatus } from '@shardkeep/shared/seekerAuctionApi';
import { readSeekerAuctionRefunds } from './auctionRefunds';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { readSeekerAuctionRound, readSeekerAuctionWithdrawalTarget, type SeekerAuctionWithdrawalTarget, type SeekerAuctionReadSource, type SeekerAuctionReadResult, type SeekerAuctionReadRpc } from './auctionReadModel';

export type SeekerAuctionRpc = SeekerAuctionReadRpc & Pick<Connection, 'getLatestBlockhashAndContext' | 'getFeeForMessage'
 | 'getMinimumBalanceForRentExemption' | 'getSignatureStatuses' | 'getEpochInfo' | 'sendRawTransaction'>;
export interface SeekerAuctionSource extends SeekerAuctionReadSource { readonly connect:(signal:AbortSignal)=>SeekerAuctionRpc }
const DEADLINE_MS=30_000;
function activeSignal(caller?:AbortSignal) { return caller?AbortSignal.any([caller,AbortSignal.timeout(DEADLINE_MS)]):AbortSignal.timeout(DEADLINE_MS); }
function unavailable():never {throw new HttpError(503,'Seeker auction data is unavailable','SEEKER_AUCTION_UNAVAILABLE');}
function refuse(ok:unknown,message:string):asserts ok {if(!ok)throw new HttpError(409,message,'SEEKER_AUCTION_REFRESH_REQUIRED');}
function safe(value:number):number {if(!Number.isSafeInteger(value)||value<0)unavailable();return value;}
function present(source:SeekerAuctionSource|null|undefined):SeekerAuctionSource {if(!source)unavailable();return source;}
async function snapshot(source:SeekerAuctionReadSource,wallet:string,round:bigint,signal:AbortSignal) {
 try{return await readSeekerAuctionRound(source,wallet,round,signal);}catch{return unavailable();}
}
async function withdrawalSnapshot(source:SeekerAuctionReadSource,wallet:string,round:bigint,spot:number,signal:AbortSignal){
 try{return await readSeekerAuctionWithdrawalTarget(source,wallet,round,spot,signal);}catch{return unavailable();}
}
function bidIntent(state:SeekerAuctionReadResult,wallet:string,spot:number,newTotal:bigint) {
 const auction=state.auctions[spot],bid=state.bids[spot];
 refuse(state.view.round===state.view.biddingRound,'Refresh the current bidding round');
 refuse(state.term&&state.term.openedCount===PHASE_E_POLICY.seekerIsland.totalSpots&&auction&&!auction.settled,'The auction is not ready for bidding');
 refuse(!state.view.admissionPaused,'Bidding is paused');
 refuse(state.nowSec>=auction.auctionStart&&state.nowSec<auction.auctionEnd,'Bidding is outside its window');
 refuse(newTotal>=state.config.openingBid&&newTotal>auction.highBid,'Raise the total above the current bid');
 const own=bid?.amount??0n;
 refuse(auction.highBidder!==wallet||own===auction.highBid,'Refresh the current escrow balance');
 refuse(newTotal>own&&(!bid?.refunded||own===0n),'Refresh the current escrow balance');
 const increment=newTotal-own;
 refuse(state.walletAta&&state.walletAta.amount>=increment,'The SKR balance does not cover the increment');
 return {increment,needsBid:bid===null};
}
function withdrawalIntent(state:SeekerAuctionWithdrawalTarget,wallet:string) {
 const {auction,bid}=state;
 refuse(auction&&bid&&bid.amount>0n&&!bid.refunded&&auction.highBidder!==wallet,'No losing escrow is available to withdraw');
 return {needsDestination:state.walletAta===null};
}
async function quote(source:SeekerAuctionSource,state:Pick<SeekerAuctionReadResult,'slot'>,signal:AbortSignal,increment:bigint,
 build:(blockhash:string)=>SeekerUnsignedMessage):Promise<SeekerAuctionPrepared> {
 const rpc=source.connect(signal);
 try {
  const latest=await rpc.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:state.slot});signal.throwIfAborted();
  if(safe(latest.context.slot)<state.slot)unavailable();safe(latest.value.lastValidBlockHeight);
  const packet=build(latest.value.blockhash),message=Message.from(packet.messageBytes);
  const fee=await rpc.getFeeForMessage(message,'finalized');signal.throwIfAborted();
  if(safe(fee.context.slot)<state.slot||fee.value===null)unavailable();safe(fee.value);
  let rent=0n;for(const account of packet.expectedNewAccounts){rent+=BigInt(safe(await rpc.getMinimumBalanceForRentExemption(account.space,'finalized')));signal.throwIfAborted();}
  return SeekerAuctionPreparedSchema.parse({messageBase64:Buffer.from(packet.messageBytes).toString('base64'),blockhash:latest.value.blockhash,
   lastValidBlockHeight:String(latest.value.lastValidBlockHeight),incrementRaw:increment.toString(),networkFeeLamports:String(fee.value),newAccountRentLamports:rent.toString()});
 }catch{return unavailable();}
}
export async function prepareSeekerBid(source:SeekerAuctionSource,wallet:string,input:unknown,caller?:AbortSignal):Promise<SeekerAuctionPrepared> {
 const request=SeekerBidPrepareRequestSchema.parse(input),signal=activeSignal(caller),state=await snapshot(source,wallet,BigInt(request.round),signal);
 const intent=bidIntent(state,wallet,request.spot,BigInt(request.newTotalRaw));
 return quote(source,state,signal,intent.increment,blockhash=>buildBidMessage(new PublicKey(state.config.programId),{
  wallet:new PublicKey(wallet),mint:new PublicKey(state.config.mint),round:BigInt(request.round),spot:request.spot,newTotal:BigInt(request.newTotalRaw),needsBid:intent.needsBid,blockhash}));
}
export async function prepareSeekerWithdrawal(source:SeekerAuctionSource,wallet:string,input:unknown,caller?:AbortSignal):Promise<SeekerAuctionPrepared> {
 const request=SeekerWithdrawPrepareRequestSchema.parse(input),signal=activeSignal(caller),state=await withdrawalSnapshot(source,wallet,BigInt(request.round),request.spot,signal);
 const intent=withdrawalIntent(state,wallet);
 return quote(source,state,signal,0n,blockhash=>buildWithdrawMessage(new PublicKey(state.config.programId),{
  wallet:new PublicKey(wallet),mint:new PublicKey(state.config.mint),round:BigInt(request.round),spot:request.spot,needsDestination:intent.needsDestination,blockhash}));
}
/** Unknown is an observation, never server-inferred expiry. Only a client with
 * its own saved lastValidBlockHeight can decide when to offer a fresh intent. */
export async function readSeekerAuctionStatus(source:SeekerAuctionSource,signature:string,caller?:AbortSignal):Promise<SeekerAuctionTxStatus> {
 SeekerAuctionSubmitRequestSchema.parse({signature});const signal=activeSignal(caller),rpc=source.connect(signal);
 try {
  if(await rpc.getGenesisHash()!==source.trust.genesisHash)unavailable();signal.throwIfAborted();
  // Sample one finalized bank before status. A load-balanced older status bank
  // must never make a landed signature look expired against a newer height.
  const epoch=await rpc.getEpochInfo({commitment:'finalized'});signal.throwIfAborted();
  if(epoch.blockHeight===undefined)unavailable();
  const sampledSlot=safe(epoch.absoluteSlot),height=safe(epoch.blockHeight);
  const statuses=await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true});signal.throwIfAborted();
  if(safe(statuses.context.slot)<sampledSlot||statuses.value.length!==1)unavailable();
  const observation=statuses.value[0];if(observation===undefined)unavailable();
  if(observation!==null){safe(observation.slot);if(observation.slot>statuses.context.slot)unavailable();}
  const finalized=observation!==null&&observation.confirmationStatus==='finalized';
  return SeekerAuctionTxStatusSchema.parse({signature,status:finalized?(observation.err===null?'finalized':'failed'):'pending',
   slot:finalized?String(observation.slot):null,error:finalized&&observation.err!==null?'CHAIN_TRANSACTION_FAILED':null,
   found:observation!==null,finalizedBlockHeight:String(height)});
 }catch{return unavailable();}
}
export async function submitSeekerAuction(source:SeekerAuctionSource,wallet:string,input:unknown,caller?:AbortSignal):Promise<SeekerAuctionTxStatus> {
 const request=SeekerAuctionSubmitRequestSchema.parse(input),signal=activeSignal(caller);
 if('signature'in request)return readSeekerAuctionStatus(source,request.signature,signal);
 const wire=Buffer.from(request.signedTransaction,'base64'),program=new PublicKey(source.trust.programId),rpc=source.connect(signal);
 let tx:VersionedTransaction,signature:string;
 try {
  tx=VersionedTransaction.deserialize(wire);if(tx.version!=='legacy'||tx.signatures.length!==1
   ||tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0]?.toBase58()!==wallet)throw Error('single wallet legacy required');
  signature=bs58.encode(tx.signatures[0]!);SeekerAuctionSubmitRequestSchema.parse({signature});
 }catch{throw new HttpError(400,'Invalid Seeker auction transaction','SEEKER_AUCTION_INVALID_TRANSACTION');}
 // A lost POST response may be retried after the chain changed the Bid account.
 // A found signature is already observable through the signature-only endpoint;
 // return that observation before current intent checks, without any new relay.
 const prior=await readSeekerAuctionStatus(source,signature,signal);if(prior.found===true)return prior;
 let action:ReturnType<typeof seekerPlayerInstructionHint>,applicationInstructionCount:number;
 try {
  const instructions=TransactionMessage.decompile(tx.message).instructions.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
  applicationInstructionCount=instructions.length;
  if(instructions.length<1||instructions.length>2)throw Error('one action required');
  action=seekerPlayerInstructionHint(program,instructions.at(-1)!);
 }catch{throw new HttpError(400,'Invalid Seeker auction transaction','SEEKER_AUCTION_INVALID_TRANSACTION');}
 // The wire contains an auction address, not a trusted round. Decode a bounded
 // target hint, then re-read its canonical accounts and all ownership links.
 let target:ReturnType<typeof seekerAuctionAccountHint>;
 try {
  if(await rpc.getGenesisHash()!==source.trust.genesisHash)unavailable();signal.throwIfAborted();
  const address=new PublicKey(action.auction),raw=await rpc.getMultipleAccountsInfoAndContext([address],{commitment:'finalized',minContextSlot:source.trust.deploymentSlot});signal.throwIfAborted();
  if(safe(raw.context.slot)<source.trust.deploymentSlot||raw.value.length!==1||!raw.value[0])unavailable();
  target=seekerAuctionAccountHint(program,address,raw.value[0]);
 }catch{return unavailable();}
 let expected:SeekerUnsignedMessage;
 const base={wallet:new PublicKey(wallet),round:target.round,spot:target.spot,blockhash:tx.message.recentBlockhash};
 if(action.kind==='bid'){
  const state=await snapshot(source,wallet,target.round,signal);refuse(state.auctions[target.spot]?.address===action.auction,'Refresh the target auction');
  const intent=bidIntent(state,wallet,target.spot,action.newTotal!);expected=buildBidMessage(program,{...base,mint:new PublicKey(state.config.mint),newTotal:action.newTotal!,needsBid:intent.needsBid});
 }else{
  const state=await withdrawalSnapshot(source,wallet,target.round,target.spot,signal);refuse(state.auction.address===action.auction,'Refresh the target auction');
  const intent=withdrawalIntent(state,wallet);expected=buildWithdrawMessage(program,{...base,mint:new PublicKey(state.config.mint),needsDestination:intent.needsDestination||applicationInstructionCount===2});
 }
 let verified:ReturnType<typeof assertPlayerSignedSeekerTx>;
 try{verified=assertPlayerSignedSeekerTx(wire,new PublicKey(wallet),TransactionMessage.decompile(Message.from(expected.messageBytes)).instructions,
  BigInt(PHASE_E_SEEKER_AUCTION_RUNTIME.maxWalletAddedPriorityFeeLamports));}
 catch{throw new HttpError(400,'Invalid Seeker auction transaction','SEEKER_AUCTION_INVALID_TRANSACTION');}
 signal.throwIfAborted();
 try{const returned=await rpc.sendRawTransaction(wire,{maxRetries:0,skipPreflight:false,preflightCommitment:'confirmed'});if(returned!==verified.signature)throw Error('relay identity mismatch');}
 catch{/* A relay error is ambiguous. Never retry or invent terminal failure. */}
 try{return await readSeekerAuctionStatus(source,verified.signature,signal);}
 catch{return {signature:verified.signature,status:'pending',slot:null,error:null};}
}
export function registerSeekerAuctionRoutes(app:FastifyInstance,source?:SeekerAuctionSource|null) {
 const auth={preHandler:[app.authenticate],config:{rateLimit:{max:PHASE_E_SEEKER_AUCTION_RUNTIME.writeRateLimitPerMin,timeWindow:60_000}},
  onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const readAuth={...auth,config:{rateLimit:{max:PHASE_E_SEEKER_AUCTION_RUNTIME.readRateLimitPerMin,timeWindow:60_000}}};
 const refundReadAuth={...auth,config:{rateLimit:{max:PHASE_E_SEEKER_AUCTION_RUNTIME.refundReadRateLimitPerMin,timeWindow:60_000}}};
 const empty=z.object({}).strict();
 const refundQuery=z.object({round:SeekerWithdrawPrepareRequestSchema.shape.round.optional(),
  spot:z.string().regex(/^(0|[1-9][0-9]?)$/).transform(Number).pipe(SeekerWithdrawPrepareRequestSchema.shape.spot).optional()}).strict()
  .superRefine((v,ctx)=>{if((v.round===undefined)!==(v.spot===undefined))ctx.addIssue({code:'custom',message:'refund cursor requires round and spot'});});
 async function read(wallet:string,round?:bigint) {
  try{return SeekerAuctionSourcedRoundViewSchema.parse((await readSeekerAuctionRound(present(source),wallet,round)).view);}catch{return unavailable();}
 }
 app.get('/seeker/auctions/current',readAuth,async req=>{parse(empty,req.query);return read(req.wallet);});
 app.get('/seeker/auctions/refunds',refundReadAuth,async req=>{
  const cursor=parse(refundQuery,req.query),request=cursor.round===undefined?{}:{after:{round:cursor.round,spot:cursor.spot!}};
  try{return await readSeekerAuctionRefunds(present(source),req.wallet,request);}catch{return unavailable();}
 });
 app.get('/seeker/auctions/round/:round',readAuth,async req=>{
  parse(empty,req.query);const input=parse(z.object({round:SeekerWithdrawPrepareRequestSchema.shape.round}).strict(),req.params);return read(req.wallet,BigInt(input.round));
 });
 app.get('/seeker/auctions/tx/:signature',readAuth,async req=>{
  parse(empty,req.query);const input=parse(z.object({signature:SeekerAuctionTxStatusSchema.shape.signature}).strict(),req.params);return readSeekerAuctionStatus(present(source),input.signature);
 });
 app.post('/seeker/auctions/bids/prepare',auth,async req=>{parse(empty,req.query);const body=parse(SeekerBidPrepareRequestSchema,req.body);return prepareSeekerBid(present(source),req.wallet,body);});
 app.post('/seeker/auctions/withdrawals/prepare',auth,async req=>{parse(empty,req.query);const body=parse(SeekerWithdrawPrepareRequestSchema,req.body);return prepareSeekerWithdrawal(present(source),req.wallet,body);});
 app.post('/seeker/auctions/submit',auth,async req=>{parse(empty,req.query);const body=parse(SeekerAuctionSubmitRequestSchema,req.body);return submitSeekerAuction(present(source),req.wallet,body);});
}
