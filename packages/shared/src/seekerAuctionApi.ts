/** Strict Seeker auction transport, subpath-only. Parsed JSON is not chain proof.
 * Calendar/mint/amount facts are supplied by the finalized server read model. */
import { z } from 'zod';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from './constants';
const P=PHASE_E_POLICY.seekerIsland;
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', b64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base58(value:string,length:number):boolean {
 if(!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
 let n=0n; for(const c of value) n=n*58n+BigInt(alphabet.indexOf(c));
 let bytes=0; while(n){bytes++;n>>=8n;}
 return bytes+(value.match(/^1*/)?.[0].length??0)===length;
}
const Address=z.string().min(32).max(44).refine(v=>base58(v,32));
const Signature=z.string().min(64).max(88).refine(v=>base58(v,64)&&!/^[1]+$/.test(v));
const isU64=(v:string)=>v.length<=20&&/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)<(1n<<64n);
const U64=z.string().max(20).refine(isU64);
const isI64=(v:string)=>v.length<=20&&/^(0|-?[1-9][0-9]*)$/.test(v)&&BigInt(v)>=-(1n<<63n)&&BigInt(v)<(1n<<63n);
const I64=z.string().max(20).refine(isI64);
function encoded(maxBytes:number,minBytes=1) {
 return z.string().max(Math.ceil(maxBytes/3)*4).refine(v=>{
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))return false;
  const padding=v.endsWith('==')?2:v.endsWith('=')?1:0, bytes=v.length/4*3-padding;
  return bytes>=minBytes&&bytes<=maxBytes&&(padding===0||(b64.indexOf(v[v.length-padding-1]!)&((1<<(padding*2))-1))===0);
 });
}
const Spot=z.number().int().min(0).max(P.totalSpots-1);
const Count=z.number().int().min(0).max(P.totalSpots);
const issue=(ctx:z.RefinementCtx,message:string)=>ctx.addIssue({code:'custom',message});
const Config=z.object({programId:Address,address:Address,mint:Address,prizeOwner:Address,prizeAta:Address,
 decimals:z.number().int().min(0).max(255),openingBidRaw:U64,firstOperatingStart:I64,termSec:U64,auctionSec:U64,graceSec:U64}).strict();
const Row=z.object({spot:Spot,class:z.enum(['king','regular']),realmMask:z.number().int().min(0).max((1<<P.realmCount)-1),
 opened:z.boolean(),highBidRaw:U64,highBidder:Address.nullable(),settled:z.boolean(),yourBidRaw:U64,refundable:z.boolean()}).strict();
