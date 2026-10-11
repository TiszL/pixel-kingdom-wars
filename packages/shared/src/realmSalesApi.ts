/** Bounded browser DTOs for retained consent, never signing or relay authority.
 * Subpath only. The signer separately verifies canonical keys, hashes, PDAs,
 * instruction bytes and cryptographic signatures against reviewed deployment. */
import {z} from 'zod';
import {PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from './constants';
const P=PHASE_E_POLICY.seekerIsland,U64=(1n<<64n)-1n,I64=(1n<<63n)-1n,DAY=BigInt(PHASE_E_MINING_PUBLICATION.daySec);
const Address=z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const Id=z.uuid().refine(v=>v===v.toLowerCase()),Hash=z.string().length(64).regex(/^[0-9a-f]{64}$/);
const SaleId=z.string().length(32).regex(/^[0-9a-f]{32}$/).refine(v=>v!=='00'.repeat(16));
const Count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),Spot=Count.max(P.totalSpots-1),Realm=Count.max(P.realmCount-1);
function unsigned(value:string,max=U64):bigint|null{if(value.length>20||!/^(0|[1-9][0-9]{0,19})$/.test(value))return null;const n=BigInt(value);return n<=max?n:null;}
const Amount=z.string().max(20).refine(v=>unsigned(v)!==null),Timestamp=Amount.refine(v=>unsigned(v,I64)!==null);
const Hex=z.string().min(2).max(2334).regex(/^(?:[0-9a-f]{2})+$/);
const issue=(ctx:z.RefinementCtx,message:string)=>ctx.addIssue({code:'custom',message});
const Rent=z.object({address:Address,space:Count.min(1).max(1232),minimumBalanceLamports:Amount,existingLamports:Amount,maxIncreaseLamports:Amount}).strict();
// z.array.max checks length after parsing elements. Reject oversized input here
// so untrusted arrays cannot cause unbounded element traversal first.
const Rents=z.preprocess(v=>Array.isArray(v)&&v.length<=3?v:null,z.array(Rent).min(1).max(3));
export const RealmSalePrepareRequestSchema=z.object({idempotencyKey:Id,spot:Spot,realm:Realm}).strict();
export const RealmSalePreparationSchema=z.object({version:z.literal(PHASE_E_SEEKER_SALE.version),wallet:Address,idempotencyKey:Id,saleId:SaleId,spot:Spot,realm:Realm,
 terms:z.object({round:Amount,day:Amount,seller:Address,developer:Address,priorExpiry:Timestamp,validAfter:Timestamp,validUntil:Timestamp}).strict(),
 source:z.object({revision:z.string().min(1).max(128),genesisHash:Address,programId:Address,programDataSha256:Hash,reviewedDeploymentSlot:Count,termProofHash:Hash,snapshotHash:Hash,termSlot:Count,initialSlot:Count,blockhashSlot:Count,feeSlot:Count,costSlot:Count,admissionSlot:Count}).strict(),
 quote:z.object({blockhash:Address,lastValidBlockHeight:Count,unixTimestamp:Timestamp,needsAccess:z.boolean(),needsQuota:z.boolean(),quotaRemaining:Count.min(1).max(P.paidContractsPerSpotDayMax),messageHex:Hex,messageSha256:Hash,packetBytes:Count.min(66).max(1232),rents:Rents,feeLamports:Amount,rentLamports:Amount,paymentDebitLamports:Amount,requiredLamports:Amount,payerLamports:Amount}).strict(),
 state:z.literal('prepared'),currentSigningAuthorized:z.literal(false),submissionAuthorized:z.literal(false),
}).strict().superRefine((a,ctx)=>{
 const t=a.terms,q=a.quote,s=a.source;
 const amounts=[t.round,t.day,t.priorExpiry,t.validAfter,t.validUntil,q.unixTimestamp,q.feeLamports,q.rentLamports,q.paymentDebitLamports,q.requiredLamports,q.payerLamports,...q.rents.flatMap(r=>[r.minimumBalanceLamports,r.existingLamports,r.maxIncreaseLamports])];
 if(amounts.some(v=>unsigned(v)===null))return;
 const day=BigInt(t.day),after=BigInt(t.validAfter),until=BigInt(t.validUntil),prior=BigInt(t.priorExpiry),clock=BigInt(q.unixTimestamp),dayEnd=(day+1n)*DAY-1n,latest=until<dayEnd?until:dayEnd;
 if(dayEnd>I64||until<after||until-after>BigInt(PHASE_E_SEEKER_SALE.quoteTtlSec)||after>dayEnd||until<day*DAY||clock<after||clock>until||(prior>latest?prior:latest)+BigInt(P.permitDurationSec)>I64)issue(ctx,'inconsistent signed UTC quote window');
 const slots=[s.reviewedDeploymentSlot,s.termSlot,s.initialSlot,s.blockhashSlot,s.feeSlot,s.costSlot,s.admissionSlot];
 if(slots.some((n,i)=>i>0&&n<slots[i-1]!))issue(ctx,'source observation order differs');
 if(q.messageHex.slice(0,2)!=='01'||q.packetBytes!==65+q.messageHex.length/2||q.rents.length!==1+Number(q.needsAccess)+Number(q.needsQuota)||new Set(q.rents.map(r=>r.address)).size!==q.rents.length)issue(ctx,'inconsistent original packet or account plan');
 let rent=0n;for(const r of q.rents){const minimum=BigInt(r.minimumBalanceLamports),existing=BigInt(r.existingLamports),deficit=minimum>existing?minimum-existing:0n;if(deficit!==BigInt(r.maxIncreaseLamports))issue(ctx,'inconsistent rent deficit');rent+=deficit;}
 const price=BigInt(P.permitPriceLamports),bps=BigInt(PHASE_E_POLICY.basisPoints),seller=price*BigInt(P.contractSellerBps)/bps,developer=price*BigInt(P.contractDevBps)/bps;
 const payment=price-(t.seller===a.wallet?seller:0n)-(t.developer===a.wallet?developer:0n),required=payment+rent+BigInt(q.feeLamports);
 if(rent!==BigInt(q.rentLamports)||payment!==BigInt(q.paymentDebitLamports)||required!==BigInt(q.requiredLamports)||required>BigInt(q.payerLamports))issue(ctx,'inconsistent approved SOL costs');
});
export const RealmSalePreparationEnvelopeSchema=z.object({wallet:Address,idempotencyKey:Id,preparation:RealmSalePreparationSchema.nullable()}).strict().superRefine((v,ctx)=>{
 if(v.preparation&&(v.preparation.wallet!==v.wallet||v.preparation.idempotencyKey!==v.idempotencyKey))issue(ctx,'preparation belongs to another request');
});
const AcceptedAt=z.string().length(27).refine(v=>v.length===27&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23));
export const RealmSaleSignedWireSchema=z.object({wallet:Address,idempotencyKey:Id,saleId:SaleId,signature:z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/).refine(v=>v!=='1'.repeat(64)),signedTransactionHex:z.string().min(132).max(2464).regex(/^(?:[0-9a-f]{2})+$/),wireSha256:Hash,messageSha256:Hash,acceptedAt:AcceptedAt,currentSigningAuthorized:z.literal(false),relayAuthorized:z.literal(false)}).strict().superRefine((v,ctx)=>{
 const wire=v.signedTransactionHex;if(wire.slice(0,2)!=='01'||wire.slice(130,132)!=='01'||wire.slice(2,130)==='00'.repeat(64))issue(ctx,'invalid retained single-signature packet');
});
export type RealmSalePreparationView=z.infer<typeof RealmSalePreparationSchema>;
export type RealmSalePrepareRequest=z.infer<typeof RealmSalePrepareRequestSchema>;
export type RealmSaleSignedWireView=z.infer<typeof RealmSaleSignedWireSchema>;
