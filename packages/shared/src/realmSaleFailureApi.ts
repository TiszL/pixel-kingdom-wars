/** Historical owner-attestation consistency only. finalityVerified is the
 * server assertion, not independent browser finality or archival authority.
 * Canonical ABI, hashes, Ed25519 and PDAs require a separate trusted binder.
 * Subpath only; no chain, Node or wallet dependency. */
import {z} from 'zod';
import {RealmSalePreparationSchema,RealmSaleSignedWireSchema} from './realmSalesApi';
const P=RealmSalePreparationSchema.shape,W=RealmSaleSignedWireSchema.shape,Count=P.source.shape.admissionSlot,Amount=P.terms.shape.round,Hash=P.quote.shape.messageSha256;
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111',CLOCK='SysvarC1ock11111111111111111111111111111111',SYSVAR='Sysvar1111111111111111111111111111111111111';
const clock=(value:string)=>value.length<=19&&/^[1-9][0-9]*$/.test(value)&&BigInt(value)<=9223372036854775807n;
const Account=z.object({address:P.wallet,exists:z.literal(true),owner:P.wallet,executable:z.boolean(),dataSha256:Hash}).strict();
const Accounts=z.preprocess(v=>Array.isArray(v)&&v.length===3?v:null,z.array(Account).length(3));
export const RealmSaleFailureReceiptSchema=z.object({version:z.literal(1),wallet:P.wallet,saleId:P.saleId,spot:P.spot,realm:P.realm,round:P.terms.shape.round,day:P.terms.shape.day,
 signature:W.signature,originalMessageSha256:Hash,signedTransactionSha256:Hash,slot:Count,blockTime:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),feeLamports:Amount,
 actualRentLamports:z.literal('0'),buyerNetPaymentLamports:z.literal('0'),accessChanged:z.literal(false),quotaConsumed:z.literal(false),observedAccountSlot:Count,proofClockUnixTimestamp:z.string().max(19).refine(clock),
 source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),stateProvenance:z.literal('fresh-reviewed-deployment'),genesisHash:P.wallet,programId:P.wallet,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:Hash,upgradeAuthority:P.wallet.nullable(),accounts:Accounts}).strict(),
 outcome:z.literal('failed'),transactionFailed:z.literal(true),finalityVerified:z.literal(true),paymentAuthorized:z.literal(false),admissionAuthorized:z.literal(false),signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),journalClearingAuthorized:z.literal(false),
}).strict().superRefine((r,ctx)=>{
 if(r.slot<=r.source.reviewedDeploymentSlot||r.observedAccountSlot<r.slot||clock(r.proofClockUnixTimestamp)&&r.blockTime!==null&&Number.isSafeInteger(r.blockTime)&&BigInt(r.proofClockUnixTimestamp)<BigInt(r.blockTime))ctx.addIssue({code:'custom',message:'Failure observation order differs'});
});
export const RealmSaleFailureSchema=z.object({wallet:P.wallet,idempotencyKey:P.idempotencyKey,saleId:P.saleId,receipt:RealmSaleFailureReceiptSchema,verifiedAt:W.acceptedAt,transactionFailed:z.literal(true),purchaseFinalized:z.literal(false),journalClearingAuthorized:z.literal(false)}).strict().superRefine((f,ctx)=>{
 if(f.wallet!==f.receipt.wallet||f.saleId!==f.receipt.saleId)ctx.addIssue({code:'custom',message:'Failure owner or original sale differs'});
});
export type RealmSaleFailureView=z.infer<typeof RealmSaleFailureSchema>;
export const RealmSaleFailureEnvelopeSchema=z.object({wallet:P.wallet,idempotencyKey:P.idempotencyKey,failure:RealmSaleFailureSchema.nullable()}).strict().superRefine((v,ctx)=>{
 if(v.failure&&(v.failure.wallet!==v.wallet||v.failure.idempotencyKey!==v.idempotencyKey))ctx.addIssue({code:'custom',message:'Failure belongs to another request'});
});
export type RealmSaleFailureEnvelope=z.infer<typeof RealmSaleFailureEnvelopeSchema>;
function freeze<T>(v:T):T{if(v!==null&&typeof v==='object'){for(const value of Object.values(v))freeze(value);Object.freeze(v);}return v;}
/** Own all parsed facts, then compare the original consent and wire. The original
 * preparation does not pin upgradeAuthority; this grammar checks its syntax.
 * Actual failed execution fee is historical and may exceed the quote estimate. */
export function validateRealmSaleFailure(preparation:unknown,wireMetadata:unknown,raw:unknown):RealmSaleFailureView{
 const p=RealmSalePreparationSchema.parse(preparation),w=RealmSaleSignedWireSchema.parse(wireMetadata),f=RealmSaleFailureSchema.parse(raw),r=f.receipt,s=r.source;
 const refuse=()=>{throw new Error('Realm sale failure does not match original consent');};
 if(f.wallet!==p.wallet||f.idempotencyKey!==p.idempotencyKey||f.saleId!==p.saleId||w.wallet!==p.wallet||w.idempotencyKey!==p.idempotencyKey||w.saleId!==p.saleId
  ||r.spot!==p.spot||r.realm!==p.realm||r.round!==p.terms.round||r.day!==p.terms.day||r.signature!==w.signature||r.originalMessageSha256!==p.quote.messageSha256||w.messageSha256!==p.quote.messageSha256||r.signedTransactionSha256!==w.wireSha256||w.signedTransactionHex.slice(130)!==p.quote.messageHex)refuse();
 if(s.genesisHash!==p.source.genesisHash||s.programId!==p.source.programId||s.reviewedDeploymentSlot!==p.source.reviewedDeploymentSlot||s.reviewedProgramDataSha256!==p.source.programDataSha256||r.slot<p.source.admissionSlot)refuse();
 if(new Set(s.accounts.map(a=>a.address)).size!==3||s.accounts[0]!.address!==p.source.programId||s.accounts[1]!.dataSha256!==p.source.programDataSha256||s.accounts[2]!.address!==CLOCK)refuse();
 for(const [i,a]of s.accounts.entries())if(a.owner!==(i<2?LOADER:SYSVAR)||a.executable!==(i===0))refuse();
 return freeze(f);
}
