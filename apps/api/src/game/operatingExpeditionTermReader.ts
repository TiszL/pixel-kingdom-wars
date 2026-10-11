import type {ReviewedSeekerSourcePolicy,ReviewedSeekerTermPolicy,SeekerTermRpc} from '@shardkeep/chain/seeker-terms';
import type {ExpeditionTermReader} from './expeditionTerms';
import {prefetchExpeditionTermReader} from './expeditionTermReader';
import { prefetchCurrentExpeditionTermReader } from './expeditionCurrentTermReader';

/** Normal gameplay discovers the current operating round from finalized chain
 * time. Explicit fixed-round callers retain their original reviewed behavior. */
export function prefetchOperatingExpeditionTermReader(connect:(signal:AbortSignal)=>SeekerTermRpc,
  policy:ReviewedSeekerSourcePolicy|ReviewedSeekerTermPolicy):Promise<ExpeditionTermReader>{
  if('round' in policy){
    if(typeof policy.round!=='bigint')throw Error('Invalid explicit expedition round');
    return prefetchExpeditionTermReader(connect,{...policy,round:policy.round});
  }
  return prefetchCurrentExpeditionTermReader(connect,policy);
}
