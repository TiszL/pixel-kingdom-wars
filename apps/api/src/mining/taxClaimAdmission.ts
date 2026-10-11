/** Fresh observation of saved tax packets, shared by pre-wallet review and the
 * private relay. Neither assessment grants signing, broadcast or settlement. */
import {Message,PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {createMiningTaxQuoteReader,MiningTaxQuoteError,type MiningTaxQuoteRpc} from '@shardkeep/chain/mining-tax-quote';
import {buildMiningTaxMessages,quoteMiningTaxMessageCosts,MiningTaxMessageError,type MiningTaxCostQuote} from '@shardkeep/chain/mining-tax-message';
import {MiningTaxSnapshotError,type MiningTaxSnapshotTrust} from '@shardkeep/chain/mining-tax-snapshot';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {getMiningTaxClaimPreparationRecord} from './taxClaimPreparationStore';
import {getMiningTaxClaimSigned,type MiningTaxClaimSignedWire} from './taxClaimSignedStore';
import {getMiningTaxClaimSettlement} from './taxClaimSettlement';
import {hasMiningTaxClaimContinuation} from './taxClaimContinuation';
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000;
type Code='INVALID_INPUT'|'NOT_PREPARED'|'NOT_SIGNED'|'SETUP_REQUIRED'|'DISABLED'|'EXPIRED'|'SOURCE_CONFLICT'|'QUOTE_UNAVAILABLE'|'COST_CAP'|'BUSY'|'TIMEOUT'|'CONTINUED';
export class MiningTaxClaimAdmissionError extends Error{constructor(readonly code:Code){super(`Mining tax admission refused: ${code}`);this.name='MiningTaxClaimAdmissionError';}}
function fail(code:Code):never{throw new MiningTaxClaimAdmissionError(code);}
function fields(value:unknown,allowed:readonly string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!allowed.includes(k)))fail('INVALID_INPUT');}
const address=z.string().min(32).max(44).refine(v=>{try{const k=new PublicKey(v);return k.toBase58()===v&&PublicKey.isOnCurve(k.toBytes())&&!k.equals(PublicKey.default);}catch{return false;}});
const schema=z.object({wallet:address,idempotencyKey:z.uuid().refine(v=>v===v.toLowerCase()),ordinal:z.number().int().min(0).max(1)}).strict();
export type MiningTaxClaimAdmissionKey=z.infer<typeof schema>;
function safe(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)fail('QUOTE_UNAVAILABLE');return value;}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
function copyTrust(input:MiningTaxSnapshotTrust):MiningTaxSnapshotTrust{
 try{createMiningTaxQuoteReader(()=>{throw Error('No connection during validation');},input);const m=input.mining,s=input.seeker,key=(v:PublicKey)=>new PublicKey(v.toBytes());
  return {mining:{...m,programId:key(m.programId),keepMint:key(m.keepMint),reserveOwner:key(m.reserveOwner)},seeker:{...s,programId:key(s.programId),config:key(s.config),mint:key(s.mint),prizeOwner:key(s.prizeOwner),prizeAta:key(s.prizeAta),genesisHash:key(s.genesisHash),deployment:{...s.deployment}}};
 }catch{fail('INVALID_INPUT');}
}
export interface MiningTaxClaimAdmissionSources{readonly connect:(signal:AbortSignal)=>MiningTaxQuoteRpc;readonly trust:MiningTaxSnapshotTrust;readonly now?:()=>Date;readonly timeoutMs?:number}
export interface MiningTaxClaimAdmission{
 readonly wallet:string;readonly idempotencyKey:string;readonly claimId:string;readonly ordinal:number;readonly signature:string;readonly messageSha256:string;readonly wireSha256:string;readonly signedTransactionHex:string;
 readonly feeLamports:bigint;readonly rentLamports:bigint;readonly totalLamports:bigint;readonly paidFeeLamports:bigint;readonly paidRentLamports:bigint;
 readonly source:{readonly genesisHash:string;readonly programId:string;readonly reviewedDeploymentSlot:number;readonly reviewedProgramDataSha256:string;readonly snapshotSlot:number;readonly feeSlot:number;readonly blockHeight:number;readonly lastValidBlockHeight:number};
 readonly currentSigningAuthorized:false;readonly relayAuthorized:false;readonly settlementAuthorized:false;
}
export type MiningTaxClaimReview=Readonly<Omit<MiningTaxClaimAdmission,'signature'|'wireSha256'|'signedTransactionHex'>&{
 status:'ready';blockhash:string;preparedAt:string;expiresAt:string;observedAt:string;
}>;
/** Signed relay assessment always requires the matching durable original wire. */
export function createMiningTaxClaimAdmission(db:Db,options:MiningTaxClaimAdmissionSources){
 return createAssessment(db,options,true,(review,wire):MiningTaxClaimAdmission=>{
  if(!wire)fail('NOT_SIGNED');
  const {status:_status,blockhash:_blockhash,preparedAt:_preparedAt,expiresAt:_expiresAt,observedAt:_observedAt,...facts}=review;
  return freeze({...facts,signature:wire.signature,wireSha256:wire.wireSha256,signedTransactionHex:wire.signedTransactionHex});
 });
}
/** Read-only pre-wallet observation. It cannot substitute for signed admission
 * and cannot extend or replace any part of the durable original preparation. */
