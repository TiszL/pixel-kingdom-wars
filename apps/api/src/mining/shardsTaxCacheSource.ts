/** Immutable pre-D153.196 cache source identities retained for history readers.
 * New daily rewards are exempt and cannot enter the historical tax issuer. */
import {createHash} from 'node:crypto';
import type {DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import type {ExpeditionTermReader,ExpeditionTermObservation} from '../game/expeditionTerms';
export interface ShardsCacheSourceDependencies {prefetch:()=>Promise<ExpeditionTermReader>;clock?:()=>Date}
export interface ShardsCacheEarning {baseId:string;wallet:string;earnedAt:string;day:string;streakDays:number;everCompletedWeek1Before:boolean;gross:string}
export const shardsCacheSourceHash=(earning:ShardsCacheEarning)=>createHash('sha256').update(JSON.stringify(earning)).digest('hex');
export function shardsCacheSource(earning:ShardsCacheEarning,ledgerId:string){
 const key=`cache.claim:${earning.baseId}:${earning.day}`;
 return {version:1,kind:'daily_cache',key,wallet:earning.wallet,baseId:earning.baseId,gross:BigInt(earning.gross),earning:{kind:'instant',at:earning.earnedAt},
  authority:{classification:'new_earning',decisionRef:'daily-cache-source-v1',evidenceSha256:shardsCacheSourceHash(earning)},ledger:{transactionId:ledgerId,idempotencyKey:key}};
}

/** Fail closed for stale private callers; original history is read, never reissued. */
export async function issueShardsCache(_tx:DbOrTx,_earning:ShardsCacheEarning,_observation:ExpeditionTermObservation):Promise<never>{
 throw new HttpError(409,'Daily cache rewards are untaxed','SOURCE_TAX_EXEMPT');
}
