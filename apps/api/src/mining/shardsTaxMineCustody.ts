import { mineProductionClockSchema, mineProductionRemainder, mineUnitCompletion, readMineProductionClock } from './shardsTaxMineProduction';
/** Read-only recovery evidence for an already materialized original Mine range.
 * Registered roster history supplies the historical base class and deed mapping;
 * deeded sources additionally require the complete archival ownership verifier.
 * No current owner, copied segment status or serialized certificate admits tax. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {readDeedMiningWalletEvidence} from '@shardkeep/chain/mining-wallet';
import type {Db,DbOrTx} from '../db/client';
import {MINE_DAY_MS} from '../game/baseMining';
import {HttpError} from '../lib/errors';
import type {DeedMiningRosterSource} from './deedRosterQualification';
import {readMiningRosterHistory,MiningRosterHistoryError} from './rosterHistory';
import {readMiningRosterInterval,type MiningRosterIntervalEvidence} from './rosterIntervalHistory';
import {readMiningRosterCheckpointInterval,type MiningRosterCheckpointIntervalEvidence} from './rosterCheckpointHistory';

// Private work bound, not a production rate or an economic eligibility rule.
const MAX_CLOSED_DAYS=32;
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const quantity=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=RAW_RESOURCE_STORAGE_MAX);
const instant=z.string().length(24).datetime({precision:3}).refine(v=>Number.isSafeInteger(Date.parse(v))&&new Date(v).toISOString()===v);
const sourceSchema=z.object({id:uuid,mineId:uuid,baseId:uuid,wallet:key,admissionId:uuid.nullable(),
 ownershipStatus:z.enum(['confirmed','custody_unresolved']),sourceKey:z.string(),anchorAt:instant,startsAt:instant,endsAt:instant,
 quota:quantity,firstUnit:quantity,lastUnit:quantity,gross:quantity,productionClock:mineProductionClockSchema.optional()}).strict();
export type PhysicalMineCustodySegment=Readonly<z.infer<typeof sourceSchema>>;
type Roster=Awaited<ReturnType<typeof readMiningRosterHistory>>;
type Deeds=Awaited<ReturnType<typeof readDeedMiningWalletEvidence>>;
type PortableDeeds=Readonly<Omit<Deeds,'startAt'|'endAt'>&{startAt:string;endAt:string}>;
function held(reason:string):never{throw new HttpError(503,`Mine original custody held: ${reason}`,'SHARDS_MINE_CUSTODY_UNAVAILABLE');}
// Only a narrower registered-history proof may recover these coverage gaps.
// Identity conflicts, provider failures and source rechecks never use fallback.
class RegisteredMineCoverageError extends HttpError {constructor(reason:string){super(503,`Mine original custody held: ${reason}`,'SHARDS_MINE_CUSTODY_UNAVAILABLE');}}
function coverage(reason:string):never{throw new RegisteredMineCoverageError(reason);}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
// JSONB may reorder object keys; arrays and exact values remain evidence.
// This representation helper does not authenticate a copied proof.
export function hashPhysicalMineCustodyEvidence(value:Pick<PhysicalMineCustodyEvidence,'version'|'purpose'|'segment'|'rosters'|'deeds'>):string{
 const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?
  Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical((v as Record<string,unknown>)[k])])):v;
 return createHash('sha256').update(JSON.stringify(canonical({version:value.version,purpose:value.purpose,segment:value.segment,rosters:value.rosters,deeds:value.deeds}))).digest('hex');
}

async function readSegment(db:DbOrTx,id:string):Promise<PhysicalMineCustodySegment>{
 const [row]=await db.execute<{original:unknown;precise:boolean}>(sql`select jsonb_build_object(
  'id',s.id,'mineId',s.mine_id,'baseId',s.base_id,'wallet',s.wallet,'admissionId',s.admission_id,
  'ownershipStatus',s.ownership_status,'sourceKey',s.source_key,
  'anchorAt',to_char(s.anchor_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'startsAt',to_char(s.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'endsAt',to_char(s.ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'quota',s.quota::text,'firstUnit',s.first_unit::text,'lastUnit',s.last_unit::text,'gross',s.gross::text) original,
  (s.anchor_at=date_trunc('milliseconds',s.anchor_at) and s.starts_at=date_trunc('milliseconds',s.starts_at)
   and s.ends_at=date_trunc('milliseconds',s.ends_at) and s.base_id=e.base_id) is true precise
  from shards_mine_segments s join shards_mine_eras e on e.mine_id=s.mine_id where s.id=${id}`);
 if(!row?.precise)held('original source is unavailable or imprecise');
 const productionClock=await readMineProductionClock(db,id,(row.original as {sourceKey:string}).sourceKey);
 const parsed=sourceSchema.safeParse(productionClock?{...row.original as Record<string,unknown>,productionClock}:row.original);if(!parsed.success)held('original physical source required');
 const s=parsed.data,quota=BigInt(s.quota),first=BigInt(s.firstUnit),last=BigInt(s.lastUnit),gross=BigInt(s.gross);
 if(s.admissionId!==null||quota<=0n||first<=0n||last<first||gross!==last-first+1n
  ||!new RegExp(`^mine:${s.mineId}:v(0|[1-9][0-9]*):u${first}${s.productionClock?':p'+s.productionClock.settlementId:''}$`).test(s.sourceKey))held('uncovered original unit range required');
 const completion=(unit:bigint)=>mineUnitCompletion(BigInt(Date.parse(s.anchorAt)),quota,BigInt(MINE_DAY_MS),unit,mineProductionRemainder(s.productionClock,BigInt(MINE_DAY_MS)));
 if(completion(first)!==BigInt(Date.parse(s.startsAt))||completion(last)!==BigInt(Date.parse(s.endsAt)))held('original unit completion differs');
 return freeze(s);
}
export interface PhysicalMineClosedDayCustodyEvidence{
 readonly version:1;readonly purpose:'historical_physical_mine_custody';readonly segment:PhysicalMineCustodySegment;
 readonly rosters:readonly Roster[];readonly deeds:PortableDeeds|null;
 readonly custody:Readonly<{status:'confirmed';wallet:string;baseId:string;classification:'registered_free'|'deeded';assetId:string|null;
  startsAt:string;endsAt:string;evidenceSha256:string}>;
 readonly sourceVerified:true;readonly postingAuthorized:false;readonly payoutAuthorized:false;readonly operatingAdmissionAuthorized:false;
}
export type PhysicalMineIntervalCustodyEvidence=Readonly<Omit<PhysicalMineClosedDayCustodyEvidence,'version'|'rosters'>&{
 version:2;rosters:readonly MiningRosterIntervalEvidence[];
}>;
export type PhysicalMineCheckpointCustodyEvidence=Readonly<Omit<PhysicalMineClosedDayCustodyEvidence,'version'|'rosters'>&{
 version:3;rosters:readonly MiningRosterCheckpointIntervalEvidence[];
}>;
export type PhysicalMineCustodyEvidence=PhysicalMineClosedDayCustodyEvidence|PhysicalMineIntervalCustodyEvidence|PhysicalMineCheckpointCustodyEvidence;
/** No transaction may retain gameplay locks across the optional archival read.
 * Missing prospective roster coverage stays held; this never initializes or
 * backfills a baseline, changes quantity or consults current base ownership. */
