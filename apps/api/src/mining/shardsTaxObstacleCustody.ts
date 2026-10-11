/** Unmounted historical custody evidence. Only a configured archival provider
 * can supply chain history; current owner observations and caller facts cannot.
 * Provider work runs between two short top-level database transactions. A future
 * issuer must recheck its own current authority and locked source before posting. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {readDeedMiningWalletEvidence} from '@shardkeep/chain/mining-wallet';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import type {DeedMiningRosterSource} from './deedRosterQualification';
import type {ShardsObstacleObligation} from './shardsTaxObstacleObligations';
import type {ShardsObstacleGemsAcceleration} from './shardsTaxObstacleGemsAcceleration';
import type {ShardsObstacleItemAcceleration} from './shardsTaxObstacleItemAcceleration';
import {readLockedShardsObstacleSource} from './shardsTaxObstacleSource';

const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function held(message:string):never{throw new HttpError(503,`Obstacle custody held: ${message}`,'SHARDS_OBSTACLE_CUSTODY_UNAVAILABLE');}
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
type DeedEvidence=Awaited<ReturnType<typeof readDeedMiningWalletEvidence>>;
export interface ShardsObstacleCustodyEvidence{
 readonly version:1;readonly purpose:'historical_obstacle_custody';readonly obligation:ShardsObstacleObligation;
 readonly accelerations:readonly (ShardsObstacleGemsAcceleration|ShardsObstacleItemAcceleration)[];readonly earnedAt:string;
 readonly custody:Readonly<{status:'confirmed';baseId:string;wallet:string;startsAt:string;endsAt:string;evidenceSha256:string}>;
 readonly source:Readonly<Omit<DeedEvidence,'startAt'|'endAt'>&{startAt:string;endAt:string}>;
 readonly sourceVerified:true;readonly postingAuthorized:false;readonly payoutAuthorized:false;readonly operatingAdmissionAuthorized:false;
}

export async function prefetchShardsObstacleCustody(db:Db,obligationId:string,configured:DeedMiningRosterSource):Promise<ShardsObstacleCustodyEvidence>{
 uuid.parse(obligationId);
 // DbTx.transaction would only open a savepoint, retaining an outer caller's
 // locks across RPC. Also refuse an incorrectly cast transaction at runtime.
 if('rollback' in db)held('top-level database required');
 if(!configured||!key.safeParse(configured.collection).success||!key.safeParse(configured.expectedGenesisHash).success)
  held('configured archival source required');
 const reader=configured.source,collection=configured.collection,expectedGenesisHash=configured.expectedGenesisHash;
 const before=await db.transaction(tx=>readLockedShardsObstacleSource(tx,obligationId));
 if(before.obligation.deedAssetId===null)held('captured deed custody required');
 const captured=Date.parse(before.obligation.capturedAt),earned=Date.parse(before.earnedAt);
 // Chain transitions have whole-second timestamps. Cover the entire capture
 // and earning seconds so same-second out-and-back cannot become prior history.
 const startMs=Math.floor(captured/1000)*1000,endMs=Math.ceil(earned/1000)*1000+1000;
 if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||startMs<0||endMs<=startMs
  ||!Number.isFinite(new Date(endMs).getTime()))held('custody interval unavailable');
 const deeds=await readDeedMiningWalletEvidence(reader,{collection,expectedGenesisHash,targetWallet:before.obligation.wallet,
  startAt:new Date(startMs),endAt:new Date(endMs)});
 if(deeds.collection!==collection||deeds.genesisHash!==expectedGenesisHash||deeds.targetWallet!==before.obligation.wallet
  ||deeds.startAt.getTime()!==startMs||deeds.endAt.getTime()!==endMs||deeds.throughBlockTime*1000<endMs
  ||!deeds.continuouslyHeldAssetIds.includes(before.obligation.deedAssetId!)
  ||deeds.evidence.trust!=='trusted-finalized-rpc'||deeds.evidence.addressIndexCompleteness!=='configured-provider-trust')held('original deed was not continuously held');
 // All remaining verifier fields are detached immutable primitives/arrays.
 // Date is mutable even after Object.freeze, so none escapes this adapter.
 const source=freeze({...deeds,startAt:deeds.startAt.toISOString(),endAt:deeds.endAt.toISOString()});
 const evidenceSha256=hash({version:1,kind:'obstacle_archival_custody',originalSource:before.fingerprint,source});
 await db.transaction(async tx=>{
  const after=await readLockedShardsObstacleSource(tx,obligationId);
  if(after.fingerprint!==before.fingerprint)held('source changed during archival prefetch');
 });
 return freeze({version:1 as const,purpose:'historical_obstacle_custody' as const,obligation:before.obligation,
  accelerations:before.accelerations,earnedAt:before.earnedAt,
  custody:{status:'confirmed' as const,baseId:before.obligation.baseId,wallet:before.obligation.wallet,
   startsAt:source.startAt,endsAt:source.endAt,evidenceSha256},source,sourceVerified:true as const,
  postingAuthorized:false as const,payoutAuthorized:false as const,operatingAdmissionAuthorized:false as const});
}
