/** Immutable unsigned wallet preparations. Historical recovery grants no signing authority. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { PHASE_E_MINING_CLAIM_QUOTE as QUOTE } from '@shardkeep/shared';
import { copyMiningClaimFormat,type MiningClaimFormat } from '@shardkeep/chain/mining-claim-format';
import { buildMiningClaimMessages } from '@shardkeep/chain/mining-claim-message';
import { decodeMiningAllocationLeaf,decodeMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import type { DbOrTx } from '../db/client';
import { createMiningClaimEntitlementHistoryReader } from './claimEntitlement';
import { CUMULATIVE_FREE_MAX_LEAVES } from './cumulativeFreePublication';
type Code='INVALID_INPUT'|'SOURCE_CONFLICT';
export class MiningClaimPreparationStoreError extends Error{constructor(readonly code:Code){super(`Mining claim preparation refused: ${code}`);this.name='MiningClaimPreparationStoreError';}}
function fail(code:Code):never{throw new MiningClaimPreparationStoreError(code);}
const u64=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<(1n<<64n));
const key=z.string().min(32).max(44).refine(v=>{if(v.length<32||v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const hash=z.string().regex(/^[0-9a-f]{64}$/),slot=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const iso=z.string().max(24).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/).refine(v=>v.length===24&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const lookup=z.object({wallet:key,idempotencyKey:z.uuid()}).strict();
const artifactSchema=z.object({
 format:z.custom<MiningClaimFormat>(value=>{try{copyMiningClaimFormat(value);return true;}catch{return false;}}).optional(),
 claimId:z.uuid(),wallet:key,idempotencyKey:z.uuid(),
 header:z.object({genesisHash:key,programId:key,configAddress:key,keepMint:key,reserveOwner:key,sequence:u64.refine(v=>v!=='0'),day:u64,root:hash,totalCumulative:u64,leafCount:z.number().int().min(1).max(CUMULATIVE_FREE_MAX_LEAVES),sourceHash:hash,publicationSignature:z.string().min(64).max(88),publicationSlot:slot}).strict(),
 leafHex:z.string().regex(/^[0-9a-f]{130}$/),proofHex:z.string().min(8).max(1320).regex(/^(?:[0-9a-f]{2})+$/),
 needsAta:z.boolean(),needsMinerRecords:z.boolean(),quoteVersion:z.literal(QUOTE.version),preparedAt:iso,expiresAt:iso,snapshotSlot:slot,blockhashContextSlot:slot,blockhash:key,lastValidBlockHeight:slot,
 payerBalanceLamports:u64,feeLamports:u64,rentLamports:u64,totalLamports:u64,
 transactions:z.array(z.object({kind:z.enum(['combined','setup','claim']),messageHex:z.string().min(2).max(2334).regex(/^(?:[0-9a-f]{2})+$/),messageSha256:hash,packetBytes:z.number().int().min(1).max(1232),feeLamports:u64,rentLamports:u64}).strict()).min(1).max(2),
 state:z.literal('prepared'),currentSigningAuthorized:z.literal(false),claimSubmissionAuthorized:z.literal(false),
}).strict();
export type MiningClaimPreparation=z.infer<typeof artifactSchema>;
export interface MiningClaimPreparationKey{wallet:string;idempotencyKey:string}
function parse(value:unknown,code:Code):MiningClaimPreparation{
 const p=artifactSchema.safeParse(value);if(!p.success)fail(code);const a=p.data;
 try{
  if(a.format&&a.format.blockhashContextSlot!==a.blockhashContextSlot)fail(code);
  if(Date.parse(a.expiresAt)-Date.parse(a.preparedAt)!==QUOTE.ttlSec*1000||a.snapshotSlot<a.header.publicationSlot||a.blockhashContextSlot<a.snapshotSlot)fail(code);
  const fees=a.transactions.reduce((v,t)=>v+BigInt(t.feeLamports),0n),rent=a.transactions.reduce((v,t)=>v+BigInt(t.rentLamports),0n);
  if(fees!==BigInt(a.feeLamports)||rent!==BigInt(a.rentLamports)||fees+rent!==BigInt(a.totalLamports)||BigInt(a.payerBalanceLamports)<fees+rent)fail(code);
  const h=a.header,plan=buildMiningClaimMessages({programId:new PublicKey(h.programId),keepMint:new PublicKey(h.keepMint),reserveOwner:new PublicKey(h.reserveOwner)},{wallet:new PublicKey(a.wallet),root:Buffer.from(h.root,'hex'),sequence:BigInt(h.sequence),day:BigInt(h.day),totalCumulative:BigInt(h.totalCumulative),leaf:decodeMiningAllocationLeaf(Buffer.from(a.leafHex,'hex')),proof:decodeMiningAllocationProof(Buffer.from(a.proofHex,'hex')),blockhash:a.blockhash,needsAta:a.needsAta,needsMinerRecords:a.needsMinerRecords},a.format);
  if(plan.transactions.length!==a.transactions.length)fail(code);
  for(let i=0;i<plan.transactions.length;i++){const wanted=plan.transactions[i]!,saved=a.transactions[i]!;
   if(saved.kind!==wanted.kind||saved.messageHex!==Buffer.from(wanted.messageBytes).toString('hex')||saved.messageSha256!==wanted.messageSha256||saved.packetBytes!==wanted.packetBytes||(wanted.expectedNewAccounts.length===0&&saved.rentLamports!=='0'))fail(code);
  }
  return a;
 }catch{fail(code);}
}
async function audit(db:DbOrTx,a:MiningClaimPreparation){
 const own=await createMiningClaimEntitlementHistoryReader(db,a.header,a.header.sequence)(a.wallet);
 if(own.kind!=='entitlement'||own.leafHex!==a.leafHex||own.proofHex!==a.proofHex||Object.entries(own.header).some(([k,v])=>a.header[k as keyof typeof a.header]!==v))fail('SOURCE_CONFLICT');
}
/** Wallet is authenticated by the future route. This is only historical recovery. */
export async function getMiningClaimPreparation(db:DbOrTx,input:MiningClaimPreparationKey):Promise<MiningClaimPreparation|null>{
 const p=lookup.safeParse(input);if(!p.success)fail('INVALID_INPUT');
 const [row]=await db.execute<{artifact:unknown}>(sql`select artifact from mining_claim_preparations where wallet=${p.data.wallet} and idempotency_key=${p.data.idempotencyKey}`);
 if(!row)return null;const a=parse(row.artifact,'SOURCE_CONFLICT');if(a.wallet!==p.data.wallet||a.idempotencyKey!==p.data.idempotencyKey)fail('SOURCE_CONFLICT');await audit(db,a);return a;
}
/** The request body is the UUID key only. A competing valid observation loses
 * to the saved artifact, including its original blockhash and quote expiry. */
export async function saveMiningClaimPreparation(db:DbOrTx,input:MiningClaimPreparation):Promise<MiningClaimPreparation>{
 const a=parse(input,'INVALID_INPUT'),request={wallet:a.wallet,idempotencyKey:a.idempotencyKey};
 const prior=await getMiningClaimPreparation(db,request);if(prior)return prior;await audit(db,a);
 await db.execute(sql`insert into mining_claim_preparations(artifact) values(${JSON.stringify(a)}::jsonb) on conflict(wallet,idempotency_key) do nothing`);
 const saved=await getMiningClaimPreparation(db,request);if(!saved)fail('SOURCE_CONFLICT');return saved;
}
