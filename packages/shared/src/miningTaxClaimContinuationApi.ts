/** Immutable linked consent consistency. These facts are neither client chain
 * verification, permission to sign nor proof that an absent packet never ran. */
import {z} from 'zod';
import {MiningTaxClaimPreparationSchema} from './miningTaxClaimsApi';
import {MiningTaxClaimSettlementSchema,MiningTaxClaimSignedWireSchema,MiningTaxClaimRecoveryEnvelopeSchema} from './miningTaxClaimRecoveryApi';
const P=MiningTaxClaimPreparationSchema.shape,Count=P.blockHeight,issue=(ctx:z.RefinementCtx,message:string)=>ctx.addIssue({code:'custom',message});
export const MiningTaxClaimContinuationRequestSchema=z.object({idempotencyKey:P.idempotencyKey,caps:P.caps}).strict();
export const MiningTaxClaimContinuationSchema=z.object({version:z.literal(1),wallet:P.wallet,parentIdempotencyKey:P.idempotencyKey,
 parentPreparation:MiningTaxClaimPreparationSchema,parentWire:MiningTaxClaimSignedWireSchema,parentSetup:MiningTaxClaimSettlementSchema,childPreparation:MiningTaxClaimPreparationSchema,
 expiry:z.object({genesisHash:P.source.shape.genesisHash,programId:P.source.shape.programId,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:P.source.shape.reviewedProgramDataSha256,blockHeight:Count,slot:Count}).strict(),
 createdAt:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23)),
 currentSigningAuthorized:z.literal(false),relayAuthorized:z.literal(false),settlementAuthorized:z.literal(false),journalClearingAuthorized:z.literal(false),
}).strict().superRefine((v,ctx)=>{
 const setup=v.parentSetup,p=v.parentPreparation,c=v.childPreparation,e=v.expiry;
 if(!MiningTaxClaimRecoveryEnvelopeSchema.safeParse({wallet:v.wallet,idempotencyKey:v.parentIdempotencyKey,claimId:p.claimId,status:'setup',preparation:p,wires:[v.parentWire],settlement:setup,serverNow:p.preparedAt}).success)issue(ctx,'parent setup custody differs');
 if(setup.ordinal!==0||setup.claimFinalized||setup.receipt.phase!=='setup'||p.transactions.length!==2||p.transactions[0]?.kind!=='setup'||p.transactions[1]?.kind!=='claim')issue(ctx,'parent is not a verified split setup');
 if(v.wallet!==p.wallet||v.parentIdempotencyKey!==p.idempotencyKey||c.wallet!==p.wallet||c.idempotencyKey===p.idempotencyKey||c.claimId===p.claimId||c.blockhash===p.blockhash)issue(ctx,'parent and fresh child identities differ');
 if(c.round!==p.round||c.spot!==p.spot||Object.keys(p.identity).some(k=>p.identity[k as keyof typeof p.identity]!==c.identity[k as keyof typeof c.identity])||Object.keys(p.term).some(k=>p.term[k as keyof typeof p.term]!==c.term[k as keyof typeof c.term]))issue(ctx,'permanent tax identity differs');
 if(e.genesisHash!==p.source.genesisHash||e.programId!==p.source.programId||e.reviewedDeploymentSlot!==p.source.reviewedDeploymentSlot||e.reviewedProgramDataSha256!==p.source.reviewedProgramDataSha256||c.source.genesisHash!==e.genesisHash||c.source.programId!==e.programId||c.source.reviewedDeploymentSlot!==e.reviewedDeploymentSlot||c.source.reviewedProgramDataSha256!==e.reviewedProgramDataSha256)issue(ctx,'reviewed deployment differs');
 if(e.blockHeight<=p.lastValidBlockHeight||c.blockHeight<e.blockHeight||e.slot<Math.max(p.source.snapshotSlot,p.source.blockhashSlot,setup.receipt.source.observedAccountSlot)||c.source.firstSnapshotSlot<e.slot||c.source.snapshotSlot<e.slot)issue(ctx,'fresh bank does not follow finalized expiry');
 if(/^\d+$/.test(c.snapshot.unixTimestamp)&&/^\d+$/.test(setup.receipt.source.observedClockUnixTimestamp)&&BigInt(c.snapshot.unixTimestamp)<BigInt(setup.receipt.source.observedClockUnixTimestamp))issue(ctx,'fresh bank Clock regressed');
});
export const MiningTaxClaimContinuationEnvelopeSchema=z.object({wallet:P.wallet,parentIdempotencyKey:P.idempotencyKey,status:z.enum(['continued','unknown']),continuation:MiningTaxClaimContinuationSchema.nullable(),serverNow:P.preparedAt}).strict().superRefine((v,ctx)=>{
 if((v.status==='continued')!==(v.continuation!==null)||v.continuation&&(v.continuation.wallet!==v.wallet||v.continuation.parentIdempotencyKey!==v.parentIdempotencyKey))issue(ctx,'continuation envelope differs');
});
export type MiningTaxClaimContinuationRequest=z.infer<typeof MiningTaxClaimContinuationRequestSchema>;
export type MiningTaxClaimContinuation=z.infer<typeof MiningTaxClaimContinuationSchema>;
