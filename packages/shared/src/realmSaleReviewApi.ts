/** Read-only measured review of ORIGINAL consent. These observations can become
 * stale immediately; they authorize no signing, payment, submission or reservation. */
import {z} from 'zod';
import {PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from './constants';
import {RealmSalePreparationSchema} from './realmSalesApi';
const U64=(1n<<64n)-1n,I64=(1n<<63n)-1n;
function unsigned(value:string,max=U64):bigint|null{if(value.length>20||!/^(0|[1-9][0-9]{0,19})$/.test(value))return null;const n=BigInt(value);return n<=max?n:null;}
const Amount=z.string().max(20).refine(v=>unsigned(v)!==null),Timestamp=Amount.refine(v=>unsigned(v,I64)!==null);
const Address=z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),Id=z.uuid().refine(v=>v===v.toLowerCase());
const Hash=z.string().length(64).regex(/^[0-9a-f]{64}$/),Count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Rent=z.object({address:Address,lamports:Amount}).strict();
// Zod's array length check runs after its elements. Refuse oversized arrays first.
const Rents=z.preprocess(v=>Array.isArray(v)&&v.length<=3?v:null,z.array(Rent).min(1).max(3));
export const RealmSaleReviewSchema=z.object({
 version:z.literal(PHASE_E_SEEKER_SALE.version),saleId:z.string().length(32).regex(/^[0-9a-f]{32}$/).refine(v=>v!=='00'.repeat(16)),wallet:Address,idempotencyKey:Id,
 messageSha256:Hash,sourceRevision:z.string().min(1).max(128),snapshotHash:Hash,
 quoteSlot:Count,unixTimestamp:Timestamp,validUntil:Timestamp,feeSlot:Count,bracketSlot:Count,blockHeight:Count,
 feeLamports:Amount,rentLamports:Amount,paymentDebitLamports:Amount,requiredLamports:Amount,payerLamports:Amount,
 quotaRemaining:Count.min(1).max(PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax),rents:Rents,
 admissionEligible:z.literal(true),signingAuthorized:z.literal(false),paymentAuthorized:z.literal(false),submissionAuthorized:z.literal(false),reservation:z.literal(false),
}).strict().superRefine((v,ctx)=>{
 const issue=(message:string)=>ctx.addIssue({code:'custom',message});
 const amounts=[v.unixTimestamp,v.validUntil,v.feeLamports,v.rentLamports,v.paymentDebitLamports,v.requiredLamports,v.payerLamports,...v.rents.map(r=>r.lamports)];
 if(amounts.some(n=>unsigned(n)===null))return;
 if(v.quoteSlot>v.feeSlot||v.feeSlot>v.bracketSlot||BigInt(v.unixTimestamp)>BigInt(v.validUntil))issue('inconsistent observation order');
 if(new Set(v.rents.map(r=>r.address)).size!==v.rents.length)issue('duplicate observed rent account');
 const rent=v.rents.reduce((n,r)=>n+BigInt(r.lamports),0n),required=rent+BigInt(v.feeLamports)+BigInt(v.paymentDebitLamports);
 if(rent!==BigInt(v.rentLamports)||required!==BigInt(v.requiredLamports)||required>BigInt(v.payerLamports))issue('inconsistent measured SOL costs');
});
export type RealmSaleReviewView=z.infer<typeof RealmSaleReviewSchema>;
/** Parse both sides into owned copies and bind observations to the immutable
 * actor request and approved maxima. Cryptographic message checks remain with
 * the signer; parsing a review never changes the original consent or authority. */
export function validateRealmSaleReview(preparation:unknown,raw:unknown):RealmSaleReviewView{
 const p=RealmSalePreparationSchema.parse(preparation),r=RealmSaleReviewSchema.parse(raw),q=p.quote;
 const refuse=()=>{throw new Error('Realm sale review does not match original consent');};
 if(r.wallet!==p.wallet||r.idempotencyKey!==p.idempotencyKey||r.saleId!==p.saleId||r.messageSha256!==q.messageSha256||r.sourceRevision!==p.source.revision||r.validUntil!==p.terms.validUntil
  ||BigInt(r.unixTimestamp)/BigInt(PHASE_E_MINING_PUBLICATION.daySec)!==BigInt(p.terms.day)||BigInt(r.unixTimestamp)<BigInt(p.terms.validAfter)||BigInt(r.unixTimestamp)>BigInt(p.terms.validUntil)||r.quoteSlot<p.source.admissionSlot||r.blockHeight>q.lastValidBlockHeight)refuse();
 const caps=new Map(q.rents.map(cap=>[cap.address,BigInt(cap.maxIncreaseLamports)]));
 if(r.rents.length!==caps.size)refuse();
 for(const rent of r.rents){const cap=caps.get(rent.address);if(cap===undefined||BigInt(rent.lamports)>cap)refuse();}
 if(r.paymentDebitLamports!==q.paymentDebitLamports||BigInt(r.feeLamports)>BigInt(q.feeLamports)||BigInt(r.rentLamports)>BigInt(q.rentLamports)||BigInt(r.requiredLamports)>BigInt(q.requiredLamports))refuse();
 return r;
}