export function createMiningTaxClaimReview(db:Db,options:MiningTaxClaimAdmissionSources){
 return createAssessment(db,options,false,review=>review);
}
// The mode and projection remain private. No caller can supply an assessment or
// switch a signed-admission instance into unsigned review after construction.
function createAssessment<T>(db:Db,options:MiningTaxClaimAdmissionSources,requireSigned:boolean,project:(review:MiningTaxClaimReview,wire:MiningTaxClaimSignedWire|undefined)=>T){
 fields(options,['connect','trust','now','timeoutMs']);if(typeof options.connect!=='function'||options.now!==undefined&&typeof options.now!=='function')fail('INVALID_INPUT');
 const connect=options.connect,trust=copyTrust(options.trust),now=options.now??(()=>new Date()),timeout=options.timeoutMs??MAX_TIMEOUT_MS;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)fail('INVALID_INPUT');
 const pending=new Map<string,Promise<T>>();
 return async(value:unknown):Promise<T>=>{
  fields(value,['wallet','idempotencyKey','ordinal']);const parsed=schema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');const k=parsed.data,id=`${k.wallet}:${k.idempotencyKey}:${k.ordinal}`;
  const old=pending.get(id);if(old)return old;if(pending.size>=MAX_PENDING)fail('BUSY');
  const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let workDone=false,release=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  const alive=()=>{if(controller.signal.aborted)fail('TIMEOUT');};
  const trackedConnect=(inner:AbortSignal):MiningTaxQuoteRpc=>{
   const signal=AbortSignal.any([inner,controller.signal]);signal.throwIfAborted();const rpc=connect(signal);
   const track=<T>(invoke:()=>Promise<T>):Promise<T>=>{if(signal.aborted)return Promise.reject(new MiningTaxClaimAdmissionError('TIMEOUT'));let call:Promise<T>;try{call=Promise.resolve(invoke());}catch(e){call=Promise.reject(e);}outstanding.add(call);const done=()=>{outstanding.delete(call);release();};void call.then(done,done);return call;};
   return {getGenesisHash:()=>track(()=>rpc.getGenesisHash()),getSlot:(...a)=>track(()=>rpc.getSlot(...a)),getMultipleAccountsInfoAndContext:(...a)=>track(()=>rpc.getMultipleAccountsInfoAndContext(...a)),getSignaturesForAddress:(...a)=>track(()=>rpc.getSignaturesForAddress(...a)),
    getTransaction:((...a:Parameters<MiningTaxQuoteRpc['getTransaction']>)=>track(()=>rpc.getTransaction(...a))) as MiningTaxQuoteRpc['getTransaction'],getBlock:((...a:Parameters<MiningTaxQuoteRpc['getBlock']>)=>track(()=>rpc.getBlock(...a))) as MiningTaxQuoteRpc['getBlock'],
    getLatestBlockhashAndContext:(...a)=>track(()=>rpc.getLatestBlockhashAndContext(...a)),getFeeForMessage:(...a)=>track(()=>rpc.getFeeForMessage(...a)),getMinimumBalanceForRentExemption:(...a)=>track(()=>rpc.getMinimumBalanceForRentExemption(...a)),getBlockHeight:(...a)=>track(()=>rpc.getBlockHeight(...a))};
  };
  const work=(async()=>{
   const lookup={wallet:k.wallet,idempotencyKey:k.idempotencyKey},signed=await getMiningTaxClaimSigned(db,lookup);alive();
   // The custody reader also audits a preparation whose wire roster is empty.
   const wire=signed?.wires.find(w=>w.ordinal===k.ordinal);if(!signed||requireSigned&&!wire)fail(requireSigned?'NOT_SIGNED':'NOT_PREPARED');
   if(await hasMiningTaxClaimContinuation(db,lookup))fail('CONTINUED');alive();
   const a=signed.preparation,selected=a.transactions[k.ordinal];if(!selected)fail(requireSigned?'NOT_SIGNED':'NOT_PREPARED');
   const active=()=>{alive();if(!phaseEMiningEnabled())fail('DISABLED');const at=now();if(!(at instanceof Date)||!Number.isFinite(+at))fail('SOURCE_CONFLICT');if(+at<Date.parse(a.preparedAt)||+at>=Date.parse(a.expiresAt))fail('EXPIRED');return new Date(+at);};active();
   const saved=await getMiningTaxClaimPreparationRecord(db,lookup);active();if(!saved)fail('SOURCE_CONFLICT');
   let paidFee=0n,paidRent=0n;
   if(k.ordinal===1){const setup=await getMiningTaxClaimSettlement(db,{...lookup,ordinal:0});active();if(!setup||setup.receipt.phase!=='setup'||setup.claimFinalized)fail('SETUP_REQUIRED');paidFee=BigInt(setup.receipt.feeLamports);paidRent=BigInt(setup.receipt.rentLamports);}
   const caps={maxFeeLamports:BigInt(a.caps.maxFeeLamports)-paidFee,maxRentLamports:BigInt(a.caps.maxRentLamports)-paidRent,maxTotalLamports:BigInt(a.caps.maxTotalLamports)-paidFee-paidRent};if(Object.values(caps).some(v=>v<0n))fail('COST_CAP');
   const q=await createMiningTaxQuoteReader(trackedConnect,trust,{timeoutMs:timeout})({wallet:new PublicKey(k.wallet),round:BigInt(a.round),spot:a.spot,caps});active();
   if(q.blockHeight>a.lastValidBlockHeight)fail('EXPIRED');if(q.blockHeight<a.blockHeight)fail('SOURCE_CONFLICT');
   if(q.source.genesisHash!==a.source.genesisHash||q.source.programId!==a.source.programId||q.source.reviewedDeploymentSlot!==a.source.reviewedDeploymentSlot||q.source.reviewedProgramDataSha256!==a.source.reviewedProgramDataSha256||q.snapshot.slot<Math.max(a.source.snapshotSlot,a.source.blockhashSlot))fail('SOURCE_CONFLICT');
   const t=q.snapshot.term,b=saved.snapshot.term;
   for(const field of ['term','registry','registryHash','winnerCount','auctionStart','auctionEnd','operatingStart','operatingEnd','completedAt','completedSlot'] as const)if(t[field]!==b[field])fail('SOURCE_CONFLICT');
   if(t.auctions[a.spot]?.winner!==a.wallet||q.snapshot.chainClock.unixTimestamp<saved.snapshot.chainClock.unixTimestamp)fail('SOURCE_CONFLICT');
   // A fresh blockhash is a measurement input only. Rebuild every remaining
   // packet with the saved blockhash and require byte-for-byte original intent.
   const plan=buildMiningTaxMessages(trust.mining,q.snapshot,{wallet:new PublicKey(a.wallet),round:BigInt(a.round),spot:a.spot,blockhash:a.blockhash}),remaining=a.transactions.slice(k.ordinal);
   if(plan.expectedClaimBaseUnits!==BigInt(a.intended.claimBaseUnits)||plan.cumulativeBaseUnits!==BigInt(a.intended.cumulativeBaseUnits)||plan.dustBaseUnits!==BigInt(a.intended.dustBaseUnits)||plan.transactions.length!==remaining.length)fail('SOURCE_CONFLICT');
   for(const [i,tx] of plan.transactions.entries()){const prior=remaining[i]!;if(tx.kind!==prior.kind||tx.messageSha256!==prior.messageSha256||Buffer.from(tx.messageBytes).toString('hex')!==prior.messageHex||tx.packetBytes!==prior.packetBytes||tx.expectedNewAccounts.length!==prior.newAccounts.length||tx.expectedNewAccounts.some((account,n)=>account.address!==prior.newAccounts[n]!.address||account.space!==prior.newAccounts[n]!.space))fail('SOURCE_CONFLICT');}
   const rpc=trackedConnect(controller.signal),measurements:MiningTaxCostQuote[]=[];let feeSlot=q.snapshot.slot;
   for(const [i,tx] of plan.transactions.entries()){
    const fee=await rpc.getFeeForMessage(Message.from(tx.messageBytes),'finalized');active();const slot=safe(fee?.context?.slot);if(slot<feeSlot)fail('SOURCE_CONFLICT');feeSlot=slot;
    measurements.push({messageSha256:tx.messageSha256,feeLamports:BigInt(safe(fee.value)),rents:q.measurements[i]!.rents});
   }
   const costs=quoteMiningTaxMessageCosts(plan,measurements,caps),blockHeight=safe(await rpc.getBlockHeight('finalized'));active();if(blockHeight>a.lastValidBlockHeight)fail('EXPIRED');if(blockHeight<Math.max(q.blockHeight,a.blockHeight))fail('SOURCE_CONFLICT');
   if(await rpc.getGenesisHash()!==trust.mining.expectedGenesisHash)fail('SOURCE_CONFLICT');const observedAt=active().toISOString(),cost=costs.transactions[0]!;
   const review:MiningTaxClaimReview=freeze({...k,status:'ready',claimId:a.claimId,messageSha256:selected.messageSha256,blockhash:a.blockhash,preparedAt:a.preparedAt,expiresAt:a.expiresAt,observedAt,
    feeLamports:cost.feeLamports,rentLamports:cost.rentLamports,totalLamports:cost.totalLamports,paidFeeLamports:paidFee,paidRentLamports:paidRent,
    source:{genesisHash:q.source.genesisHash,programId:q.source.programId,reviewedDeploymentSlot:q.source.reviewedDeploymentSlot,reviewedProgramDataSha256:q.source.reviewedProgramDataSha256,snapshotSlot:q.snapshot.slot,feeSlot,blockHeight,lastValidBlockHeight:a.lastValidBlockHeight},
    currentSigningAuthorized:false as const,relayAuthorized:false as const,settlementAuthorized:false as const});
   if(await hasMiningTaxClaimContinuation(db,lookup))fail('CONTINUED');active();
   return project(review,wire);
  })().catch(e=>{if(e instanceof MiningTaxClaimAdmissionError)throw e;if(controller.signal.aborted||e instanceof MiningTaxQuoteError&&e.code==='TIMEOUT'||e instanceof MiningTaxSnapshotError&&e.code==='TIMEOUT')fail('TIMEOUT');if(e instanceof MiningTaxMessageError&&e.code==='COST_CAP')fail('COST_CAP');if(e instanceof MiningTaxQuoteError||e instanceof MiningTaxSnapshotError||e instanceof MiningTaxMessageError)fail('QUOTE_UNAVAILABLE');fail('SOURCE_CONFLICT');});
  const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxClaimAdmissionError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
  pending.set(id,reply);release=()=>{if(workDone&&outstanding.size===0&&pending.get(id)===reply)pending.delete(id);};const done=()=>{workDone=true;controller.abort();release();};void work.then(done,done);return reply;
 };
}
