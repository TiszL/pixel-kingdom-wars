/** Read-only selected coverage display; never cached or used as a capability. */
import type {SeekerRealmAccessRpc,SeekerRealmAccessTrust} from '@shardkeep/chain/seeker-realm-access-snapshot';
import type {PaidStarterExpeditionView} from '@shardkeep/shared/paidStarterExpeditionApi';
import {ExpeditionRealmAccessError,prefetchExpeditionRealmAccessReader} from './expeditionRealmAccess';
export interface StarterExpeditionAccessProvider {
 readonly trust:SeekerRealmAccessTrust;
 readonly connect:(signal:AbortSignal)=>SeekerRealmAccessRpc;
}
export async function readPaidStarterCoverage(wallet:string,realm:number,provider?:StarterExpeditionAccessProvider|null):Promise<{serverNow:string;coverage:PaidStarterExpeditionView['coverage']}>{
 if(!provider)return {serverNow:new Date().toISOString(),coverage:{status:'unavailable'}};
 try{
  const reader=await prefetchExpeditionRealmAccessReader(provider.connect,provider.trust,{wallet,realm}),serverNow=new Date().toISOString();
  const proof=await reader.readCoverage(serverNow);
  return {serverNow,coverage:{status:'covered',expiresAt:proof.expiresAt,observedAt:proof.finality.observedAt}};
 }catch(error){
  if(!(error instanceof ExpeditionRealmAccessError))throw error;
  return {serverNow:new Date().toISOString(),coverage:error.code==='NO_COVERAGE'||error.code==='EXPIRED'
   ?{status:'blocked',reason:error.code}:{status:'unavailable'}};
 }
}