async function prefetchClosedPhysicalMineCustody(db:Db,segmentId:string,configured?:DeedMiningRosterSource):Promise<PhysicalMineClosedDayCustodyEvidence>{
 uuid.parse(segmentId);if('rollback' in db)held('top-level database required');
 // Detach the application-owned source policy before any await.
 const source=configured?{source:configured.source,collection:configured.collection,expectedGenesisHash:configured.expectedGenesisHash}:undefined;
 const before=await readSegment(db,segmentId),firstMs=Date.parse(before.startsAt),lastMs=Date.parse(before.endsAt);
 const startMs=Math.floor(firstMs/MINE_DAY_MS)*MINE_DAY_MS,endMs=(Math.floor(lastMs/MINE_DAY_MS)+1)*MINE_DAY_MS;
 const days=(endMs-startMs)/MINE_DAY_MS;
 if(!Number.isSafeInteger(days)||days<1||days>MAX_CLOSED_DAYS||!Number.isFinite(new Date(endMs).getTime()))held('historical work bound exceeded');
 const rosters:Roster[]=[];let classification:'registered_free'|'deeded'|undefined,assetId:string|null=null;
 for(let dayMs=startMs;dayMs<endMs;dayMs+=MINE_DAY_MS){
  const day=new Date(dayMs).toISOString().slice(0,10);
  const roster=await readMiningRosterHistory(db,{wallet:before.wallet,day,policyVersion:1});
  const open=roster.open.bases.find(b=>b.id===before.baseId),close=roster.close.bases.find(b=>b.id===before.baseId);
  const slots=roster.open.slots.filter(s=>s.base_id===before.baseId),closedSlots=roster.close.slots.filter(s=>s.base_id===before.baseId);
  if(roster.wallet!==before.wallet||roster.day!==day||roster.policyVersion!==1
   ||!roster.open.facts.sourceIdentityConsistent||!roster.close.facts.sourceIdentityConsistent
   ||slots.length>1||closedSlots.length>1
   ||[open,close].some(b=>b&&b.owner_wallet!==before.wallet)
   ||[...slots,...closedSlots].some(s=>s.wallet!==before.wallet))held('registered custody identity conflicts');
  // Coverage fallback cannot erase an identity conflict in either day edge.
  for(const snapshot of [roster.open,roster.close]){
   const target=snapshot.bases.find(b=>b.id===before.baseId);if(!target)continue;
   const assets=[target.deed_asset_id,target.deed_mint_asset_id].filter((v):v is string=>v!==null);
   if(assets.some(v=>!key.safeParse(v).success)
    ||target.deed_asset_id!==null&&target.deed_mint_asset_id!==null&&target.deed_asset_id!==target.deed_mint_asset_id)held('original deed identity conflicts');
   if(snapshot.bases.some(b=>b.id!==before.baseId&&assets.some(v=>b.deed_asset_id===v||b.deed_mint_asset_id===v)))held('ambiguous registered deed');
  }
  if(!open||!close||roster.continuityBrokenBaseIds.includes(before.baseId)||JSON.stringify(open)!==JSON.stringify(close)
   ||open.status!=='active'||slots.length!==1||!slots[0]!.active
   ||JSON.stringify(slots)!==JSON.stringify(closedSlots))coverage('registered custody changed or is unavailable');
  const free=open.land_paid_at===null&&open.deed_asset_id===null&&open.deed_mint_asset_id===null&&open.deed_minting_at===null;
  if(free){if(classification==='deeded')coverage('original base classification changed');classification='registered_free';}
  else{
   if(open.land_paid_at===null||Date.parse(open.land_paid_at)>=dayMs||open.deed_asset_id===null||open.deed_minting_at!==null
    ||classification==='registered_free'||assetId!==null&&assetId!==open.deed_asset_id)coverage('original deed classification unavailable');
   classification='deeded';assetId=open.deed_asset_id;
  }
  rosters.push(roster);
 }
 let deeds:PortableDeeds|null=null;
 if(classification==='deeded'){
  if(!source||!key.safeParse(source.collection).success||!key.safeParse(source.expectedGenesisHash).success)held('configured archival source required');
  const proof=await readDeedMiningWalletEvidence(source.source,{collection:source.collection,expectedGenesisHash:source.expectedGenesisHash,
   targetWallet:before.wallet,startAt:new Date(startMs),endAt:new Date(endMs)});
  if(proof.collection!==source.collection||proof.genesisHash!==source.expectedGenesisHash||proof.targetWallet!==before.wallet
   ||+proof.startAt!==startMs||+proof.endAt!==endMs||proof.throughBlockTime*1000<endMs
   ||!proof.continuouslyHeldAssetIds.includes(assetId!)||proof.evidence.trust!=='trusted-finalized-rpc'
   ||proof.evidence.addressIndexCompleteness!=='configured-provider-trust')held('original deed was not continuously held');
  deeds=freeze({...proof,startAt:proof.startAt.toISOString(),endAt:proof.endAt.toISOString()});
 }
 const after=await readSegment(db,segmentId);if(JSON.stringify(after)!==JSON.stringify(before))held('original source changed during prefetch');
 const startsAt=new Date(startMs).toISOString(),endsAt=new Date(endMs).toISOString();
 const evidenceSha256=hashPhysicalMineCustodyEvidence({version:1,purpose:'historical_physical_mine_custody',segment:before,rosters,deeds});
 return freeze({version:1,purpose:'historical_physical_mine_custody',segment:before,rosters,deeds,
  custody:{status:'confirmed',wallet:before.wallet,baseId:before.baseId,classification:classification!,assetId,startsAt,endsAt,evidenceSha256},
  sourceVerified:true,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
}

/** Preserve the closed-day proof format. Only absent/open day coverage permits
 * separately versioned unchanged-baseline or checkpoint interval proofs. */
export async function prefetchPhysicalMineCustody(db:Db,segmentId:string,configured?:DeedMiningRosterSource):Promise<PhysicalMineCustodyEvidence>{
 const source=configured?{source:configured.source,collection:configured.collection,expectedGenesisHash:configured.expectedGenesisHash}:undefined;
 try{return await prefetchClosedPhysicalMineCustody(db,segmentId,source);}
 catch(error){if(!(error instanceof RegisteredMineCoverageError)&&(!(error instanceof MiningRosterHistoryError)||!['DAY_OPEN','COVERAGE_UNAVAILABLE'].includes(error.code)))throw error;}
 const before=await readSegment(db,segmentId),start=Date.parse(before.startsAt),end=Date.parse(before.endsAt)+1;
 if(!Number.isSafeInteger(end)||!Number.isFinite(new Date(end).getTime())||end<=start||end-start>MAX_CLOSED_DAYS*MINE_DAY_MS)held('original interval is unavailable');
 const startsAt=new Date(start).toISOString(),endsAt=new Date(end).toISOString();
 const interval={wallet:before.wallet,baseId:before.baseId,startsAt,endsAt};
 let roster:MiningRosterIntervalEvidence|MiningRosterCheckpointIntervalEvidence;
 try{roster=await readMiningRosterInterval(db,interval);}
 catch(error){
  if(!(error instanceof MiningRosterHistoryError)||error.code!=='COVERAGE_UNAVAILABLE')throw error;
  roster=await readMiningRosterCheckpointInterval(db,interval);
 }
 const format=roster.purpose==='registered_base_checkpoint_interval'?{version:3 as const,rosters:[roster]}:{version:2 as const,rosters:[roster]};
 const b=roster.base,free=b.land_paid_at===null&&b.deed_asset_id===null&&b.deed_mint_asset_id===null&&b.deed_minting_at===null;
 const classification=free?'registered_free':'deeded',assetId=free?null:b.deed_asset_id;
 let deeds:PortableDeeds|null=null;
 if(!free){
  if(b.land_paid_at===null||b.land_paid_at>=startsAt.replace('Z','000Z')||!key.safeParse(assetId).success
   ||b.deed_minting_at!==null||b.deed_mint_asset_id!==null&&b.deed_mint_asset_id!==assetId)held('original interval deed classification unavailable');
  if(!source||!key.safeParse(source.collection).success||!key.safeParse(source.expectedGenesisHash).success)held('configured archival source required');
  // Chain block times have second precision. Verify outward-rounded custody so
  // a transfer in the boundary second cannot masquerade as earlier ownership.
  const archiveStart=Math.floor(start/1000)*1000,archiveEnd=Math.ceil(end/1000)*1000;
  const proof=await readDeedMiningWalletEvidence(source.source,{collection:source.collection,expectedGenesisHash:source.expectedGenesisHash,
   targetWallet:before.wallet,startAt:new Date(archiveStart),endAt:new Date(archiveEnd)});
  if(proof.collection!==source.collection||proof.genesisHash!==source.expectedGenesisHash||proof.targetWallet!==before.wallet
   ||+proof.startAt!==archiveStart||+proof.endAt!==archiveEnd||proof.throughBlockTime*1000<archiveEnd
   ||!proof.continuouslyHeldAssetIds.includes(assetId!)||proof.evidence.trust!=='trusted-finalized-rpc'
   ||proof.evidence.addressIndexCompleteness!=='configured-provider-trust')held('original interval deed was not continuously held');
  deeds=freeze({...proof,startAt:proof.startAt.toISOString(),endAt:proof.endAt.toISOString()});
 }
 const after=await readSegment(db,segmentId);if(JSON.stringify(after)!==JSON.stringify(before))held('original source changed during interval prefetch');
 const evidenceSha256=hashPhysicalMineCustodyEvidence({...format,purpose:'historical_physical_mine_custody',segment:before,deeds});
 return freeze({...format,purpose:'historical_physical_mine_custody',segment:before,deeds,
  custody:{status:'confirmed',wallet:before.wallet,baseId:before.baseId,classification,assetId,startsAt,endsAt,evidenceSha256},
  sourceVerified:true,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
}
