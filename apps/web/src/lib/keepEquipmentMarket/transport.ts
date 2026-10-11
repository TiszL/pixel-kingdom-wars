/** Dedicated endpoints, with owned originals retained before a stale view fails. */
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as P} from '@shardkeep/shared';
import {KeepEquipmentMarketListingRequestSchema,KeepEquipmentMarketFillRequestSchema,KeepEquipmentMarketCancelRequestSchema,KeepEquipmentListingSchema,KeepEquipmentCancellationSchema,KeepEquipmentPurchaseSchema,KeepEquipmentReviewSchema,KeepEquipmentSendSchema,KeepEquipmentSignedRequestSchema,KeepEquipmentListingPageSchema,KeepEquipmentHistoryPageSchema,KeepEquipmentListingsQuerySchema,KeepEquipmentHistoryQuerySchema,KeepEquipmentStockViewSchema,KeepEquipmentMarketPolicySchema,KeepEquipmentStockQuerySchema,keepMarketCategory,keepMarketCatalogueIds} from '@shardkeep/shared/keepEquipmentMarketApi';
import {requestKeepEquipmentOriginal} from '../api';
import {need} from './signing';
export type KeepMarketRequest={kind:'listing'|'fill'|'cancellation'|'offers'|'history'|'stock'|'policy';action:'create'|'read'|'prepare'|'signed'|'recover'|'review'|'deliver'|'release';id?:string;baseId?:string;query?:unknown;body?:unknown};
export async function requestKeepMarket(input:{actor:string;request:KeepMarketRequest;isCurrent:()=>boolean;retain:(raw:unknown)=>Promise<void>}){
 const r=structuredClone(input.request);need(Object.keys(r).every(k=>['kind','action','id','baseId','query','body'].includes(k)));
 const root='/keep-equipment-market',uuid=KeepEquipmentMarketListingRequestSchema.shape.idempotencyKey;
 let path=root,method:'GET'|'POST'='GET',body:unknown,schema:{parse(raw:unknown):unknown};
 if(r.kind==='listing'||r.kind==='fill'||r.kind==='cancellation'){
  need(r.baseId===undefined&&r.query===undefined);path+='/'+({listing:'listings',fill:'fills',cancellation:'cancellations'}[r.kind]);
  schema=r.kind==='listing'?KeepEquipmentListingSchema:r.kind==='fill'?KeepEquipmentPurchaseSchema:KeepEquipmentCancellationSchema;
  if(r.action==='create'){
   need(r.id===undefined);method='POST';body=({listing:KeepEquipmentMarketListingRequestSchema,fill:KeepEquipmentMarketFillRequestSchema,cancellation:KeepEquipmentMarketCancelRequestSchema}[r.kind]).parse(r.body);
  }else{
   path+='/'+uuid.parse(r.id);
   if(r.action!=='read'){
    need(r.kind==='fill'&&['prepare','signed','recover','review','deliver','release'].includes(r.action));method='POST';path+='/'+r.action;
    if(r.action==='signed')body=KeepEquipmentSignedRequestSchema.parse(r.body);else{need(r.body===undefined);body={};}
    if(r.action==='review')schema=KeepEquipmentReviewSchema;if(r.action==='deliver')schema=KeepEquipmentSendSchema;
   }
  }
 }else{
  need(r.action==='read'&&r.id===undefined&&r.body===undefined);
  if(r.kind==='stock'){const query=KeepEquipmentStockQuerySchema.omit({baseId:true}).parse(r.query??{});path+='/stock?baseId='+uuid.parse(r.baseId)+(query.catalogueVersion?'&catalogueVersion='+query.catalogueVersion:'');schema=KeepEquipmentStockViewSchema;}
  else{need(r.baseId===undefined);
   if(r.kind==='policy'){need(r.query===undefined);path+='/policy?version=1';schema=KeepEquipmentMarketPolicySchema;}
   else{need(r.kind==='offers'||r.kind==='history');const query=(r.kind==='offers'?KeepEquipmentListingsQuerySchema:KeepEquipmentHistoryQuerySchema).parse(r.query??{}),search=new URLSearchParams();
    for(const [key,value] of Object.entries(query))if(value!==undefined)search.append(key,value);
    path+='/'+(r.kind==='offers'?'listings':'history')+(search.size?'?'+search:'');schema=r.kind==='offers'?KeepEquipmentListingPageSchema:KeepEquipmentHistoryPageSchema;
   }
  }
 }
 need(method!=='GET'||r.body===undefined);
 return requestKeepEquipmentOriginal({method,path,...method==='POST'?{body}:{},isCurrent:input.isCurrent,timeoutMs:P.rpcTimeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;const value=schema.parse(raw);
  if(r.kind==='listing'||r.kind==='fill'||r.kind==='cancellation'){
   const original=r.kind==='fill'&&(r.action==='review'||r.action==='deliver')?(value as {purchase:unknown}).purchase:value;
   const record=r.kind==='fill'?KeepEquipmentPurchaseSchema.parse(original).fill:r.kind==='listing'?KeepEquipmentListingSchema.parse(original):KeepEquipmentCancellationSchema.parse(original);
   const owner='buyerWallet'in record?record.buyerWallet:'sellerWallet'in record?record.sellerWallet:record.actorWallet;
   need(owner===input.actor&&record.id===(r.id??(body as {idempotencyKey:string}).idempotencyKey));
   // The journal also binds every command field; it commits before current-view
   // checks, including review responses that reveal another tab's payment.
   await input.retain(original);
  }else if(r.kind==='history'||r.kind==='offers'){
   const query=(r.kind==='history'?KeepEquipmentHistoryQuerySchema:KeepEquipmentListingsQuerySchema).parse(r.query??{});
   if(r.kind==='history')need(KeepEquipmentHistoryPageSchema.parse(value).wallet===input.actor);
   const page=r.kind==='history'?KeepEquipmentHistoryPageSchema.parse(value):KeepEquipmentListingPageSchema.parse(value);
   need(page.items.every(item=>(keepMarketCatalogueIds(query.catalogueVersion) as readonly string[]).includes(item.itemId)&&(!query.category||keepMarketCategory(item.itemId)===query.category)&&(!query.itemId||item.itemId===query.itemId)));
  }
  else if(r.kind==='stock'){const stock=KeepEquipmentStockViewSchema.parse(value);need(stock.wallet===input.actor&&stock.baseId===r.baseId);const query=KeepEquipmentStockQuerySchema.omit({baseId:true}).parse(r.query??{});need(query.catalogueVersion?'catalogueVersion'in stock&&String(stock.catalogueVersion)===query.catalogueVersion:!('catalogueVersion'in stock));}
  return value;
 }});
}
/** Used only by the shared bounded original-response drain. Queries have their
 * own schema above; this allowlist prevents this family reaching another rail. */
