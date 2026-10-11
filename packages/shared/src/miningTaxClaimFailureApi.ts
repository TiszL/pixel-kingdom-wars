/** Owner-attestation consistency over immutable packets. This public grammar
 * grants no browser chain finality, replacement consent or archival authority. */
import {z} from 'zod';
import {MiningTaxClaimPreparationSchema} from './miningTaxClaimsApi';
import {MiningTaxClaimRecoveryEnvelopeSchema,MiningTaxClaimSignedWireSchema} from './miningTaxClaimRecoveryApi';
const P=MiningTaxClaimPreparationSchema.shape,Count=P.blockHeight,Amount=P.caps.shape.maxFeeLamports;
const Source=z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),genesisHash:P.identity.shape.genesisHash,programId:P.identity.shape.programId,configAddress:P.identity.shape.configAddress,
 reviewedDeploymentSlot:Count,reviewedProgramDataSha256:P.source.shape.reviewedProgramDataSha256,snapshotSha256:P.source.shape.snapshotSha256,snapshotSlot:Count,blockhashSlot:Count,observedAccountSlot:Count}).strict();
export const MiningTaxClaimFailureReceiptSchema=z.object({version:z.literal(1),wallet:P.wallet,idempotencyKey:P.idempotencyKey,claimId:P.claimId,round:P.round,spot:P.spot,ordinal:Count.max(1),kind:z.enum(['claim','combined','setup']),
 signature:MiningTaxClaimSignedWireSchema.shape.signature,messageSha256:P.identity.shape.registryHash,signedTransactionSha256:P.identity.shape.registryHash,slot:Count,blockTime:Count,feeLamports:Amount,rentLamports:z.literal('0'),paidKeepBaseUnits:z.literal('0'),source:Source,
 outcome:z.literal('failed'),finalityAuthenticated:z.literal(true),paymentAuthorized:z.literal(false),signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),journalClearingAuthorized:z.literal(false)}).strict();
export const MiningTaxClaimFailureSchema=z.object({wallet:P.wallet,idempotencyKey:P.idempotencyKey,claimId:P.claimId,ordinal:Count.max(1),receipt:MiningTaxClaimFailureReceiptSchema,
 verifiedAt:MiningTaxClaimSignedWireSchema.shape.acceptedAt,transactionFailed:z.literal(true),claimFinalized:z.literal(false)}).strict();
const bounded=z.preprocess(v=>Array.isArray(v)&&v.length<=2?v:null,z.array(MiningTaxClaimFailureSchema).max(2));
export const MiningTaxClaimFailureEnvelopeSchema=z.object({recovery:MiningTaxClaimRecoveryEnvelopeSchema,failures:bounded}).strict().superRefine((v,ctx)=>{
 const p=v.recovery.preparation;
 const issue=()=>ctx.addIssue({code:'custom',message:'Failure differs from the saved signed packet or verified outcome prefix'});
 if(!p){if(v.failures.length)issue();return;}
 for(const [i,f] of v.failures.entries()){
  const r=f.receipt,s=r.source,w=v.recovery.wires.find(w=>w.ordinal===f.ordinal),tx=p.transactions[f.ordinal];
  if(!w||!tx){issue();continue;}
  if(f.wallet!==p.wallet||f.idempotencyKey!==p.idempotencyKey||f.claimId!==p.claimId||f.ordinal<=(v.failures[i-1]?.ordinal??-1)||r.wallet!==f.wallet||r.idempotencyKey!==f.idempotencyKey||r.claimId!==f.claimId||r.ordinal!==f.ordinal||r.round!==p.round||r.spot!==p.spot||r.kind!==w.kind||r.signature!==w.signature||r.messageSha256!==w.messageSha256||r.signedTransactionSha256!==w.wireSha256)issue();
  if(s.genesisHash!==p.identity.genesisHash||s.programId!==p.identity.programId||s.configAddress!==p.identity.configAddress||s.reviewedDeploymentSlot!==p.source.reviewedDeploymentSlot||s.reviewedProgramDataSha256!==p.source.reviewedProgramDataSha256||s.snapshotSha256!==p.source.snapshotSha256||s.snapshotSlot!==p.source.snapshotSlot||s.blockhashSlot!==p.source.blockhashSlot||r.slot<=p.source.reviewedDeploymentSlot||r.slot<Math.max(p.source.snapshotSlot,p.source.blockhashSlot)||s.observedAccountSlot<r.slot)issue();
  // Nested refinements can fail while siblings are still visited. Never convert
  // invalid attacker-supplied numeric text while reporting that malformed input.
  if(/^(0|[1-9][0-9]{0,19})$/.test(p.snapshot.unixTimestamp)&&Number.isSafeInteger(r.blockTime)&&BigInt(r.blockTime)<BigInt(p.snapshot.unixTimestamp))issue();
  if(v.recovery.settlement&&v.recovery.settlement.ordinal>=f.ordinal)issue();
 }
});
export type MiningTaxClaimFailureView=z.infer<typeof MiningTaxClaimFailureSchema>;
export type MiningTaxClaimFailureEnvelope=z.infer<typeof MiningTaxClaimFailureEnvelopeSchema>;
