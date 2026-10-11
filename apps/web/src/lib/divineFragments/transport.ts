import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {requestDivineFragmentOriginal} from '../api';
import {matchDivineFragmentsProof,parseDivineFragmentsCommand,type DivineFragmentsCommand,type DivineFragmentsIdentity} from './journal';
/** Owned original response drains into durable storage before obsolete-view
 * rejection. POST receipts are bare; GET receipts use a nullable envelope. */
export function divineFragmentOriginal(input:{identity:DivineFragmentsIdentity;command:DivineFragmentsCommand;method:'GET'|'POST';isCurrent:()=>boolean;retain:(raw:unknown)=>Promise<void>}){
 const command=parseDivineFragmentsCommand(input.command),request=command.consent.request,method=input.method;
 if(command.consent.wallet!==input.identity.wallet)throw Error('Foreign fragment original.');
 const path=command.kind==='delivery'?(method==='GET'?`/divine-fragments/deliveries/${request.idempotencyKey}`:`/divine-fragments/events/${command.consent.eventId}/delivery`):(method==='GET'?`/divine-fragments/seeker/claims/${request.idempotencyKey}`:'/divine-fragments/seeker/claims');
 return requestDivineFragmentOriginal({method,path,...(method==='POST'?{body:request}:{}),timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,isCurrent:input.isCurrent,observe:async(status,raw)=>{
  if(status>=200&&status<300){const proof=matchDivineFragmentsProof(method==='POST'?{version:1,wallet:input.identity.wallet,idempotencyKey:request.idempotencyKey,receipt:raw}:raw,input.identity,command);if(method==='POST'&&!proof.receipt)throw Error('Fragment acceptance requires its original receipt.');await input.retain(proof);return proof;}return undefined;
 }});
}