export function keepMarketEndpointAllowed(method:string,path:string){
 const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
 if(method==='POST')return new RegExp(`^/keep-equipment-market/(?:listings|cancellations|fills(?:/${uuid}/(?:prepare|signed|recover|review|deliver|release))?)$`).test(path);
 if(method!=='GET')return false;
 if(new RegExp(`^/keep-equipment-market/(?:policy\\?version=1|(?:listings|fills|cancellations)/${uuid})$`).test(path))return true;
 const stock=/^\/keep-equipment-market\/stock\?([^#]*)$/.exec(path);if(stock&&path.length<=1024){const entries=[...new URLSearchParams(stock[1])];return new Set(entries.map(([key])=>key)).size===entries.length&&KeepEquipmentStockQuerySchema.safeParse(Object.fromEntries(entries)).success;}
 const match=/^\/keep-equipment-market\/(listings|history)(?:\?([^#]*))?$/.exec(path);if(!match||path.length>1024)return false;
 const entries=[...new URLSearchParams(match[2]??'')];if(new Set(entries.map(([key])=>key)).size!==entries.length)return false;
 return (match[1]==='listings'?KeepEquipmentListingsQuerySchema:KeepEquipmentHistoryQuerySchema).safeParse(Object.fromEntries(entries)).success;
}
