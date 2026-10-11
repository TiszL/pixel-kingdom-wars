/** Complete settled-root membership only. No current chain claimability authority. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildMiningAllocationTree,encodeMiningAllocationLeaf,encodeMiningAllocationProof,decodeMiningAllocationLeaf,decodeMiningAllocationProof,verifyMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import type { Db,DbOrTx } from '../db/client';
import { getPreparedMiningPublication } from './publicationPreparation';
import { loadAuditedMiningPrior } from './publicationHistory';
import { CUMULATIVE_FREE_MAX_LEAVES as MAX_LEAVES } from './cumulativeFreePublication';
type Code='INVALID_INPUT'|'OWNER_REQUIRED'|'NOT_SETTLED'|'SOURCE_CONFLICT'|'BUSY';
export class MiningClaimEntitlementError extends Error{constructor(readonly code:Code){super(`Mining claim entitlement refused: ${code}`);this.name='MiningClaimEntitlementError';}}
function fail(code:Code):never{throw new MiningClaimEntitlementError(code);}
function key(v:unknown):string{if(typeof v!=='string'||v.length<32||v.length>44)fail('INVALID_INPUT');try{if(new PublicKey(v).toBase58()!==v)fail('INVALID_INPUT');return v;}catch{fail('INVALID_INPUT');}}
const amount=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<(1n<<64n));
const headerSchema=z.object({genesisHash:z.string(),programId:z.string(),configAddress:z.string(),keepMint:z.string(),reserveOwner:z.string(),sequence:amount.refine(v=>v!=='0'),day:amount,root:z.string().regex(/^[0-9a-f]{64}$/),totalCumulative:amount,leafCount:z.number().int().min(1).max(MAX_LEAVES),sourceHash:z.string().regex(/^[0-9a-f]{64}$/),publicationSignature:z.string().min(64).max(88),publicationSlot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export type MiningClaimEntitlementHeader=z.infer<typeof headerSchema>;
export interface MiningClaimEntitlementIdentity{genesisHash:string;programId:string;configAddress:string}
const flags={claimabilityVerified:false,preparationAuthorized:false} as const;
export type MiningClaimEntitlementResult=
 |({kind:'unavailable'}&typeof flags)
 |({kind:'no_allocation';header:MiningClaimEntitlementHeader}&typeof flags)
 |({kind:'entitlement';header:MiningClaimEntitlementHeader;leaf:{wallet:string;cumulativeKeep:string;cumulativeRenown:string;cumulativeDays:string;sequence:string};leafHex:string;proofHex:string;leafIndex:number}&typeof flags);
const headerSql=sql`jsonb_build_object('genesisHash',h.genesis_hash,'programId',h.program_id,'configAddress',h.config_address,'keepMint',h.keep_mint,'reserveOwner',h.reserve_owner,'sequence',h.sequence::text,'day',h.day::text,'root',h.root,'totalCumulative',h.total_cumulative::text,'leafCount',h.leaf_count,'sourceHash',h.source_hash,'publicationSignature',h.publication_signature,'publicationSlot',h.publication_slot) header`;
function parseHeader(v:unknown):MiningClaimEntitlementHeader{const p=headerSchema.safeParse(v);if(!p.success)fail('SOURCE_CONFLICT');try{for(const n of ['genesisHash','programId','configAddress','keepMint','reserveOwner'] as const)key(p.data[n]);if(miningConfigPda(new PublicKey(p.data.programId)).toBase58()!==p.data.configAddress)fail('SOURCE_CONFLICT');return p.data;}catch{fail('SOURCE_CONFLICT');}}
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.mining_claim_entitlement_headers'::regclass) allowed`);if(!r?.allowed)fail('OWNER_REQUIRED');}
async function projected(db:DbOrTx,epochId:string){const [r]=await db.execute<{header:unknown;count:number}>(sql`select ${headerSql},(select count(*)::integer from mining_claim_entitlement_leaves l where l.epoch_id=h.epoch_id) count from mining_claim_entitlement_headers h where h.epoch_id=${epochId}`);if(!r)return null;const h=parseHeader(r.header);if(r.count!==h.leafCount)fail('SOURCE_CONFLICT');return h;}
/** Input never supplies a root, recipient or amount. Every row derives from the
 * complete owner-audited manifest and the already immutable finalized settlement. */
