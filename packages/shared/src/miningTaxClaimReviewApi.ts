/** Current observations of immutable tax consent, subpath only. No cryptographic
 * proof, current signing capability, finality or permission to clear a journal. */
import {z} from 'zod';
import {MiningTaxClaimPreparationSchema} from './miningTaxClaimsApi';
const P=MiningTaxClaimPreparationSchema.shape,Count=P.blockHeight,Amount=P.caps.shape.maxFeeLamports,Iso=P.preparedAt;
const issue=(ctx:z.RefinementCtx,message:string)=>ctx.addIssue({code:'custom',message});
export const MiningTaxClaimReviewReasonSchema=z.enum(['INVALID_INPUT','NOT_PREPARED','NOT_SIGNED','SETUP_REQUIRED','DISABLED','EXPIRED','SOURCE_CONFLICT','QUOTE_UNAVAILABLE','COST_CAP','BUSY','TIMEOUT','PROVIDER_UNAVAILABLE','CONTINUED']);
export const MiningTaxClaimReviewSchema=z.object({
 wallet:P.wallet,idempotencyKey:P.idempotencyKey,claimId:P.claimId,ordinal:Count.max(1),status:z.literal('ready'),messageSha256:P.identity.shape.registryHash,
 blockhash:P.blockhash,preparedAt:Iso,expiresAt:Iso,observedAt:Iso,
 feeLamports:Amount,rentLamports:Amount,totalLamports:Amount,paidFeeLamports:Amount,paidRentLamports:Amount,
 source:z.object({genesisHash:P.source.shape.genesisHash,programId:P.source.shape.programId,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:P.source.shape.reviewedProgramDataSha256,
  snapshotSlot:Count,feeSlot:Count,blockHeight:Count,lastValidBlockHeight:Count}).strict(),
 currentSigningAuthorized:z.literal(false),relayAuthorized:z.literal(false),settlementAuthorized:z.literal(false),
}).strict().superRefine((r,ctx)=>{
 if(Date.parse(r.observedAt)<Date.parse(r.preparedAt)||Date.parse(r.observedAt)>=Date.parse(r.expiresAt))issue(ctx,'review is outside original consent');
 if(r.source.snapshotSlot<r.source.reviewedDeploymentSlot||r.source.feeSlot<r.source.snapshotSlot||r.source.blockHeight>r.source.lastValidBlockHeight)issue(ctx,'review observation order differs');
 // Nested refinements may fail while Zod checks siblings. Do not convert invalid
 // amounts, even when an unrelated field has already made the document invalid.
 if([r.feeLamports,r.rentLamports,r.totalLamports,r.paidFeeLamports,r.paidRentLamports].some(v=>!Amount.safeParse(v).success))return;
 if(BigInt(r.feeLamports)+BigInt(r.rentLamports)!==BigInt(r.totalLamports))issue(ctx,'selected cost does not conserve SOL');
});
export const MiningTaxClaimReviewResponseSchema=z.object({wallet:P.wallet,idempotencyKey:P.idempotencyKey,ordinal:Count.max(1),status:z.enum(['ready','unavailable']),
 review:MiningTaxClaimReviewSchema.nullable(),reason:MiningTaxClaimReviewReasonSchema.optional(),serverNow:Iso}).strict().superRefine((v,ctx)=>{
 if(v.status==='unavailable'){if(v.review!==null||v.reason===undefined)issue(ctx,'unavailable review must be empty with a reason');return;}
 const r=v.review;if(!r||v.reason!==undefined){issue(ctx,'ready review requires observations without a refusal');return;}
 if(r.wallet!==v.wallet||r.idempotencyKey!==v.idempotencyKey||r.ordinal!==v.ordinal)issue(ctx,'review request identity differs');
 if(Date.parse(v.serverNow)<Date.parse(r.observedAt)||Date.parse(v.serverNow)>=Date.parse(r.expiresAt))issue(ctx,'response clock is outside original consent');
});
export type MiningTaxClaimReviewView=z.infer<typeof MiningTaxClaimReviewSchema>;
export type MiningTaxClaimReviewResponse=z.infer<typeof MiningTaxClaimReviewResponseSchema>;
export type MiningTaxClaimReviewReason=z.infer<typeof MiningTaxClaimReviewReasonSchema>;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
/** Bind both parsed copies to the saved request. Selected-packet costs plus
 * already-paid setup must fit explicit caps; the service separately assesses the
 * entire remaining plan. These declared facts neither verify setup finality nor
 * replace client message cryptography or a last-moment wallet lifecycle check. */
export function validateMiningTaxClaimCurrentReview(preparation:unknown,raw:unknown):MiningTaxClaimReviewResponse{
 const p=MiningTaxClaimPreparationSchema.parse(preparation),v=MiningTaxClaimReviewResponseSchema.parse(raw),tx=p.transactions[v.ordinal];
 const refuse=()=>{throw new Error('KEEP tax review does not match original consent');};
 if(v.wallet!==p.wallet||v.idempotencyKey!==p.idempotencyKey||!tx)refuse();
 const r=v.review;if(!r)return freeze(v);
 if(r.claimId!==p.claimId||r.messageSha256!==tx!.messageSha256||r.blockhash!==p.blockhash||r.preparedAt!==p.preparedAt||r.expiresAt!==p.expiresAt)refuse();
 const s=r.source,original=p.source;
 if(s.genesisHash!==original.genesisHash||s.programId!==original.programId||s.reviewedDeploymentSlot!==original.reviewedDeploymentSlot||s.reviewedProgramDataSha256!==original.reviewedProgramDataSha256
  ||s.snapshotSlot<Math.max(original.snapshotSlot,original.blockhashSlot)||s.blockHeight<p.blockHeight||s.lastValidBlockHeight!==p.lastValidBlockHeight)refuse();
 if(r.ordinal===0&&(r.paidFeeLamports!=='0'||r.paidRentLamports!=='0')||tx!.kind==='claim'&&r.rentLamports!=='0')refuse();
 const fee=BigInt(r.feeLamports)+BigInt(r.paidFeeLamports),rent=BigInt(r.rentLamports)+BigInt(r.paidRentLamports);
 if(fee>BigInt(p.caps.maxFeeLamports)||rent>BigInt(p.caps.maxRentLamports)||fee+rent>BigInt(p.caps.maxTotalLamports))refuse();
 return freeze(v);
}
