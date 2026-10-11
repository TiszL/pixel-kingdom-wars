/** Browser consistency checks for an authenticated owner's historical settlement
 * attestation. The purchaseFinalized field is the server's assertion, not an
 * independent browser RPC-finality proof. This module neither decodes receipt ABI
 * bytes nor verifies hashes, signatures or PDAs, and grants no action authority.
 * Canonical account decoding and cryptographic wire/receipt binding are separate.
 * Subpath only: no Node, chain, Anchor or wallet dependencies. */
import {z} from 'zod';
import {PHASE_E_POLICY,PHASE_E_MINING_PUBLICATION} from './constants';
import {RealmSalePreparationSchema,RealmSaleSignedWireSchema} from './realmSalesApi';
const P=PHASE_E_POLICY.seekerIsland,U64=(1n<<64n)-1n,I64=(1n<<63n)-1n;
// Protocol serialization length, not an economic or gameplay number.
const RECEIPT_HEX_LENGTH=294*2;
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111',CLOCK='SysvarC1ock11111111111111111111111111111111',SYSVAR='Sysvar1111111111111111111111111111111111111';
function unsigned(value:string,max=U64):bigint|null{if(value.length>20||!/^(0|[1-9][0-9]{0,19})$/.test(value))return null;const n=BigInt(value);return n<=max?n:null;}
const Amount=z.string().max(20).refine(v=>unsigned(v)!==null),Timestamp=Amount.refine(v=>unsigned(v,I64)!==null);
const Address=z.string().min(32).max(44).refine(v=>v.length>=32&&v.length<=44&&/^[1-9A-HJ-NP-Za-km-z]+$/.test(v));
const Id=z.uuid().refine(v=>v===v.toLowerCase()),Hash=z.string().length(64).refine(v=>v.length===64&&/^[0-9a-f]{64}$/.test(v));
const SaleId=z.string().length(32).refine(v=>v.length===32&&/^[0-9a-f]{32}$/.test(v)&&v!=='00'.repeat(16));
const Signature=z.string().min(64).max(88).refine(v=>v.length>=64&&v.length<=88&&/^[1-9A-HJ-NP-Za-km-z]+$/.test(v)&&v!=='1'.repeat(64));
const Count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SettledAt=z.string().length(27).refine(v=>v.length===27&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23));
const Account=z.object({address:Address,exists:z.literal(true),owner:Address,executable:z.boolean(),dataSha256:Hash}).strict();
const Rent=z.object({address:Address,lamports:Amount}).strict();
// Zod checks array length after elements; preflight before any child traversal.
const Accounts=z.preprocess(v=>Array.isArray(v)&&v.length===6?v:null,z.array(Account).length(6));
const Rents=z.preprocess(v=>Array.isArray(v)&&v.length>=1&&v.length<=3?v:null,z.array(Rent).min(1).max(3));
export const RealmSaleSettlementSchema=z.object({wallet:Address,idempotencyKey:Id,saleId:SaleId,signature:Signature,
 receipt:z.object({version:z.literal(1),signature:Signature,slot:Count,blockTime:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  originalMessageSha256:Hash,signedTransactionSha256:Hash,receiptAccountHex:z.string().length(RECEIPT_HEX_LENGTH).refine(v=>v.length===RECEIPT_HEX_LENGTH&&/^[0-9a-f]+$/.test(v)),
  feeLamports:Amount,actualRentLamports:Amount,buyerNetPaymentLamports:Amount,accountRentIncreases:Rents,observedAccountSlot:Count,proofClockUnixTimestamp:Timestamp,
  source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),stateProvenance:z.literal('fresh-reviewed-deployment'),genesisHash:Address,programId:Address,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:Hash,upgradeAuthority:Address.nullable(),accounts:Accounts}).strict(),
 }).strict(),
 purchase:z.object({address:Address,buyer:Address,seller:Address,developer:Address,spot:Count.max(P.totalSpots-1),realm:Count.max(P.realmCount-1),round:Amount,day:Amount,
  acceptedAt:Timestamp,priorExpiry:Timestamp,coverageStart:Timestamp,expiresAt:Timestamp,priceLamports:Amount,sellerLamports:Amount,developerLamports:Amount}).strict(),
 settledAt:SettledAt,purchaseFinalized:z.literal(true),admissionAuthorized:z.literal(false),relayAuthorized:z.literal(false),signingAuthorized:z.literal(false),
}).strict();
export type RealmSaleSettlementView=z.infer<typeof RealmSaleSettlementSchema>;
// Called only on the already parsed, strictly bounded, owned DTO tree.
function freeze<T>(value:T):T{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
/** Bind an authenticated owner attestation to the retained ORIGINAL consent and
 * wire metadata. String equality binds declared hashes; it does not recompute
 * them. Known addresses are compared, never derived as PDAs here. The original
 * preparation does not pin upgradeAuthority, so that field is syntax-only.
 * Historical success does not require a fresh quote or current eligibility. */
export function validateRealmSaleSettlement(preparation:unknown,wireMetadata:unknown,raw:unknown):RealmSaleSettlementView{
 const p=RealmSalePreparationSchema.parse(preparation),w=RealmSaleSignedWireSchema.parse(wireMetadata),s=RealmSaleSettlementSchema.parse(raw),r=s.receipt,t=r.source,q=p.quote,b=s.purchase;
 const refuse=()=>{throw new Error('Realm sale settlement does not match original consent');};
 if(s.wallet!==p.wallet||s.idempotencyKey!==p.idempotencyKey||s.saleId!==p.saleId||w.wallet!==p.wallet||w.idempotencyKey!==p.idempotencyKey||w.saleId!==p.saleId
  ||s.signature!==w.signature||r.signature!==w.signature||w.messageSha256!==q.messageSha256||r.originalMessageSha256!==q.messageSha256||r.signedTransactionSha256!==w.wireSha256
  ||w.signedTransactionHex.slice(130)!==q.messageHex)refuse();
 if(t.genesisHash!==p.source.genesisHash||t.programId!==p.source.programId||t.reviewedDeploymentSlot!==p.source.reviewedDeploymentSlot||t.reviewedProgramDataSha256!==p.source.programDataSha256
  ||r.slot<=t.reviewedDeploymentSlot||r.slot<p.source.admissionSlot||r.observedAccountSlot<r.slot)refuse();
 if(b.buyer!==p.wallet||b.seller!==p.terms.seller||b.developer!==p.terms.developer||b.spot!==p.spot||b.realm!==p.realm||b.round!==p.terms.round||b.day!==p.terms.day||b.priorExpiry!==p.terms.priorExpiry)refuse();
 const accepted=BigInt(b.acceptedAt),prior=BigInt(b.priorExpiry),start=accepted>prior?accepted:prior,expiry=start+BigInt(P.permitDurationSec);
 if(accepted<BigInt(p.terms.validAfter)||accepted>BigInt(p.terms.validUntil)||accepted/BigInt(PHASE_E_MINING_PUBLICATION.daySec)!==BigInt(p.terms.day)
  ||accepted>BigInt(r.proofClockUnixTimestamp)||BigInt(b.coverageStart)!==start||expiry>I64||BigInt(b.expiresAt)!==expiry)refuse();
 const price=BigInt(P.permitPriceLamports),seller=price*BigInt(P.contractSellerBps)/BigInt(PHASE_E_POLICY.basisPoints),developer=price*BigInt(P.contractDevBps)/BigInt(PHASE_E_POLICY.basisPoints);
 if(BigInt(b.priceLamports)!==price||BigInt(b.sellerLamports)!==seller||BigInt(b.developerLamports)!==developer||seller+developer!==price||r.buyerNetPaymentLamports!==q.paymentDebitLamports)refuse();
 if(r.accountRentIncreases.length!==q.rents.length||new Set(r.accountRentIncreases.map(a=>a.address)).size!==r.accountRentIncreases.length)refuse();
 let rent=0n;for(const [i,entry]of r.accountRentIncreases.entries()){const cap=q.rents[i]!;if(entry.address!==cap.address||BigInt(entry.lamports)>BigInt(cap.maxIncreaseLamports))refuse();rent+=BigInt(entry.lamports);}
 if(rent!==BigInt(r.actualRentLamports)||rent>BigInt(q.rentLamports)||BigInt(r.feeLamports)>BigInt(q.feeLamports)||rent+BigInt(r.feeLamports)+BigInt(r.buyerNetPaymentLamports)>BigInt(q.requiredLamports))refuse();
 if(new Set(t.accounts.map(a=>a.address)).size!==t.accounts.length)refuse();
 for(const [i,a]of t.accounts.entries())if(a.owner!==(i<2?LOADER:i===4?SYSVAR:t.programId)||a.executable!==(i===0))refuse();
 const accounts=t.accounts;
 if(accounts[0]!.address!==p.source.programId||accounts[1]!.dataSha256!==p.source.programDataSha256||accounts[4]!.address!==CLOCK
  ||accounts[5]!.address!==b.address||b.address!==q.rents[q.rents.length-1]!.address||(q.needsAccess&&accounts[3]!.address!==q.rents[0]!.address))refuse();
 return freeze(s);
}
