/** Public claimant-only contracts. No deployment attestations or signed wire.
 * Subpath-only: do not add this module to the shared first-paint barrel. */
import {z} from 'zod';
import {TOKEN,PHASE_E_MINING_CLAIM_QUOTE} from './constants';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(value:string,size:number):boolean{
 if(value.length<size||value.length>(size===32?44:88)||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value))return false;
 let n=0n;for(const c of value)n=n*58n+BigInt(alphabet.indexOf(c));let bytes=0;while(n){bytes++;n>>=8n;}return bytes+(value.match(/^1*/)?.[0].length??0)===size;
}
const Address=z.string().max(44).refine(v=>base58(v,32));
const Signature=z.string().max(88).refine(v=>base58(v,64)&&v!=='1'.repeat(64));
function amount(v:string):bigint|null{if(!/^(0|[1-9][0-9]{0,19})$/.test(v))return null;const n=BigInt(v);return n<(1n<<64n)?n:null;}
const Amount=z.string().max(20).refine(v=>amount(v)!==null),Positive=Amount.refine(v=>{const n=amount(v);return n!==null&&n>0n;});
const Count=z.number().int().nonnegative().safe(),Hash=z.string().regex(/^[0-9a-f]{64}$/),Id=z.uuid();
const Iso=z.string().max(27).refine(v=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.(?:\d{3}|\d{6})Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23));
function base64(v:string,maxBytes:number,minBytes=1):boolean{
 if(v.length>Math.ceil(maxBytes/3)*4||v.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))return false;
 const padding=v.endsWith('==')?2:v.endsWith('=')?1:0,bytes=v.length/4*3-padding;
 if(bytes<minBytes||bytes>maxBytes)return false;
 const last='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(v[v.length-padding-1]!);
 return padding===0||padding===1&&(last&3)===0||padding===2&&(last&15)===0;
}
const Message=z.string().max(1556).refine(v=>base64(v,1167)),Wire=z.string().max(1644).refine(v=>base64(v,1232,66));
const Kind=z.enum(['combined','setup','claim']);
const Reason=z.enum(['INVALID_WALLET','DISABLED','NOT_PROJECTED','SOURCE_UNAVAILABLE','SOURCE_CONFLICT','UNSUPPORTED_FRONTIER','BUSY','TIMEOUT']);
function issue(ctx:z.RefinementCtx,message:string){ctx.addIssue({code:'custom',message});}
export const MiningClaimPrepareRequestSchema=z.object({idempotencyKey:Id,profile:z.literal('ordered-v0').optional()}).strict();
export const MiningClaimSubmitRequestSchema=z.object({claimId:Id,signedTransaction:Wire}).strict();
export const MiningClaimStatusViewSchema=z.object({
 features:z.object({claims:z.object({version:z.literal(1),receipts:z.literal(1),ordered:z.literal(1).optional()}).strict()}).strict(),wallet:Address,program:z.literal('shardkeep-economy'),programId:Address.nullable(),keepMint:Address.nullable(),
 state:z.enum(['unavailable','no_allocation','ready','delayed','paused','revoked','claimed']),reason:Reason.nullable(),rootSequence:Positive.nullable(),
 cumulativeKeepBaseUnits:Amount.nullable(),claimedBaseUnits:Amount.nullable(),claimableBaseUnits:Amount.nullable(),decimals:z.literal(TOKEN.decimals),
 observedSlot:Count.nullable(),chainUnixTimestamp:Amount.nullable(),claimableAfterUnixTimestamp:Amount.nullable(),needsAta:z.boolean().nullable(),needsMinerRecords:z.boolean().nullable(),
 preparationAllowed:z.boolean(),claimSubmissionAuthorized:z.literal(false),serverNow:Iso,
}).strict().superRefine((v,ctx)=>{
 if((v.programId===null)!==(v.keepMint===null)||v.preparationAllowed!==(v.state==='ready'))issue(ctx,'inconsistent identity or admission');
 if(v.state==='unavailable'){
  if(v.reason===null||[v.rootSequence,v.cumulativeKeepBaseUnits,v.claimedBaseUnits,v.claimableBaseUnits,v.observedSlot,v.chainUnixTimestamp,v.claimableAfterUnixTimestamp,v.needsAta,v.needsMinerRecords].some(x=>x!==null))issue(ctx,'unavailable has no observed quantities');return;
 }
 if(v.reason!==null||v.rootSequence===null||v.observedSlot===null||v.chainUnixTimestamp===null)issue(ctx,'known state requires source observations');
 if(v.state==='no_allocation'||v.state==='revoked'){
  if(v.claimableBaseUnits!==(v.state==='no_allocation'?'0':null)||[v.cumulativeKeepBaseUnits,v.claimedBaseUnits,v.claimableAfterUnixTimestamp,v.needsAta,v.needsMinerRecords].some(x=>x!==null))issue(ctx,'unproved cumulative quantities');return;
 }
 if([v.cumulativeKeepBaseUnits,v.claimedBaseUnits,v.claimableBaseUnits,v.claimableAfterUnixTimestamp,v.needsAta,v.needsMinerRecords].some(x=>x===null)){issue(ctx,'missing allocation quantities');return;}
 const total=amount(v.cumulativeKeepBaseUnits!),paid=amount(v.claimedBaseUnits!),claimable=amount(v.claimableBaseUnits!),clock=amount(v.chainUnixTimestamp??''),after=amount(v.claimableAfterUnixTimestamp!);
 if(total===null||paid===null||claimable===null||clock===null||after===null)return;
 if(total===0n||paid+claimable!==total||(v.state==='claimed'?claimable!==0n:claimable===0n)||v.state==='ready'&&clock<after||v.state==='delayed'&&clock>=after)issue(ctx,'inconsistent allocation state');
});
const Leaf=z.object({wallet:Address,rootSequence:Positive,cumulativeKeepBaseUnits:Positive,cumulativeRenown:Amount,cumulativeDays:Amount}).strict();
const Proof=z.array(z.object({hash:Hash,sumBaseUnits:Amount,isLeft:z.boolean()}).strict()).max(16);
const Transaction=z.object({ordinal:Count.max(1),kind:Kind,version:z.literal('legacy'),message:Message,lookupTables:z.array(z.never()).length(0),feePayer:Address,blockhash:Address,lastValidBlockHeight:Count,feeLamports:Amount,rentLamports:Amount}).strict();
const LookupAccount=z.object({address:Address,owner:Address,executable:z.literal(false),dataHex:z.string().length(304).regex(/^[0-9a-f]+$/),slot:Count}).strict();
export const MiningClaimFormatSchema=z.object({version:z.literal(1),preset:z.literal('ordered-v0'),lookupTable:LookupAccount,
 expectedLookupTable:z.object({address:Address,dataSha256:Hash}).strict(),blockhashContextSlot:Count}).strict().superRefine((v,ctx)=>{
 if(v.lookupTable.address!==v.expectedLookupTable.address||v.lookupTable.slot>v.blockhashContextSlot)issue(ctx,'inconsistent frozen lookup observation');
});
const OrderedTransaction=Transaction.extend({version:z.literal('v0'),lookupTables:z.array(LookupAccount).length(1)}).strict();
const PreparationFields={
 wallet:Address,idempotencyKey:Id,claimId:Id,quoteId:Id,quoteVersion:z.literal(PHASE_E_MINING_CLAIM_QUOTE.version),rootSequence:Positive,day:Positive,root:Hash,totalCumulativeBaseUnits:Positive,
 identity:z.object({genesisHash:Address,programId:Address,configAddress:Address,keepMint:Address,reserveOwner:Address}).strict(),leaf:Leaf,proof:Proof,needsAta:z.boolean(),needsMinerRecords:z.boolean(),
 fees:z.object({feeLamports:Amount,rentLamports:Amount,totalLamports:Amount,payerBalanceLamports:Amount}).strict(),
 preparedAt:Iso,expiresAt:Iso,serverNow:Iso,state:z.literal('prepared'),currentSigningAuthorized:z.literal(false),claimSubmissionAuthorized:z.literal(false),
};
const LegacyPreparation=z.object({version:z.literal(1),...PreparationFields,transactions:z.array(Transaction).min(1).max(2)}).strict();
const OrderedPreparation=z.object({version:z.literal(2),...PreparationFields,format:MiningClaimFormatSchema,transactions:z.array(OrderedTransaction).min(1).max(2)}).strict();
export const MiningClaimPreparationViewSchema=z.discriminatedUnion('version',[LegacyPreparation,OrderedPreparation]).superRefine((v,ctx)=>{
 if(v.quoteId!==v.claimId||v.leaf.wallet!==v.wallet||v.leaf.rootSequence!==v.rootSequence||Date.parse(v.expiresAt)-Date.parse(v.preparedAt)!==PHASE_E_MINING_CLAIM_QUOTE.ttlSec*1000)issue(ctx,'inconsistent quote binding');
 if(v.transactions.some((t,i)=>t.ordinal!==i||t.feePayer!==v.wallet||t.blockhash!==v.transactions[0]!.blockhash||t.lastValidBlockHeight!==v.transactions[0]!.lastValidBlockHeight))issue(ctx,'inconsistent signing order or fee payer');
 const needsSetup=v.needsAta||v.needsMinerRecords;
 if(v.version===2&&(v.transactions.length!==(needsSetup?2:1)||v.transactions.some(t=>JSON.stringify(t.lookupTables[0])!==JSON.stringify(v.format.lookupTable))))issue(ctx,'ordered approval requires exact setup and frozen lookup snapshot');
 if(v.transactions.length===1?v.transactions[0]!.kind!==(needsSetup?'combined':'claim'):!needsSetup||v.transactions[0]!.kind!=='setup'||v.transactions[1]!.kind!=='claim')issue(ctx,'inconsistent setup plan');
 const values=[...Object.values(v.fees),v.leaf.cumulativeKeepBaseUnits,v.totalCumulativeBaseUnits,v.leaf.cumulativeRenown,v.leaf.cumulativeDays,...v.transactions.flatMap(t=>[t.feeLamports,t.rentLamports])];if(values.some(x=>amount(x)===null))return;
 if(BigInt(v.leaf.cumulativeKeepBaseUnits)>BigInt(v.totalCumulativeBaseUnits)||BigInt(v.leaf.cumulativeRenown)>BigInt(v.leaf.cumulativeDays))issue(ctx,'inconsistent leaf');
 const fee=v.transactions.reduce((n,t)=>n+BigInt(t.feeLamports),0n),rent=v.transactions.reduce((n,t)=>n+BigInt(t.rentLamports),0n);
 if(fee!==BigInt(v.fees.feeLamports)||rent!==BigInt(v.fees.rentLamports)||fee+rent!==BigInt(v.fees.totalLamports)||fee+rent>BigInt(v.fees.payerBalanceLamports)||v.transactions.some(t=>t.kind==='claim'&&t.rentLamports!=='0'))issue(ctx,'inconsistent SOL estimates');
});
export const MiningClaimPreparationEnvelopeSchema=z.object({wallet:Address,idempotencyKey:Id,status:z.enum(['unknown','prepared']),receipt:MiningClaimPreparationViewSchema.nullable(),serverNow:Iso}).strict().superRefine((v,ctx)=>{
 if((v.status==='unknown')!==(v.receipt===null)||v.receipt&&(v.receipt.wallet!==v.wallet||v.receipt.idempotencyKey!==v.idempotencyKey||v.receipt.serverNow!==v.serverNow))issue(ctx,'inconsistent preparation recovery');
});
const Landing=z.object({ordinal:Count.max(1),kind:Kind,signature:Signature.nullable(),landing:z.enum(['pending','finalized','failed']),settledBaseUnits:Amount.nullable(),acceptedAt:Iso.nullable(),settledAt:Iso.nullable()}).strict();
export const MiningClaimViewSchema=z.object({version:z.literal(1),wallet:Address,claimId:Id,state:z.enum(['unknown','prepared','retained','settled','failed']),landing:z.enum(['pending','finalized','failed']),signature:Signature.nullable(),settledBaseUnits:Amount.nullable(),transactions:z.array(Landing).max(2),serverNow:Iso,claimSubmissionAuthorized:z.literal(false)}).strict().superRefine((v,ctx)=>{
 const txs=v.transactions;
 if(txs.some((t,i)=>t.ordinal!==i||(t.signature===null)!==(t.acceptedAt===null)||t.landing==='pending'&&(t.settledBaseUnits!==null||t.settledAt!==null)||t.landing==='finalized'&&(t.signature===null||t.settledBaseUnits===null||t.settledAt===null)||t.landing==='failed'&&(t.signature===null||t.settledBaseUnits!==null||t.settledAt===null)))issue(ctx,'inconsistent transaction landing');
 if(txs.length===2&&(txs[0]!.kind!=='setup'||txs[1]!.kind!=='claim')||txs.length===1&&txs[0]!.kind==='setup')issue(ctx,'inconsistent transaction order');
 for(const t of txs)if(t.settledBaseUnits!==null){const n=amount(t.settledBaseUnits);if(n!==null&&(t.kind==='setup'?n!==0n:n===0n))issue(ctx,'inconsistent settled payment');}
 // settledAt records terminal verification time; a failed landing has no
 // settled amount. A later signed split ordinal can change the aggregate view.
 const paid=txs.find(t=>t.kind!=='setup'&&t.landing==='finalized'),signed=txs.filter(t=>t.signature!==null);
 const failed=!paid&&signed.every(t=>t.landing!=='pending')?signed.filter(t=>t.landing==='failed').at(-1):undefined;
 const last=paid??failed??signed.at(-1),state=txs.length===0?'unknown':paid?'settled':failed?'failed':signed.length?'retained':'prepared';
 if(v.state!==state||v.landing!==(paid?'finalized':failed?'failed':'pending')||v.signature!==(last?.signature??null)||v.settledBaseUnits!==(paid?.settledBaseUnits??null))issue(ctx,'inconsistent claim recovery');
});
export const MiningClaimSubmitResponseSchema=z.object({claimId:Id,signature:Signature,serverNow:Iso,delivery:z.enum(['submitted','held','settled']),reason:z.string().min(1).max(128).regex(/^[A-Z0-9_]+$/).optional()}).strict();
export type MiningClaimStatusView=z.infer<typeof MiningClaimStatusViewSchema>;
export type MiningClaimPreparationView=z.infer<typeof MiningClaimPreparationViewSchema>;
export type MiningClaimPreparationEnvelope=z.infer<typeof MiningClaimPreparationEnvelopeSchema>;
export type MiningClaimView=z.infer<typeof MiningClaimViewSchema>;
export type MiningClaimPrepareRequest=z.infer<typeof MiningClaimPrepareRequestSchema>;
export type MiningClaimSubmitRequest=z.infer<typeof MiningClaimSubmitRequestSchema>;
export type MiningClaimSubmitResponse=z.infer<typeof MiningClaimSubmitResponseSchema>;


