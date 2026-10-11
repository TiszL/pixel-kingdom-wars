/** Retained original-spot tax consent, subpath only. This grammar authenticates
 * neither chain finality nor a message hash/PDA/signature. Clients must separately
 * verify exact legacy ABI bytes against independently reviewed deployment pins.
 * Full auction snapshots remain private; historical parsing uses saved terms. */
import {z} from 'zod';
import {PHASE_E_MINING_CLAIM_QUOTE,PHASE_E_POLICY} from './constants';
// New preparations share the existing operational signing window. Its original
// duration is saved below; historical decode never rereads today's duration.
export const MINING_TAX_CLAIM_QUOTE_POLICY=PHASE_E_MINING_CLAIM_QUOTE;
const U64=(1n<<64n)-1n,I64=(1n<<63n)-1n;
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function address(v:string):boolean{
 if(v.length<32||v.length>44||v==='1'.repeat(32)||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(v))return false;
 let n=0n;for(const c of v)n=n*58n+BigInt(alphabet.indexOf(c));let bytes=0;while(n){bytes++;n>>=8n;}
 return bytes+(v.match(/^1*/)?.[0].length??0)===32;
}
function amount(v:string,max=U64):bigint|null{
 if(v.length>20||!/^(0|[1-9][0-9]{0,19})$/.test(v))return null;const n=BigInt(v);return n<=max?n:null;
}
const Address=z.string().max(44).refine(address),Id=z.uuid().refine(v=>v===v.toLowerCase()),Hash=z.string().regex(/^[0-9a-f]{64}$/);
const Amount=z.string().max(20).refine(v=>amount(v)!==null),Positive=Amount.refine(v=>{const n=amount(v);return n!==null&&n>0n;});
const Timestamp=Amount.refine(v=>amount(v,I64)!==null),Count=z.number().int().nonnegative().safe();
const Iso=z.string().length(24).refine(v=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const issue=(ctx:z.RefinementCtx,message:string)=>ctx.addIssue({code:'custom',message});
// Wire-size/resource limits, not current game periods, prices or eligibility.
const bounded=<T extends z.ZodType>(item:T,max:number,min=0)=>z.preprocess(v=>Array.isArray(v)&&v.length<=max?v:null,z.array(item).min(min).max(max));
const Caps=z.object({maxFeeLamports:Amount,maxRentLamports:Amount,maxTotalLamports:Amount}).strict();
export const MiningTaxClaimPrepareRequestSchema=z.object({idempotencyKey:Id,round:Amount,
 spot:Count.max(PHASE_E_POLICY.seekerIsland.totalSpots-1),caps:Caps}).strict();
const Account=z.object({address:Address,space:Count.min(1).max(1232),rentLamports:Amount}).strict();
const Transaction=z.object({ordinal:Count.max(1),kind:z.enum(['combined','setup','claim']),
 messageHex:z.string().min(2).max(2334).regex(/^(?:[0-9a-f]{2})+$/),messageSha256:Hash,packetBytes:Count.min(66).max(1232),
 feeLamports:Amount,rentLamports:Amount,newAccounts:bounded(Account,10)}).strict();
export const MiningTaxClaimPreparationSchema=z.object({
 version:z.literal(1),wallet:Address,idempotencyKey:Id,claimId:Id,round:Amount,
 // Historical ABI fields use their binary widths; current spot admission is
 // exclusively the prepare request and authoritative server's responsibility.
 spot:Count.max(255),caps:Caps,quoteVersion:z.literal(1),quoteTtlSec:Count.min(1),preparedAt:Iso,expiresAt:Iso,
 identity:z.object({genesisHash:Address,programId:Address,configAddress:Address,keepMint:Address,reserveOwner:Address,
  auctionConfig:Address,term:Address,registry:Address,registryHash:Hash,pool:Address,cursor:Address,auction:Address,
  claimantAta:Address,originalWinner:Address}).strict(),
 term:z.object({auctionStart:Timestamp,auctionEnd:Timestamp,operatingStart:Timestamp,operatingEnd:Timestamp,
  completedAt:Timestamp,completedSlot:Amount,winnerCount:Count.min(1).max(65535),distributionVersion:z.literal(1)}).strict(),
 source:z.object({genesisHash:Address,programId:Address,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:Hash,
  firstSnapshotSlot:Count,snapshotSlot:Count,blockhashSlot:Count,feeSlot:Count,snapshotSha256:Hash}).strict(),
 snapshot:z.object({unixTimestamp:Timestamp,claimedBaseUnits:Amount,poolAccruedBaseUnits:Amount}).strict(),
 intended:z.object({claimBaseUnits:Positive,cumulativeBaseUnits:Positive,dustBaseUnits:Amount}).strict(),
 setup:z.object({needsAta:z.boolean(),needsPool:z.boolean(),needsCursor:z.boolean(),accrualDays:bounded(Amount,10)}).strict(),
 blockhash:Address,lastValidBlockHeight:Count,blockHeight:Count,
 fees:z.object({feeLamports:Amount,rentLamports:Amount,totalLamports:Amount,payerBalanceLamports:Amount}).strict(),
 transactions:bounded(Transaction,2,1),state:z.literal('prepared'),currentSigningAuthorized:z.literal(false),submissionAuthorized:z.literal(false),
}).strict().superRefine((p,ctx)=>{
 const i=p.identity,t=p.term,s=p.source,n=p.snapshot,a=p.intended,setup=p.setup,txs=p.transactions;
 if(i.originalWinner!==p.wallet||s.genesisHash!==i.genesisHash||s.programId!==i.programId)issue(ctx,'original winner or source identity differs');
 if(Date.parse(p.expiresAt)<=Date.parse(p.preparedAt)||(Date.parse(p.expiresAt)-Date.parse(p.preparedAt))/1000!==p.quoteTtlSec)issue(ctx,'saved quote duration differs');
 if(s.firstSnapshotSlot<s.reviewedDeploymentSlot||s.blockhashSlot<s.firstSnapshotSlot||s.feeSlot<s.blockhashSlot||s.snapshotSlot<s.feeSlot||p.blockHeight>p.lastValidBlockHeight)issue(ctx,'quote observation order differs');
 const values=[p.round,...Object.values(p.caps),t.auctionStart,t.auctionEnd,t.operatingStart,t.operatingEnd,t.completedAt,t.completedSlot,
  ...Object.values(n),...Object.values(a),...setup.accrualDays,...Object.values(p.fees),...txs.flatMap(x=>[x.feeLamports,x.rentLamports,...x.newAccounts.map(r=>r.rentLamports)])];
 if(values.some(v=>amount(v)===null))return;
 if(BigInt(t.auctionStart)>=BigInt(t.auctionEnd)||t.auctionEnd!==t.operatingStart||BigInt(t.operatingStart)>=BigInt(t.operatingEnd)
  ||BigInt(t.completedAt)<BigInt(t.auctionEnd)||BigInt(t.completedAt)>BigInt(n.unixTimestamp)
  ||BigInt(t.completedSlot)<=BigInt(s.reviewedDeploymentSlot)||BigInt(t.completedSlot)>BigInt(s.firstSnapshotSlot))issue(ctx,'original term or Clock evidence differs');
 const claim=BigInt(a.claimBaseUnits),cumulative=BigInt(a.cumulativeBaseUnits),dust=BigInt(a.dustBaseUnits),winners=BigInt(t.winnerCount),accrued=cumulative*winners+dust;
 if(BigInt(n.claimedBaseUnits)+claim!==cumulative||dust>=winners||accrued>U64||accrued<BigInt(n.poolAccruedBaseUnits))issue(ctx,'original claimant delta or distribution differs');
 if(setup.accrualDays.length===0&&accrued!==BigInt(n.poolAccruedBaseUnits))issue(ctx,'pool changed without a new accrual instruction');
 if(setup.needsPool&&(!setup.needsCursor||n.poolAccruedBaseUnits!=='0')||setup.needsCursor&&n.claimedBaseUnits!=='0')issue(ctx,'absent original setup has counters');
 if(setup.accrualDays.some((day,j)=>j>0&&BigInt(day)<=BigInt(setup.accrualDays[j-1]!)))issue(ctx,'accrual days must be ordered and unique');
 const needsSetup=setup.needsAta||setup.needsPool||setup.needsCursor||setup.accrualDays.length>0;
 if(txs.length===1?txs[0]!.kind!==(needsSetup?'combined':'claim'):!needsSetup||txs[0]!.kind!=='setup'||txs[1]!.kind!=='claim')issue(ctx,'original transaction order differs');
 if(txs.some((tx,j)=>tx.ordinal!==j||tx.messageHex.slice(0,2)!=='01'||tx.packetBytes!==65+tx.messageHex.length/2
  ||tx.kind==='claim'&&(tx.newAccounts.length!==0||tx.rentLamports!=='0')))issue(ctx,'original packet or claim rent differs');
 if(new Set(txs.map(tx=>tx.messageHex)).size!==txs.length||new Set(txs.map(tx=>tx.messageSha256)).size!==txs.length)issue(ctx,'duplicate original transactions');
 const accounts=txs.flatMap(tx=>tx.newAccounts),count=Number(setup.needsAta)+Number(setup.needsPool)+Number(setup.needsCursor)+setup.accrualDays.length;
 if(accounts.length!==count||accounts.length>10||new Set(accounts.map(r=>r.address)).size!==accounts.length)issue(ctx,'original new account roster differs');
 let index=0;if(setup.needsAta&&accounts[index++]?.address!==i.claimantAta)issue(ctx,'ATA roster differs');
 if(setup.needsPool&&accounts[index++]?.address!==i.pool)issue(ctx,'pool roster differs');
 index+=setup.accrualDays.length;if(setup.needsCursor&&accounts[index]?.address!==i.cursor)issue(ctx,'cursor roster differs');
 let fee=0n,rent=0n;for(const tx of txs){const localRent=tx.newAccounts.reduce((sum,r)=>sum+BigInt(r.rentLamports),0n);
  if(localRent!==BigInt(tx.rentLamports))issue(ctx,'per-message rent differs');fee+=BigInt(tx.feeLamports);rent+=localRent;}
 if(fee!==BigInt(p.fees.feeLamports)||rent!==BigInt(p.fees.rentLamports)||fee+rent!==BigInt(p.fees.totalLamports)
  ||fee>BigInt(p.caps.maxFeeLamports)||rent>BigInt(p.caps.maxRentLamports)||fee+rent>BigInt(p.caps.maxTotalLamports)||fee+rent>BigInt(p.fees.payerBalanceLamports))issue(ctx,'saved SOL cost bounds differ');
});
export const MiningTaxClaimPreparationEnvelopeSchema=z.object({wallet:Address,idempotencyKey:Id,status:z.enum(['unknown','prepared']),
 preparation:MiningTaxClaimPreparationSchema.nullable(),serverNow:Iso}).strict().superRefine((v,ctx)=>{
 if((v.status==='unknown')!==(v.preparation===null)||v.preparation&&(v.preparation.wallet!==v.wallet||v.preparation.idempotencyKey!==v.idempotencyKey))issue(ctx,'original preparation recovery differs');
});
export type MiningTaxClaimPrepareRequest=z.infer<typeof MiningTaxClaimPrepareRequestSchema>;
export type MiningTaxClaimPreparation=z.infer<typeof MiningTaxClaimPreparationSchema>;
export type MiningTaxClaimPreparationEnvelope=z.infer<typeof MiningTaxClaimPreparationEnvelopeSchema>;
