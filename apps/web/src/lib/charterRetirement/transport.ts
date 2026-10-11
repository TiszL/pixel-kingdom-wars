import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {CharterEmptyRequestSchema,CharterSignedRequestSchema} from '@shardkeep/shared/charterApi';
import {CharterRetirementRequestSchema,CharterRetirementDraftSchema,CharterRetirementByKeySchema,type CharterRetirementDraft} from '@shardkeep/shared/charterRetirementApi';
import {requestCharterOriginal} from '../api';
export type RetirementAction='create'|'read'|'by-key'|'pay-members'|'prepare'|'recover-preparation'|'signed'|'deliver'|'recover'|'cancel';
export type RetirementRequest={key:string|null;action:RetirementAction;body?:unknown};
const root='/clans/charter/retirements',Id=CharterRetirementRequestSchema.shape.clanId;
export async function requestRetirement(input:{actor:string;request:RetirementRequest;isCurrent:()=>boolean;retain:(raw:unknown)=>Promise<void>}):Promise<CharterRetirementDraft|null>{
 const r=structuredClone(input.request),key=r.key===null?null:Id.parse(r.key);let path:string,method:'GET'|'POST'='POST',body:unknown;
 if(r.action==='create'){if(key!==null)throw Error('New dissolution already has an ID.');path=root;body=CharterRetirementRequestSchema.parse(r.body);}
 else{
  if(key===null)throw Error('Recover the original dissolution ID first.');path=`${root}/${key}`;
  if(r.action==='read'||r.action==='by-key'){if(r.body!==undefined)throw Error('Unexpected dissolution lookup fields.');method='GET';if(r.action==='by-key')path=`${root}/by-key/${key}`;}
  else{if(!['pay-members','prepare','recover-preparation','signed','deliver','recover','cancel'].includes(r.action))throw Error('Unknown dissolution action.');path+=`/${r.action}`;body=(r.action==='signed'?CharterSignedRequestSchema:CharterEmptyRequestSchema).parse(r.body??{});}
 }
 return requestCharterOriginal({method,path,...method==='POST'?{body}:{},isCurrent:input.isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;
  if(r.action==='by-key'){
   const v=raw as Record<string,unknown>;if(!v||v.actor!==input.actor||v.idempotencyKey!==key)throw Error('Dissolution lookup belongs to another request.');
   if(v.draft!==null)await input.retain(v.draft);return CharterRetirementByKeySchema.parse(raw).draft;
  }
  const v=raw as Partial<CharterRetirementDraft>;if(!v||v.actor!==input.actor||!Id.safeParse(v.id).success||key!==null&&v.id!==key)throw Error('Dissolution response belongs to another request.');
  await input.retain(raw);return CharterRetirementDraftSchema.parse(raw);
 }});
}