export const SeekerAuctionRoundViewSchema=z.object({version:z.literal(1),source:z.enum(['chain','fixture']).optional(),chainUnixTime:I64.optional(),walletSkrRaw:U64.nullable().optional(),wallet:Address,observedSlot:U64,round:U64,biddingRound:U64,
 admissionPaused:z.boolean(),config:Config,auctionStart:I64,auctionEnd:I64,operatingStart:I64,operatingEnd:I64,
 openedCount:Count,completedCount:Count,winnerCount:Count,completedAt:I64.nullable(),spots:z.array(Row).length(P.totalSpots)}).strict().superRefine((v,ctx)=>{
 const c=v.config;
 if(![v.round,v.biddingRound,v.observedSlot,c.openingBidRaw,c.termSec,c.auctionSec,c.graceSec,...v.spots.flatMap(s=>[s.highBidRaw,s.yourBidRaw])].every(isU64)
  ||![c.firstOperatingStart,v.auctionStart,v.auctionEnd,v.operatingStart,v.operatingEnd,...(v.completedAt===null?[]:[v.completedAt])].every(isI64))return;
 const start=BigInt(c.firstOperatingStart)+BigInt(v.round)*BigInt(c.termSec);
 if(BigInt(c.termSec)<=0n||BigInt(c.auctionSec)<=0n||BigInt(c.auctionSec)>BigInt(c.termSec)||BigInt(c.openingBidRaw)<=0n
  ||BigInt(v.operatingStart)!==start||BigInt(v.auctionEnd)!==start||BigInt(v.auctionStart)!==start-BigInt(c.auctionSec)
  ||BigInt(v.operatingEnd)!==start+BigInt(c.termSec))issue(ctx,'inconsistent chain calendar');
 if(v.openedCount!==v.spots.filter(s=>s.opened).length||v.completedCount!==v.spots.filter(s=>s.settled).length
  ||v.winnerCount!==v.spots.filter(s=>s.settled&&s.highBidder!==null).length)issue(ctx,'inconsistent progress');
 if((v.completedAt!==null)!==(v.completedCount===P.totalSpots)||v.completedAt!==null&&BigInt(v.completedAt)<BigInt(v.auctionEnd))issue(ctx,'inconsistent completion');
 v.spots.forEach((s,i)=>{
  let mask=0; for(let n=0;n<PHASE_E_SEEKER_AUCTION.regularRealmCount;n++)mask|=1<<((i-P.kingSpots+n)%P.realmCount);
  if(i<P.kingSpots)mask=(1<<P.realmCount)-1;
  if(s.spot!==i||s.class!==(i<P.kingSpots?'king':'regular')||s.realmMask!==mask)issue(ctx,'noncanonical spot order/mapping');
  if((s.highBidRaw==='0')!==(s.highBidder===null)||s.highBidder!==null&&BigInt(s.highBidRaw)<BigInt(c.openingBidRaw))issue(ctx,'bid amount/bidder mismatch');
  if(!s.opened&&(s.settled||s.highBidRaw!=='0'||s.yourBidRaw!=='0'))issue(ctx,'unopened auction state');
  if(s.refundable!==(s.yourBidRaw!=='0'&&s.highBidder!==v.wallet))issue(ctx,'inconsistent refund');
 });
});
/** IS-S1/V-M3 binding boundary. Clock is finalized chain seconds; null balance
 * means the canonical wallet ATA is absent, while "0" is an existing empty ATA.
 * Legacy unlabeled objects remain parseable above only
 * for stored schema fixtures; clients must not label those objects as chain. */
export const SeekerAuctionSourcedRoundViewSchema=SeekerAuctionRoundViewSchema.safeExtend({source:z.enum(['chain','fixture']),chainUnixTime:I64,walletSkrRaw:U64.nullable()});
export const SeekerBidPrepareRequestSchema=z.object({round:U64,spot:Spot,newTotalRaw:U64.refine(v=>v!=='0')}).strict();
export const SeekerWithdrawPrepareRequestSchema=z.object({round:U64,spot:Spot}).strict();
export const SeekerAuctionPreparedSchema=z.object({messageBase64:encoded(1232),blockhash:Address,lastValidBlockHeight:U64,
 incrementRaw:U64,networkFeeLamports:U64,newAccountRentLamports:U64}).strict();
export const SeekerAuctionSubmitRequestSchema=z.union([z.object({signedTransaction:encoded(1232,66)}).strict(),z.object({signature:Signature}).strict()]);
export const SeekerAuctionTxStatusSchema=z.object({signature:Signature,status:z.enum(['pending','finalized','failed']),slot:U64.nullable(),
 error:z.literal('CHAIN_TRANSACTION_FAILED').nullable(),found:z.boolean().optional(),finalizedBlockHeight:U64.optional()}).strict().superRefine((v,ctx)=>{
 if(v.status==='pending'&&(v.slot!==null||v.error!==null)||v.status==='finalized'&&(v.slot===null||v.error!==null)
  ||v.status==='failed'&&(v.slot===null||v.error===null))issue(ctx,'inconsistent finalized status');
 if((v.found===undefined)!==(v.finalizedBlockHeight===undefined)||v.found===false&&v.status!=='pending')issue(ctx,'inconsistent height observation');
});
export type SeekerAuctionRoundView=z.infer<typeof SeekerAuctionRoundViewSchema>;
export type SeekerAuctionSourcedRoundView=z.infer<typeof SeekerAuctionSourcedRoundViewSchema>;
export type SeekerBidPrepareRequest=z.infer<typeof SeekerBidPrepareRequestSchema>;
export type SeekerWithdrawPrepareRequest=z.infer<typeof SeekerWithdrawPrepareRequestSchema>;
export type SeekerAuctionPrepared=z.infer<typeof SeekerAuctionPreparedSchema>;
export type SeekerAuctionSubmitRequest=z.infer<typeof SeekerAuctionSubmitRequestSchema>;
export type SeekerAuctionTxStatus=z.infer<typeof SeekerAuctionTxStatusSchema>;
