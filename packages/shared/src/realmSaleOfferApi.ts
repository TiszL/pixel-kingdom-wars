/** Current observations for purchase display. Neither DTO authorizes payment,
 * signing, journal clearing or expedition departure. Keep this subpath only. */
import {z} from 'zod';
import {PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from './constants';
import {REALM_IDS,REALM_NAMES} from './baseVisual';
const P=PHASE_E_POLICY.seekerIsland,U64=(1n<<64n)-1n,I64=(1n<<63n)-1n;
/** Chain realm indices follow the accepted Phase E catalog order explicitly. */
export const REALM_SALE_REALMS=Object.freeze(REALM_IDS.map((id,index)=>Object.freeze({index,id,name:REALM_NAMES[id]})));
const Address=z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),Hash=z.string().length(64).regex(/^[0-9a-f]{64}$/);
const Count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),Spot=Count.max(P.totalSpots-1),Realm=Count.max(P.realmCount-1);
const queryIndex=(max:number)=>z.string().max(String(max).length).regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(Count.max(max));
export const RealmSaleOfferQuerySchema=z.object({spot:queryIndex(P.totalSpots-1),realm:queryIndex(P.realmCount-1)}).strict();
export const RealmSaleCoverageQuerySchema=z.object({realm:queryIndex(P.realmCount-1)}).strict();
export const RealmSaleOfferSelectionSchema=z.object({spot:Spot,realm:Realm}).strict();
export const RealmSaleCoverageSelectionSchema=z.object({realm:Realm}).strict();
const valid=(s:string,max=U64)=>s.length<=20&&/^(0|[1-9][0-9]{0,19})$/.test(s)&&BigInt(s)<=max;
const Amount=z.string().max(20).refine(v=>valid(v)),Timestamp=Amount.refine(v=>valid(v,I64));
const Source=z.object({revision:z.string().min(1).max(128),genesisHash:Address,programId:Address,reviewedDeploymentSlot:Count,programDataSha256:Hash}).strict();
const Offer=z.object({source:Source,slot:Count,unixTimestamp:Timestamp,round:Amount,day:Amount,seller:Address,developer:Address,priorExpiry:Timestamp,validUntil:Timestamp,
 quotaRemaining:Count.min(1).max(P.paidContractsPerSpotDayMax),priceLamports:Amount,sellerLamports:Amount,developerLamports:Amount,durationSec:z.literal(P.permitDurationSec),
 feeLamports:Amount,rentLamports:Amount,paymentDebitLamports:Amount,requiredLamports:Amount,payerLamports:Amount}).strict();
const common={version:z.literal(PHASE_E_SEEKER_SALE.version),wallet:Address,spot:Spot,realm:Realm,authorization:z.literal('none')};
export const RealmSaleOfferSchema=z.discriminatedUnion('status',[
 z.object({...common,status:z.literal('available'),reason:z.null(),offer:Offer}).strict(),
 z.object({...common,status:z.literal('blocked'),reason:z.enum(['PAUSED','UNSOLD','REALM','NO_QUOTA','INSUFFICIENT_SOL']),offer:z.null()}).strict(),
 z.object({...common,status:z.literal('unavailable'),reason:z.literal('SOURCE_UNAVAILABLE'),offer:z.null()}).strict(),
]).superRefine((v,ctx)=>{
 if(v.status!=='available')return;const o=v.offer;
 if([o.unixTimestamp,o.round,o.day,o.priorExpiry,o.validUntil,o.priceLamports,o.sellerLamports,o.developerLamports,o.feeLamports,o.rentLamports,o.paymentDebitLamports,o.requiredLamports,o.payerLamports].some(n=>!valid(n)))return;
 const bad=(message:string)=>ctx.addIssue({code:'custom',message}),price=BigInt(P.permitPriceLamports),bps=BigInt(PHASE_E_POLICY.basisPoints),seller=price*BigInt(P.contractSellerBps)/bps,developer=price*BigInt(P.contractDevBps)/bps;
 const payment=price-(o.seller===v.wallet?seller:0n)-(o.developer===v.wallet?developer:0n),required=payment+BigInt(o.feeLamports)+BigInt(o.rentLamports);
 if(BigInt(o.priceLamports)!==price||BigInt(o.sellerLamports)!==seller||BigInt(o.developerLamports)!==developer||BigInt(o.paymentDebitLamports)!==payment||BigInt(o.requiredLamports)!==required||required>BigInt(o.payerLamports))bad('inconsistent observed purchase cost');
 const now=BigInt(o.unixTimestamp),until=BigInt(o.validUntil),day=BigInt(o.day),daySec=BigInt(PHASE_E_MINING_PUBLICATION.daySec),prior=BigInt(o.priorExpiry),dayEnd=(day+1n)*daySec-1n,latest=until<dayEnd?until:dayEnd;
 if(now<=0n||now/daySec!==day||until<now||until-now>BigInt(PHASE_E_SEEKER_SALE.quoteTtlSec)||o.slot<o.source.reviewedDeploymentSlot||(prior>latest?prior:latest)+BigInt(P.permitDurationSec)>I64)bad('inconsistent observed source window');
});
const Coverage=z.object({address:Address,accountState:z.enum(['absent','uninitialized','initialized']),slot:Count,unixTimestamp:Timestamp,expiresAt:Timestamp.nullable(),active:z.boolean(),source:Source}).strict().superRefine((v,ctx)=>{
 if(!valid(v.unixTimestamp)||v.expiresAt!==null&&!valid(v.expiresAt))return;
 if((v.accountState==='initialized')!==(v.expiresAt!==null)||v.active!==(v.expiresAt!==null&&BigInt(v.expiresAt)>BigInt(v.unixTimestamp))||BigInt(v.unixTimestamp)<=0n||v.slot<v.source.reviewedDeploymentSlot)ctx.addIssue({code:'custom',message:'inconsistent current coverage observation'});
});
const coverageCommon={version:z.literal(PHASE_E_SEEKER_SALE.version),wallet:Address,realm:Realm,authorization:z.literal('none')};
export const RealmSaleCoverageSchema=z.discriminatedUnion('status',[
 z.object({...coverageCommon,status:z.literal('observed'),coverage:Coverage}).strict(),
 z.object({...coverageCommon,status:z.literal('unavailable'),coverage:z.null()}).strict(),
]);
export type RealmSaleOfferView=z.infer<typeof RealmSaleOfferSchema>;
export type RealmSaleCoverageView=z.infer<typeof RealmSaleCoverageSchema>;
