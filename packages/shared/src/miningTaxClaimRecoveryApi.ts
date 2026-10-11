/** Authenticated-owner recovery DTO consistency only. Declared hash equality is
 * not cryptographic verification, and a server finality assertion is not client
 * RPC authority. No Node/chain/wallet dependencies or journal-clear permission. */
import {z} from 'zod';
import {MiningTaxClaimPreparationSchema} from './miningTaxClaimsApi';
const U64=(1n<<64n)-1n,I64=(1n<<63n)-1n,alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Hex(v:string,size:number):string|null{
 if(v.length<size||v.length>(size===32?44:88)||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(v))return null;
 let n=0n;for(const c of v)n=n*58n+BigInt(alphabet.indexOf(c));let hex=n?n.toString(16):'';if(hex.length%2)hex='0'+hex;hex='00'.repeat(v.match(/^1*/)?.[0].length??0)+hex;return hex.length===size*2&&/[1-9a-f]/.test(hex)?hex:null;
}
function unsigned(v:string,max=U64):bigint|null{if(v.length>20||!/^(0|[1-9][0-9]{0,19})$/.test(v))return null;const n=BigInt(v);return n<=max?n:null;}
const Address=z.string().max(44).refine(v=>base58Hex(v,32)!==null),Signature=z.string().max(88).refine(v=>base58Hex(v,64)!==null);
const Id=z.uuid().refine(v=>v===v.toLowerCase()),Hash=z.string().regex(/^[0-9a-f]{64}$/),Amount=z.string().max(20).refine(v=>unsigned(v)!==null),Timestamp=Amount.refine(v=>unsigned(v,I64)!==null),Count=z.number().int().nonnegative().safe();
const iso=(digits:3|6)=>z.string().length(digits===3?24:27).refine(v=>new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{${digits}}Z$`).test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23));
const Iso=iso(3),Micro=iso(6),issue=(ctx:z.RefinementCtx,message:string)=>ctx.addIssue({code:'custom',message});
// Packet and record limits are technical bounds, not gameplay policy.
const bounded=<T extends z.ZodType>(item:T,max:number,min=0)=>z.preprocess(v=>Array.isArray(v)&&v.length<=max?v:null,z.array(item).min(min).max(max));
const HexWire=z.string().min(132).max(2464).regex(/^(?:[0-9a-f]{2})+$/);
export const MiningTaxClaimSignedWireSchema=z.object({wallet:Address,idempotencyKey:Id,claimId:Id,ordinal:Count.max(1),kind:z.enum(['combined','setup','claim']),signature:Signature,signedTransactionHex:HexWire,wireSha256:Hash,messageSha256:Hash,acceptedAt:Micro,currentSigningAuthorized:z.literal(false),relayAuthorized:z.literal(false),settlementAuthorized:z.literal(false)}).strict().superRefine((w,ctx)=>{
 if(w.signedTransactionHex.slice(0,2)!=='01'||w.signedTransactionHex.slice(2,130)!==base58Hex(w.signature,64))issue(ctx,'original signature envelope differs');
});
const Observation=z.object({kind:z.enum(['combined','setup','claim']),signature:Signature,slot:Count,blockTime:Count,observedAccountSlot:Count,messageSha256:Hash,signedTransactionSha256:Hash,paidKeepBaseUnits:Amount,feeLamports:Amount,rentLamports:Amount,currentPoolAccrued:Amount,currentPoolPaid:Amount,currentClaimedTotal:Amount,currentGlobalTaxPaid:Amount,claimedCumulativeBaseUnits:Amount.nullable(),poolPaidAfterClaimBaseUnits:Amount.nullable(),globalTaxPaidAfterClaimBaseUnits:Amount.nullable()}).strict();
const observedAmounts=(t:z.infer<typeof Observation>)=>[t.paidKeepBaseUnits,t.feeLamports,t.rentLamports,t.currentPoolAccrued,t.currentPoolPaid,t.currentClaimedTotal,t.currentGlobalTaxPaid,t.claimedCumulativeBaseUnits,t.poolPaidAfterClaimBaseUnits,t.globalTaxPaidAfterClaimBaseUnits].filter((v):v is string=>v!==null);
export const MiningTaxFinalizedReceiptSchema=z.object({version:z.literal(1),phase:z.enum(['setup','settled']),wallet:Address,round:Amount,spot:Count.max(255),term:Address,pool:Address,cursor:Address,paidKeepBaseUnits:Amount,feeLamports:Amount,rentLamports:Amount,transactions:bounded(Observation,2,1),source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),genesisHash:Address,programId:Address,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:Hash,originalTermContextSlot:Count,observedAccountSlot:Count,observedClockUnixTimestamp:Timestamp}).strict(),finalityAuthenticated:z.literal(true),currentClaimsAuthorized:z.literal(false),signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),journalClearingAuthorized:z.literal(false)}).strict().superRefine((r,ctx)=>{
 const values=[r.round,r.paidKeepBaseUnits,r.feeLamports,r.rentLamports,r.source.observedClockUnixTimestamp,...r.transactions.flatMap(observedAmounts)];if(values.some(v=>unsigned(v)===null))return;
 let fee=0n,rent=0n,paid=0n,slot=0;const signatures=new Set<string>();
 for(const t of r.transactions){fee+=BigInt(t.feeLamports);rent+=BigInt(t.rentLamports);paid+=BigInt(t.paidKeepBaseUnits);
  if(signatures.has(t.signature)||t.slot<slot||t.slot<=r.source.reviewedDeploymentSlot||t.observedAccountSlot!==r.source.observedAccountSlot||t.observedAccountSlot<t.slot||BigInt(t.blockTime)>BigInt(r.source.observedClockUnixTimestamp))issue(ctx,'receipt observation provenance differs');signatures.add(t.signature);slot=t.slot;
  if(BigInt(t.currentPoolPaid)>BigInt(t.currentPoolAccrued)||BigInt(t.currentClaimedTotal)>BigInt(t.currentPoolPaid)||BigInt(t.currentPoolPaid)>BigInt(t.currentGlobalTaxPaid))issue(ctx,'observed high-water counters differ');
  if(t.kind==='setup'){if(t.paidKeepBaseUnits!=='0'||t.claimedCumulativeBaseUnits!==null||t.poolPaidAfterClaimBaseUnits!==null||t.globalTaxPaidAfterClaimBaseUnits!==null)issue(ctx,'setup is not a payment');}
  else if(t.claimedCumulativeBaseUnits===null||t.poolPaidAfterClaimBaseUnits===null||t.globalTaxPaidAfterClaimBaseUnits===null||BigInt(t.paidKeepBaseUnits)===0n)issue(ctx,'claim execution counters missing');
  else if(BigInt(t.claimedCumulativeBaseUnits)>BigInt(t.currentClaimedTotal)||BigInt(t.poolPaidAfterClaimBaseUnits)>BigInt(t.currentPoolPaid)||BigInt(t.globalTaxPaidAfterClaimBaseUnits)>BigInt(t.currentGlobalTaxPaid)||BigInt(t.paidKeepBaseUnits)>BigInt(t.claimedCumulativeBaseUnits)||BigInt(t.claimedCumulativeBaseUnits)>BigInt(t.poolPaidAfterClaimBaseUnits)||BigInt(t.poolPaidAfterClaimBaseUnits)>BigInt(t.globalTaxPaidAfterClaimBaseUnits))issue(ctx,'historical payment exceeds observed counters');
 }
 if(r.source.originalTermContextSlot>r.source.observedAccountSlot||r.source.originalTermContextSlot<r.source.reviewedDeploymentSlot||fee!==BigInt(r.feeLamports)||rent!==BigInt(r.rentLamports)||paid!==BigInt(r.paidKeepBaseUnits)||fee+rent>U64)issue(ctx,'receipt totals or original context differ');
 if(r.phase==='setup'?r.transactions.length!==1||r.transactions[0]!.kind!=='setup'||paid!==0n:r.transactions.length===1?r.transactions[0]!.kind==='setup'||paid===0n:r.transactions[0]!.kind!=='setup'||r.transactions[1]!.kind!=='claim'||paid===0n)issue(ctx,'receipt phase differs from verified prefix');
});
export const MiningTaxClaimSettlementSchema=z.object({wallet:Address,idempotencyKey:Id,claimId:Id,ordinal:Count.max(1),receipt:MiningTaxFinalizedReceiptSchema,settledAt:Micro,claimFinalized:z.boolean()}).strict().superRefine((s,ctx)=>{
 if(s.wallet!==s.receipt.wallet||s.ordinal!==s.receipt.transactions.length-1||s.claimFinalized!==(s.receipt.phase==='settled'))issue(ctx,'settlement verified prefix differs');
});
export const MiningTaxClaimRecoveryEnvelopeSchema=z.object({wallet:Address,idempotencyKey:Id,claimId:Id.nullable(),status:z.enum(['unknown','prepared','signed','setup','settled']),preparation:MiningTaxClaimPreparationSchema.nullable(),wires:bounded(MiningTaxClaimSignedWireSchema,2),settlement:MiningTaxClaimSettlementSchema.nullable(),serverNow:Iso}).strict().superRefine((v,ctx)=>{
 const p=v.preparation,s=v.settlement;if(!p){if(v.claimId!==null||v.status!=='unknown'||v.wires.length||s)issue(ctx,'unknown recovery contains evidence');return;}
 if(p.wallet!==v.wallet||p.idempotencyKey!==v.idempotencyKey||p.claimId!==v.claimId)issue(ctx,'original preparation identity differs');
 const status=s?s.receipt.phase:v.wires.length?'signed':'prepared';if(v.status!==status)issue(ctx,'status differs from retained evidence');
 for(const [i,w] of v.wires.entries()){const tx=p.transactions[w.ordinal];if(w.wallet!==v.wallet||w.idempotencyKey!==v.idempotencyKey||w.claimId!==v.claimId||!tx||tx.kind!==w.kind||w.ordinal<=(v.wires[i-1]?.ordinal??-1)||w.messageSha256!==tx.messageSha256||w.signedTransactionHex.length!==tx.packetBytes*2||w.signedTransactionHex.slice(130)!==tx.messageHex)issue(ctx,'original signed custody differs');}
 if(!s)return;const r=s.receipt,source=r.source;
 if(s.wallet!==v.wallet||s.idempotencyKey!==v.idempotencyKey||s.claimId!==v.claimId||r.wallet!==p.wallet||r.round!==p.round||r.spot!==p.spot||r.term!==p.identity.term||r.pool!==p.identity.pool||r.cursor!==p.identity.cursor)issue(ctx,'original settlement identity differs');
 if(source.genesisHash!==p.source.genesisHash||source.programId!==p.source.programId||source.reviewedDeploymentSlot!==p.source.reviewedDeploymentSlot||source.reviewedProgramDataSha256!==p.source.reviewedProgramDataSha256)issue(ctx,'original deployment pins differ');
 if(r.phase==='setup'?p.transactions.length!==2||s.ordinal!==0:r.transactions.length!==p.transactions.length)issue(ctx,'verified prefix does not match original plan');
 // Zod may retain refinement errors while checking siblings. Do not BigInt any
 // invalid nested amount while reporting a malformed public document.
 const values=[...Object.values(p.caps),...Object.values(p.fees),...Object.values(p.intended),p.snapshot.unixTimestamp,r.paidKeepBaseUnits,r.feeLamports,r.rentLamports,...p.transactions.flatMap(t=>[t.feeLamports,t.rentLamports]),...r.transactions.flatMap(observedAmounts)];if(values.some(x=>unsigned(x)===null))return;
 for(const [ordinal,t] of r.transactions.entries()){const tx=p.transactions[ordinal],w=v.wires.find(w=>w.ordinal===ordinal);
  if(!tx||!w||t.kind!==tx.kind||t.signature!==w.signature||t.messageSha256!==tx.messageSha256||t.signedTransactionSha256!==w.wireSha256||t.slot<p.source.snapshotSlot||t.slot<p.source.blockhashSlot||BigInt(t.blockTime)<BigInt(p.snapshot.unixTimestamp))issue(ctx,'receipt does not bind the exact signed prefix');
  if(t.kind!=='setup'&&(t.paidKeepBaseUnits!==p.intended.claimBaseUnits||t.claimedCumulativeBaseUnits!==p.intended.cumulativeBaseUnits))issue(ctx,'historical payment differs from intended claim');
 }
 // Original quoted fees/rent are measurements, not additional authorization
 // ceilings. A later finalized cost remains recoverable within saved user caps.
 const fee=BigInt(r.feeLamports),rent=BigInt(r.rentLamports);if(fee>BigInt(p.caps.maxFeeLamports)||rent>BigInt(p.caps.maxRentLamports)||fee+rent>BigInt(p.caps.maxTotalLamports))issue(ctx,'actual aggregate costs exceed original consent');
 if(r.paidKeepBaseUnits!==(r.phase==='setup'?'0':p.intended.claimBaseUnits))issue(ctx,'settled payment differs from original intent');
});
function base64Packet(v:string):boolean{
 if(v.length<88||v.length>1644||v.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))return false;
 const padding=v.endsWith('==')?2:v.endsWith('=')?1:0,size=v.length/4*3-padding,last='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(v[v.length-padding-1]!);
 return size>=66&&size<=1232&&(padding===0||padding===1?padding===0||(last&3)===0:(last&15)===0);
}
export const MiningTaxClaimSubmitRequestSchema=z.object({idempotencyKey:Id,signedTransaction:z.string().min(88).max(1644).refine(base64Packet)}).strict();
export type MiningTaxClaimSignedWireView=z.infer<typeof MiningTaxClaimSignedWireSchema>;
export type MiningTaxFinalizedReceiptView=z.infer<typeof MiningTaxFinalizedReceiptSchema>;
export type MiningTaxClaimSettlementView=z.infer<typeof MiningTaxClaimSettlementSchema>;
export type MiningTaxClaimRecoveryEnvelope=z.infer<typeof MiningTaxClaimRecoveryEnvelopeSchema>;
export type MiningTaxClaimSubmitRequest=z.infer<typeof MiningTaxClaimSubmitRequestSchema>;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function validateMiningTaxClaimRecoveryEnvelope(raw:unknown):MiningTaxClaimRecoveryEnvelope{return freeze(MiningTaxClaimRecoveryEnvelopeSchema.parse(raw));}
/** An acknowledgement is not payment proof. Null custody preserves the request
 * when storage may have failed before or after COMMIT; GET must resolve it. */
export const MiningTaxClaimSubmitResponseSchema=z.object({wallet:Address,idempotencyKey:Id,claimId:Id.nullable(),wire:MiningTaxClaimSignedWireSchema.nullable(),delivery:z.enum(['held','submitted','setup','settled']),reason:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),serverNow:Iso}).strict().superRefine((v,ctx)=>{
 if((v.delivery==='held')!==(v.reason!==undefined))issue(ctx,'held delivery requires a reason');
 if(!v.wire){if(v.claimId!==null||v.delivery!=='held'||v.reason!=='STORAGE_UNCERTAIN')issue(ctx,'unknown custody cannot assert acceptance or delivery');return;}
 if(v.wire.wallet!==v.wallet||v.wire.idempotencyKey!==v.idempotencyKey||v.wire.claimId!==v.claimId||v.reason==='STORAGE_UNCERTAIN'||v.delivery==='setup'&&v.wire.kind!=='setup')issue(ctx,'acknowledgement differs from confirmed custody');
});
export type MiningTaxClaimSubmitResponse=z.infer<typeof MiningTaxClaimSubmitResponseSchema>;
