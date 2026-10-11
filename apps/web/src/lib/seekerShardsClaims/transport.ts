import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {SeekerShardsClaimRequestSchema,SeekerShardsClaimEnvelopeSchema,type SeekerShardsClaimRequest,type SeekerShardsClaimEnvelope} from '@shardkeep/shared/seekerShardsClaimsApi';
import {requestUnpaidOriginal} from '../api';
/** An owned original response is persisted before any obsolete view is rejected. */
export async function seekerShardsClaimOriginal(input:{request:SeekerShardsClaimRequest;method:'GET'|'POST';isCurrent:()=>boolean;retain:(raw:SeekerShardsClaimEnvelope)=>Promise<void>}):Promise<SeekerShardsClaimEnvelope>{
 const request=SeekerShardsClaimRequestSchema.parse(input.request);
 return requestUnpaidOriginal({method:input.method,path:input.method==='POST'?'/seeker/shards/claims':`/seeker/shards/claims/by-key/${encodeURIComponent(request.idempotencyKey)}`,
  ...(input.method==='POST'?{body:request}:{}),isCurrent:input.isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,
  observe:async(status,raw)=>{
   if(status>=200&&status<300){
    const proof=SeekerShardsClaimEnvelopeSchema.parse(raw);
    if(input.method==='POST'&&!proof.receipt)throw Error('A completed SHARDS claim requires its receipt.');
    await input.retain(proof);return proof;
   }
   // No error response proves that a previously attempted command did not land.
   return undefined;
  }});
}
