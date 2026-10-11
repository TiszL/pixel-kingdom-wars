/** Read-only previews and original recovery. No craft reservation or signing. */
import {PHASE_E_VEHICLE_CLIENT as P} from '@shardkeep/shared';
import {VehicleCraftQuoteRequestSchema,VehicleCraftQuoteSchema,VehicleCraftRecordSchema,VehicleCraftHistoryPageSchema,VehicleCraftRecoverySchema,VehicleCraftKeyParamsSchema,VehicleCraftHistoryQuerySchema,type VehicleCraftRecord} from '@shardkeep/shared/vehicleCraftClientApi';
import {requestVehicleCraftOriginal} from '../api';
export type VehicleCraftRequest={kind:'quote';request:unknown}|{kind:'history';cursor?:string}|{kind:'read'|'recover';key:string};
export async function requestVehicleCraft(input:{wallet:string;request:VehicleCraftRequest;isCurrent:()=>boolean;retain:(records:VehicleCraftRecord[])=>Promise<void>}){
 const request=structuredClone(input.request),root='/vehicles/craft';
 const fields=request.kind==='quote'?['kind','request']:request.kind==='history'?['kind','cursor']:['kind','key'];
 if(!['quote','history','read','recover'].includes(request.kind)||Object.keys(request).some(k=>!fields.includes(k)))throw Error('Unsupported vehicle craft request.');
 let path:string,method:'GET'|'POST'='GET',body:unknown;
 if(request.kind==='quote'){body=VehicleCraftQuoteRequestSchema.parse(request.request);method='POST';path=root+'/quote';}
 else if(request.kind==='history'){const q=VehicleCraftHistoryQuerySchema.parse(request.cursor===undefined?{}:{cursor:request.cursor});path=root+'/history'+(q.cursor?'?cursor='+encodeURIComponent(q.cursor):'');}
 else{const {key}=VehicleCraftKeyParamsSchema.parse({key:request.key});path=root+'/by-key/'+key;if(request.kind==='recover'){method='POST';path+='/recover';body={};}}
 return requestVehicleCraftOriginal({method,path,...(method==='POST'?{body}:{}),isCurrent:input.isCurrent,timeoutMs:P.rpcTimeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;
  if(request.kind==='quote'){
   const value=VehicleCraftQuoteSchema.parse(raw),expected=VehicleCraftQuoteRequestSchema.parse(body);
   if(value.wallet!==input.wallet||value.baseId!==expected.baseId||value.recipe.family!==expected.family||value.recipe.tier!==expected.tier||value.recipe.recipeVersion!==expected.recipeVersion)throw Error('The recipe preview changed. Refresh this selection.');
   return value;
  }
  const value=request.kind==='history'?VehicleCraftHistoryPageSchema.parse(raw):request.kind==='recover'?VehicleCraftRecoverySchema.parse(raw):VehicleCraftRecordSchema.parse(raw);
  if(value.wallet!==input.wallet||request.kind!=='history'&&('idempotencyKey'in value&&value.idempotencyKey!==request.key))throw Error('The original craft belongs to another account or request.');
  const records='items'in value?value.items:'record'in value?[value.record]:[value];
  await input.retain(records);return value;
 }});
}
