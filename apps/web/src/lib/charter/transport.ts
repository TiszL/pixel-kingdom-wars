import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {CharterActivitySchema,CharterClientSchema,CharterDeliverySchema,CharterSaleByKeySchema,CharterCreationRequestSchema,CharterSaleDraftSchema,CharterSaleAcceptanceSchema,CharterSignatureRequestSchema,CharterSignedRequestSchema,CharterRefundRequestSchema,CharterEmptyRequestSchema,type CharterActivity,type CharterClient} from '@shardkeep/shared/charterApi';
import {requestCharterOriginal} from '../api';
export type CharterKind='creation'|'sale';
export type CharterAction='prepare'|'recover-preparation'|'recover'|'signed'|'refund'|'accept'|'pay-members'|'cancel'|'signature'|'deliver';
export type CharterRequest={kind:CharterKind;key:string|null;action:'create'|'read'|'by-key'|CharterAction;body?:unknown};
const root='/clans/charter/client',id=(v:unknown)=>CharterCreationRequestSchema.shape.creationIntentId.parse(v);
function outer(raw:unknown,actor:string,kind:CharterKind,key:string|null):void{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid Charter original.');const r=raw as Record<string,unknown>;
 if(r.version!==1||r.actor!==actor||r.kind!==kind||typeof r.key!=='string'||id(r.key)!==r.key||key!==null&&r.key!==key)throw Error('Charter response belongs to another original.');
}
export async function requestCharter(input:{actor:string;request:CharterRequest;isCurrent:()=>boolean;retain:(raw:unknown)=>Promise<void>}):Promise<CharterClient|null>{
 if(!input||typeof input!=='object'||Reflect.ownKeys(input).some(k=>typeof k!=='string'||!['actor','request','isCurrent','retain'].includes(k))||!input.request||typeof input.request!=='object'||Reflect.ownKeys(input.request).some(k=>typeof k!=='string'||!['kind','key','action','body'].includes(k)))throw Error('Invalid Charter request fields.');
 const {actor,isCurrent,retain}=input,r=structuredClone(input.request),kind=r.kind,key=r.key===null?null:id(r.key),base=`${root}/${kind==='creation'?'creations':'sales'}`;
 if(!['creation','sale'].includes(kind)||typeof retain!=='function'||typeof isCurrent!=='function')throw Error('Invalid Charter evidence owner.');
 let method:'GET'|'POST'='POST',path:string,body:unknown;
 if(r.action==='create'){if(key!==null)throw Error('Invalid new Charter request.');path=base;body=(kind==='creation'?CharterCreationRequestSchema:CharterSaleDraftSchema).parse(r.body);}
 else{if(key===null)throw Error('Original Charter ID required.');path=`${base}/${key}`;
  if(r.action==='read'||r.action==='by-key'){if(r.body!==undefined||r.action==='by-key'&&kind!=='sale')throw Error('Invalid original lookup.');method='GET';if(r.action==='by-key')path=`${base}/by-key/${key}`;}
  else{const allowed=kind==='creation'?['prepare','recover-preparation','recover','signed','refund','deliver']:['accept','pay-members','prepare','recover-preparation','recover','cancel','signature','deliver'];if(!allowed.includes(r.action))throw Error('Invalid Charter action.');path+=`/${r.action}`;
   body=(r.action==='accept'?CharterSaleAcceptanceSchema:r.action==='signature'?CharterSignatureRequestSchema:r.action==='signed'?CharterSignedRequestSchema:r.action==='refund'?CharterRefundRequestSchema:CharterEmptyRequestSchema).parse(r.body??{});
  }
 }
 return requestCharterOriginal({method,path,...(method==='POST'?{body}:{}),isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;
  if(r.action==='by-key'){
   // Bind outer request first; the retained original owns nested terminal evidence.
   const value=raw as Record<string,unknown>;if(!value||value.actor!==actor||value.idempotencyKey!==key)throw Error('Charter lookup owner differs.');
   if(value.sale!==null){outer(value.sale,actor,kind,null);await retain(value.sale);}const parsed=CharterSaleByKeySchema.parse(raw);return parsed.sale;
  }
  const original=r.action==='deliver'?(raw as Record<string,unknown>)?.original:raw;outer(original,actor,kind,r.action==='create'?kind==='creation'?(body as {creationIntentId:string}).creationIntentId:null:key);
  await retain(original);if(r.action==='deliver')CharterDeliverySchema.parse(raw);return CharterClientSchema.parse(original);
 }});
}
export async function charterActivity(actor:string,isCurrent:()=>boolean,cursor?:string):Promise<CharterActivity>{
 if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length<1||cursor.length>256||!/^[\x21-\x7e]+$/.test(cursor)))throw Error('Invalid Charter history cursor.');
 return requestCharterOriginal({method:'GET',path:`${root}/activity${cursor===undefined?'':`?cursor=${encodeURIComponent(cursor)}`}`,isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,observe:async(status,raw)=>{if(status<200||status>=300)return undefined;const value=CharterActivitySchema.parse(raw);if(value.actor!==actor)throw Error('Charter history owner differs.');return value;}});
}