export async function projectMiningClaimEntitlements(db:Db,input:{epochId:string}):Promise<MiningClaimEntitlementHeader>{
 const parsed=z.object({epochId:z.uuid()}).strict().safeParse(input);if(!parsed.success)fail('INVALID_INPUT');const {epochId}=parsed.data;
 try{return await db.transaction(async tx=>{
  await owner(tx);const prior=await projected(tx,epochId);if(prior)return prior;
  await tx.execute(sql`select id from mining_ingot_epochs where id=${epochId} for update nowait`);const again=await projected(tx,epochId);if(again)return again;
  const [settled]=await tx.execute<{receipt:Record<string,unknown>;message_sha256:string}>(sql`select receipt,message_sha256 from mining_publication_settlements where epoch_id=${epochId}`);if(!settled)fail('NOT_SETTLED');
  const p=await getPreparedMiningPublication(tx,epochId);if(!p)fail('SOURCE_CONFLICT');
  const captured=JSON.parse(p.manifestJson);
  if(BigInt(p.publication.sequence)>1n){
   const predecessor=captured.previousPublication;
   if(!predecessor||!z.uuid().safeParse(predecessor.epochId).success||!await projected(tx,predecessor.epochId))fail('SOURCE_CONFLICT');
  }
  const history=await loadAuditedMiningPrior(tx,{genesisHash:captured.funding.source.genesisHash,
   programId:p.publication.programId,configAddress:captured.funding.config.address,
   keepMint:p.publication.keepMint,reserveOwner:p.publication.reserveOwner,
   reviewedDeploymentSlot:captured.funding.source.reviewedDeploymentSlot,
   reviewedProgramDataSha256:captured.funding.source.reviewedProgramDataSha256,sequence:p.publication.sequence});
  if(history.reference.epochId!==epochId||history.reference.sourceHash!==p.sourceHash
   ||p.publication.leafCount>MAX_LEAVES||settled.message_sha256!==p.intentSha256
   ||settled.receipt['sourceHash']!==p.sourceHash||settled.receipt['root']!==p.publication.root)fail('SOURCE_CONFLICT');
  const tree=buildMiningAllocationTree(history.declaration.leaves);
  if(tree.leafCount!==p.publication.leafCount||tree.total!==BigInt(p.publication.total)||Buffer.from(tree.root).toString('hex')!==p.publication.root)fail('SOURCE_CONFLICT');
  await tx.execute(sql`insert into mining_claim_entitlement_headers(epoch_id) values(${epochId})`);
  for(let i=0;i<tree.leafCount;i++){const leaf=tree.leaves[i]!;await tx.execute(sql`insert into mining_claim_entitlement_leaves(epoch_id,wallet,leaf_index,leaf_bytes,proof_bytes) values(${epochId},${leaf.wallet},${i},${Buffer.from(encodeMiningAllocationLeaf(leaf))},${Buffer.from(encodeMiningAllocationProof(tree.proof(i)))})`);}
  const saved=await projected(tx,epochId);if(!saved)fail('SOURCE_CONFLICT');return saved;
 });}catch(e){if(((e as {cause?:{code?:string}}).cause?.code??(e as {code?:string}).code)==='55P03')fail('BUSY');throw e;}
}
/** Authenticated status follows the highest complete projection; a missing newer
 * chain frontier is held by the live assessment, never reported as zero. */
export function createMiningClaimEntitlementReader(db:DbOrTx,identity:MiningClaimEntitlementIdentity){
 return createEntitlementReader(db,identity,null);
}
/** Only saved-artifact recovery selects an immutable historical sequence. Public
 * requests cannot use this to substitute a root for a new claim preparation. */
export function createMiningClaimEntitlementHistoryReader(db:DbOrTx,identity:MiningClaimEntitlementIdentity,sequence:string){
 if(!amount.safeParse(sequence).success||sequence==='0')fail('INVALID_INPUT');
 return createEntitlementReader(db,identity,sequence);
}
function createEntitlementReader(db:DbOrTx,identity:MiningClaimEntitlementIdentity,sequence:string|null){
 const genesisHash=key(identity.genesisHash),programId=key(identity.programId),configAddress=key(identity.configAddress);
 if(miningConfigPda(new PublicKey(programId)).toBase58()!==configAddress)fail('INVALID_INPUT');
 return async(authenticatedWallet:string):Promise<MiningClaimEntitlementResult>=>{
  const wallet=key(authenticatedWallet);
  // One statement sees either the whole committed projection or no header.
  const [row]=await db.execute<{header:unknown;count:number;leaf_hex:string|null;proof_hex:string|null;leaf_index:number|null}>(sql`select ${headerSql},(select count(*)::integer from mining_claim_entitlement_leaves all_leaves where all_leaves.epoch_id=h.epoch_id) count,encode(l.leaf_bytes,'hex') leaf_hex,encode(l.proof_bytes,'hex') proof_hex,l.leaf_index from mining_claim_entitlement_headers h left join mining_claim_entitlement_leaves l on l.epoch_id=h.epoch_id and l.wallet=${wallet} where h.genesis_hash=${genesisHash} and h.program_id=${programId} and h.config_address=${configAddress} ${sequence===null?sql``:sql`and h.sequence=${sequence}::numeric`} order by h.sequence desc limit 1`);
  if(!row)return {kind:'unavailable',...flags};const header=parseHeader(row.header);if(row.count!==header.leafCount)fail('SOURCE_CONFLICT');
  if(row.leaf_hex===null){if(row.proof_hex!==null||row.leaf_index!==null)fail('SOURCE_CONFLICT');return {kind:'no_allocation',header,...flags};}
  try{
   if(row.leaf_hex.length!==130||!row.proof_hex||row.proof_hex.length>1320||row.leaf_index===null||!Number.isInteger(row.leaf_index)||row.leaf_index<0||row.leaf_index>=header.leafCount)fail('SOURCE_CONFLICT');
   const leaf=decodeMiningAllocationLeaf(Buffer.from(row.leaf_hex,'hex')),proof=decodeMiningAllocationProof(Buffer.from(row.proof_hex,'hex'));
   if(leaf.wallet!==wallet||leaf.sequence!==BigInt(header.sequence)||leaf.cumulativeKeep<=0n||!verifyMiningAllocationProof(leaf,proof,Buffer.from(header.root,'hex'),BigInt(header.totalCumulative)))fail('SOURCE_CONFLICT');
   return {kind:'entitlement',header,leaf:{wallet,cumulativeKeep:String(leaf.cumulativeKeep),cumulativeRenown:String(leaf.cumulativeRenown),cumulativeDays:String(leaf.cumulativeDays),sequence:String(leaf.sequence)},leafHex:row.leaf_hex,proofHex:row.proof_hex,leafIndex:row.leaf_index,...flags};
  }catch{fail('SOURCE_CONFLICT');}
 };
}