/** A fresh, non-authorizing review of one exact saved message. Clients still
 * independently verify their installed deployment/lookup pins and signed ABI. */
export const MiningClaimSetupBindingSchema=z.object({claimId:Id,signature:Signature,slot:Count,observedAccountSlot:Count,messageSha256:Hash,wireSha256:Hash}).strict().superRefine((v,ctx)=>{
 if(v.observedAccountSlot<v.slot)issue(ctx,'setup observation precedes its transaction');
});
export const MiningClaimReviewSchema=z.object({version:z.literal(1),wallet:Address,claimId:Id,ordinal:Count.max(1),status:z.literal('ready'),messageSha256:Hash,blockhash:Address,
 preparedAt:Iso,expiresAt:Iso,observedAt:Iso,snapshotSlot:Count,blockHeight:Count,lastValidBlockHeight:Count,setup:MiningClaimSetupBindingSchema.nullable(),
 currentSigningAuthorized:z.literal(false),relayAuthorized:z.literal(false),settlementAuthorized:z.literal(false)}).strict().superRefine((v,ctx)=>{
 if(Date.parse(v.expiresAt)-Date.parse(v.preparedAt)!==PHASE_E_MINING_CLAIM_QUOTE.ttlSec*1000||Date.parse(v.observedAt)<Date.parse(v.preparedAt)||Date.parse(v.observedAt)>=Date.parse(v.expiresAt)||v.blockHeight>v.lastValidBlockHeight)issue(ctx,'review is not current');
 if(v.ordinal===1&&!v.setup||v.setup&&v.snapshotSlot<v.setup.observedAccountSlot)issue(ctx,'review does not follow authenticated setup');
});
export const MiningClaimContinuationRequestSchema=z.object({idempotencyKey:Id}).strict();
const FailureBinding=z.object({ordinal:Count.max(1),signature:Signature,slot:Count,observedAccountSlot:Count,messageSha256:Hash,wireSha256:Hash}).strict();
export const MiningClaimContinuationSchema=z.object({version:z.literal(1),wallet:Address,parentClaimId:Id,childClaimId:Id,reason:z.enum(['unsigned-expired','failed']),
 parentPreparation:MiningClaimPreparationViewSchema,setup:MiningClaimSetupBindingSchema,failure:FailureBinding.nullable(),childPreparation:MiningClaimPreparationViewSchema,
 expiry:z.object({blockHeight:Count,slot:Count}).strict(),createdAt:Iso,currentSigningAuthorized:z.literal(false),relayAuthorized:z.literal(false),settlementAuthorized:z.literal(false),journalClearingAuthorized:z.literal(false)}).strict().superRefine((v,ctx)=>{
 const p=v.parentPreparation,c=v.childPreparation;
 if(p.version!==2||c.version!==2){issue(ctx,'continuation requires ordered originals');return;}
 if(p.wallet!==v.wallet||c.wallet!==v.wallet||p.claimId!==v.parentClaimId||c.claimId!==v.childClaimId||p.claimId===c.claimId||p.idempotencyKey===c.idempotencyKey||p.transactions[0]!.blockhash===c.transactions[0]!.blockhash)issue(ctx,'continuation changed or reused an original identity');
 if(c.needsAta||c.needsMinerRecords||c.transactions.length!==1||c.transactions[0]!.kind!=='claim')issue(ctx,'continuation may only claim after setup');
 for(const k of ['identity','rootSequence','day','root','totalCumulativeBaseUnits','leaf','proof'] as const)if(JSON.stringify(p[k])!==JSON.stringify(c[k]))issue(ctx,'continuation changed the original entitlement');
 if(JSON.stringify(p.format.expectedLookupTable)!==JSON.stringify(c.format.expectedLookupTable)||p.format.lookupTable.dataHex!==c.format.lookupTable.dataHex||p.format.lookupTable.owner!==c.format.lookupTable.owner)issue(ctx,'continuation changed the installed table');
 if(v.expiry.slot<v.setup.observedAccountSlot||c.format.lookupTable.slot<v.expiry.slot||c.format.blockhashContextSlot<c.format.lookupTable.slot)issue(ctx,'continuation source precedes its recovery floor');
 if(v.reason==='unsigned-expired'?(v.failure!==null||v.expiry.blockHeight<=p.transactions[0]!.lastValidBlockHeight):v.failure===null)issue(ctx,'continuation lacks its exact terminal basis');
 if(v.failure&&(v.failure.observedAccountSlot<v.failure.slot||v.expiry.slot<v.failure.observedAccountSlot||v.failure.ordinal!==p.transactions.length-1))issue(ctx,'failure does not describe the original remainder');
 if(Date.parse(v.createdAt)<Date.parse(c.preparedAt))issue(ctx,'continuation predates its quote');
});
export const MiningClaimContinuationEnvelopeSchema=z.object({version:z.literal(1),wallet:Address,parentClaimId:Id,status:z.enum(['unknown','continued']),continuation:MiningClaimContinuationSchema.nullable(),serverNow:Iso}).strict().superRefine((v,ctx)=>{
 if((v.status==='unknown')!==(v.continuation===null)||v.continuation&&(v.continuation.wallet!==v.wallet||v.continuation.parentClaimId!==v.parentClaimId))issue(ctx,'continuation belongs to another original');
});
export type MiningClaimFormat=z.infer<typeof MiningClaimFormatSchema>;
export type MiningClaimSetupBinding=z.infer<typeof MiningClaimSetupBindingSchema>;
export type MiningClaimReview=z.infer<typeof MiningClaimReviewSchema>;
export type MiningClaimContinuation=z.infer<typeof MiningClaimContinuationSchema>;
export type MiningClaimContinuationEnvelope=z.infer<typeof MiningClaimContinuationEnvelopeSchema>;
