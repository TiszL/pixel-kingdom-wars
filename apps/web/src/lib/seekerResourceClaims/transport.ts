import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {SeekerResourceClaimRequestSchema,SeekerResourceClaimEnvelopeSchema,type SeekerResourceClaimRequest,type SeekerResourceClaimEnvelope} from '@shardkeep/shared/seekerResourceClaimsApi';
import {requestUnpaidOriginal} from '../api';
/** An owned original response is persisted before any obsolete view is rejected. */
export async function seekerResourceClaimOriginal(input:{request:SeekerResourceClaimRequest;method:'GET'|'POST';isCurrent:()=>boolean;retain:(raw:SeekerResourceClaimEnvelope)=>Promise<void>}):Promise<SeekerResourceClaimEnvelope>{
 const request=SeekerResourceClaimRequestSchema.parse(input.request);
 return requestUnpaidOriginal({method:input.method,path:input.method==='POST'?'/seeker/resource-claims':`/seeker/resource-claims/by-key/${encodeURIComponent(request.idempotencyKey)}`,
  ...(input.method==='POST'?{body:request}:{}),isCurrent:input.isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,
  observe:async(status,raw)=>{
   if(status>=200&&status<300){
    const proof=SeekerResourceClaimEnvelopeSchema.parse(raw);
    if(input.method==='POST'&&!proof.receipt)throw Error('A completed resource claim requires its receipt.');
    await input.retain(proof);return proof;
   }
   // No error response proves that a previously attempted command did not land.
   return undefined;
  }});
}
