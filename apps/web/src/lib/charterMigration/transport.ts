import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {CharterEmptyRequestSchema,CharterSignedRequestSchema} from '@shardkeep/shared/charterApi';
import {CharterMigrationRequestSchema,CharterMigrationSchema,CharterMigrationByKeySchema,type CharterMigration} from '@shardkeep/shared/charterMigrationApi';
import {requestCharterOriginal} from '../api';
export type MigrationAction='create'|'read'|'by-key'|'prepare'|'recover-preparation'|'signed'|'deliver'|'recover'|'cancel';
export type MigrationRequest={key:string|null;action:MigrationAction;body?:unknown};
const root='/clans/charter/migrations',Id=CharterMigrationRequestSchema.shape.clanId;
export async function requestMigration(input:{actor:string;request:MigrationRequest;isCurrent:()=>boolean;retain:(raw:unknown)=>Promise<void>}):Promise<CharterMigration|null>{
 const r=structuredClone(input.request),key=r.key===null?null:Id.parse(r.key);let path:string,method:'GET'|'POST'='POST',body:unknown;
 if(r.action==='create'){if(key!==null)throw Error('New migration already has an ID.');path=root;body=CharterMigrationRequestSchema.parse(r.body);}
 else{
  if(key===null)throw Error('Recover the original migration ID first.');path=`${root}/${key}`;
  if(r.action==='read'||r.action==='by-key'){if(r.body!==undefined)throw Error('Unexpected migration lookup fields.');method='GET';if(r.action==='by-key')path=`${root}/by-key/${key}`;}
  else{if(!['prepare','recover-preparation','signed','deliver','recover','cancel'].includes(r.action))throw Error('Unknown migration action.');path+=`/${r.action}`;body=(r.action==='signed'?CharterSignedRequestSchema:CharterEmptyRequestSchema).parse(r.body??{});}
 }
 return requestCharterOriginal({method,path,...method==='POST'?{body}:{},isCurrent:input.isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;
  if(r.action==='by-key'){
   const v=raw as Record<string,unknown>;if(!v||v.actor!==input.actor||v.idempotencyKey!==key)throw Error('Migration lookup belongs to another request.');
   if(v.migration!==null)await input.retain(v.migration);return CharterMigrationByKeySchema.parse(raw).migration;
  }
  const v=raw as Partial<CharterMigration>;if(!v||v.actor!==input.actor||!Id.safeParse(v.id).success||key!==null&&v.id!==key)throw Error('Migration response belongs to another request.');
  await input.retain(raw);return CharterMigrationSchema.parse(raw);
 }});
}
