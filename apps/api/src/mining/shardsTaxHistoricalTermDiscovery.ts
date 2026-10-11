/** Read-only earning-time term discovery before database/gameplay locks. No
 * caller certificate, current round, custody assertion or posting capability. */
import {readFinalizedHistoricalSeekerTermAt,type ReviewedSeekerSourcePolicy,type SeekerTermRpc} from '@shardkeep/chain/seeker-terms';
import {copyHistoricalShardsSourcePolicy,mapHistoricalShardsTermCertificate} from './shardsTaxHistoricalTermReader';
import type {HistoricalShardsTermCertificate} from './shardsTaxObstacleEvidence';

export async function prefetchHistoricalShardsTermAt(connect:(signal:AbortSignal)=>SeekerTermRpc,
 reviewedSourcePolicy:ReviewedSeekerSourcePolicy,earnedAt:string,options:Readonly<{deadlineMs?:number}>={}):Promise<HistoricalShardsTermCertificate>{
 if(typeof earnedAt!=='string'||earnedAt.length!==24)throw new Error('Canonical historical earning time required');
 const policy=copyHistoricalShardsSourcePolicy(reviewedSourcePolicy),milliseconds=Date.parse(earnedAt);
 if(!Number.isSafeInteger(milliseconds)||new Date(milliseconds).toISOString()!==earnedAt)
  throw new Error('Canonical historical earning time required');
 const result=await readFinalizedHistoricalSeekerTermAt(connect,policy,BigInt(milliseconds),
  options.deadlineMs===undefined?{}:{deadlineMs:options.deadlineMs});
 return mapHistoricalShardsTermCertificate(result,{...policy,round:result.source.round});
}
