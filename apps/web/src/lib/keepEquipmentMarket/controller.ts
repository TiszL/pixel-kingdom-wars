import {KeepEquipmentMarketListingRequestSchema,KeepEquipmentMarketFillRequestSchema,KeepEquipmentMarketCancelRequestSchema,KeepEquipmentPurchaseSchema,KeepEquipmentListingPageSchema,KeepEquipmentHistoryPageSchema,KeepEquipmentHistoryItemSchema,KeepEquipmentStockViewSchema,KeepEquipmentMarketPolicySchema,KeepEquipmentListingsQuerySchema,KeepEquipmentHistoryQuerySchema,keepMarketCategory,type KeepEquipmentPurchase} from '@shardkeep/shared/keepEquipmentMarketApi';
import {ApiError} from '../api';
import {KeepMarketJournalStore,marketKey,purchase,canRelease,type KeepMarketCommand,type KeepMarketJournal,type KeepMarketKind} from './journal';
import type {KeepMarketRequest} from './transport';
import {need,type KeepEquipmentWire} from './signing';
export interface KeepMarketCosts {feeLamports:string;rentLamports:string;totalLamports:string}
export interface KeepMarketPorts {
 capture(action:boolean,baseId?:string,purpose?:'saved-delivery'):()=>void;key():string;lock<T>(key:string,run:()=>Promise<T>):Promise<T>;
 request(request:KeepMarketRequest,guard:()=>void,retain:(raw:unknown)=>Promise<void>):Promise<unknown>;
 review(value:KeepEquipmentPurchase,guard:()=>void,retain:(raw:unknown)=>Promise<void>):Promise<KeepMarketCosts&{assertFresh():void}>;
 sign(value:KeepEquipmentPurchase,guard:()=>void,beforeWallet:()=>Promise<void>,displayed:KeepMarketCosts,retain:(raw:unknown)=>Promise<void>):Promise<KeepEquipmentWire>;
}
export interface KeepMarketState {
 category:'resources'|'items';loaded:boolean;busy:boolean;journal:KeepMarketJournal|null;offers:ReturnType<typeof KeepEquipmentListingPageSchema.parse>|null;
 history:ReturnType<typeof KeepEquipmentHistoryPageSchema.parse>|null;stock:ReturnType<typeof KeepEquipmentStockViewSchema.parse>|null;
 policy:ReturnType<typeof KeepEquipmentMarketPolicySchema.parse>|null;selected:string|null;reviewed:(KeepMarketCosts&{messageSha256:string})|null;error:string|null;
}
export const emptyKeepMarketState=():KeepMarketState=>({category:'items',loaded:false,busy:false,journal:null,offers:null,history:null,stock:null,policy:null,selected:null,reviewed:null,error:null});
export class KeepMarketController {
 private state=emptyKeepMarketState();private listeners=new Set<()=>void>();private pending:Promise<unknown>|null=null;
 constructor(readonly store:KeepMarketJournalStore,private ports:KeepMarketPorts){}
 getSnapshot=()=>this.state;subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 private set(patch:Partial<KeepMarketState>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}
 dismiss(){this.set({reviewed:null});}select(key:string){this.set({selected:key,reviewed:null});}async idle(){await this.pending?.catch(()=>undefined);}
 private run<T>(action:boolean,work:(guard:()=>void)=>Promise<T>,baseId?:string,purpose?:'saved-delivery'):Promise<T>{
  if(this.pending)return Promise.reject(Error('A market action is running.'));
  const task=(async()=>{this.set({busy:true,error:null});try{const guard=this.ports.capture(action,baseId,purpose);return await this.ports.lock(this.store.key,async()=>{guard();return work(guard);});}
   catch(e){this.set({error:e instanceof Error?e.message:'Market action is held.',reviewed:null});throw e;}
   finally{try{this.set({journal:await this.store.read(),loaded:true});}catch(e){this.set({error:e instanceof Error?e.message:'Payment recovery is unavailable.'});}this.set({busy:false});}})();
  this.pending=task;void task.finally(()=>{this.pending=null;}).catch(()=>undefined);return task;
 }
 category(value:'resources'|'items'){need(!this.pending&&['resources','items'].includes(value));if(value!==this.state.category)this.set({category:value,offers:null,history:null});}
 private async request(r:KeepMarketRequest,guard:()=>void,key?:string){guard();if(key)await this.store.mark(key,r.action);guard();
  try{return await this.ports.request(r,guard,async raw=>{need(key);await this.store.retain(key,raw);});}
  catch(error){
   // A read/recover refusal says nothing about a previously admitted create.
   if(key&&r.action==='create'&&await this.store.refuseCreate(key,error)&&this.state.selected===key)this.set({selected:null,reviewed:null});
   throw error;
  }
 }
 private async op(){const op=(await this.store.read()).pending.find(v=>marketKey(v.command)===this.state.selected);need(op,'Choose the saved original purchase.');return op;}
 load(){return this.run(false,async guard=>{this.set({journal:await this.store.read(),loaded:true});const policy=KeepEquipmentMarketPolicySchema.parse(await this.request({kind:'policy',action:'read'},guard));guard();this.set({policy});const history=KeepEquipmentHistoryPageSchema.parse(await this.request({kind:'history',action:'read',query:{catalogueVersion:'4',category:this.state.category}},guard));guard();need(history.items.every(item=>keepMarketCategory(item.itemId)===this.state.category));this.set({history});});}
 offers(query?:unknown){const original=KeepEquipmentListingsQuerySchema.parse({...query as object,catalogueVersion:'4',category:this.state.category});return this.run(true,async guard=>{const offers=KeepEquipmentListingPageSchema.parse(await this.request({kind:'offers',action:'read',query:original},guard));guard();need(offers.items.every(item=>keepMarketCategory(item.itemId)===original.category));this.set({offers});});}
 history(query?:unknown){const original=KeepEquipmentHistoryQuerySchema.parse({...query as object,catalogueVersion:'4',category:this.state.category});return this.run(false,async guard=>{const history=KeepEquipmentHistoryPageSchema.parse(await this.request({kind:'history',action:'read',query:original},guard));guard();need(history.items.every(item=>keepMarketCategory(item.itemId)===original.category));this.set({history});});}
 stock(baseId:string){return this.run(true,async guard=>{const stock=KeepEquipmentStockViewSchema.parse(await this.request({kind:'stock',action:'read',baseId,query:{catalogueVersion:'4'}},guard));guard();need('catalogueVersion'in stock&&stock.catalogueVersion===4);this.set({stock,policy:stock.policy});},baseId);}
 begin(kind:KeepMarketKind,input:unknown){
  const schemas={listing:KeepEquipmentMarketListingRequestSchema,fill:KeepEquipmentMarketFillRequestSchema,cancellation:KeepEquipmentMarketCancelRequestSchema};
  const request=schemas[kind].parse({...input as object,idempotencyKey:this.ports.key()}),baseId=kind==='listing'?KeepEquipmentMarketListingRequestSchema.parse(request).baseId:kind==='fill'?KeepEquipmentMarketFillRequestSchema.parse(request).buyerBaseId:undefined;
  return this.run(true,async guard=>{const command={kind,key:request.idempotencyKey,request};await this.store.begin(command);const key=marketKey(command);this.set({selected:key,reviewed:null});await this.request({kind,action:'create',body:request},guard,key);guard();this.set({stock:null,offers:null});},baseId);
 }
 open(raw:unknown){return this.run(false,async guard=>{const item=KeepEquipmentHistoryItemSchema.parse(raw),command:KeepMarketCommand={kind:item.kind,key:item.id,request:null},key=marketKey(command),journal=await this.store.read();
  if(![...journal.pending,...journal.archive].some(op=>marketKey(op.command)===key))await this.store.begin(command);this.set({selected:key,reviewed:null});
  if(journal.archive.some(op=>marketKey(op.command)===key))return;await this.request({kind:item.kind,action:'read',id:item.id},guard,key);guard();});}
 recover(retry=false){return this.run(false,async guard=>{const op=await this.op(),c=op.command,key=marketKey(c);need(!retry||c.request,'This device has no original request to retry.');
  try{await this.request({kind:c.kind,action:c.kind==='fill'&&purchase(op)?.wire?'recover':'read',id:c.key},guard,key);}
  catch(error){if(!retry||!(error instanceof ApiError)||error.status!==404)throw error;guard();const fresh=this.ports.capture(true,c.request&&'baseId'in c.request?c.request.baseId:c.request&&'buyerBaseId'in c.request?c.request.buyerBaseId:undefined);fresh();await this.request({kind:c.kind,action:'create',body:c.request},()=>{guard();fresh();},key);}
  guard();this.dismiss();});}
 prepare(){return this.run(true,async guard=>{const op=await this.op(),p=purchase(op);need(p&&!p.release&&!op.signingStarted&&!op.observedComplete&&!op.wire);await this.request({kind:'fill',action:'prepare',id:p.fill.id},guard,marketKey(op.command));guard();this.dismiss();});}
 review(){return this.run(true,async guard=>{const op=await this.op(),p=purchase(op);need(p?.preparation&&!p.release&&!op.signingStarted&&!op.observedComplete&&!op.wire&&!p.wire);const key=marketKey(op.command),quote=await this.ports.review(p,guard,raw=>this.store.retain(key,raw).then(()=>undefined));quote.assertFresh();guard();this.set({reviewed:{messageSha256:p.preparation.messageSha256,feeLamports:quote.feeLamports,rentLamports:quote.rentLamports,totalLamports:quote.totalLamports}});});}
 sign(){return this.run(true,async guard=>{const op=await this.op(),p=purchase(op),displayed=this.state.reviewed;need(p?.preparation&&!p.release&&displayed&&p.preparation.messageSha256===displayed.messageSha256&&!op.signingStarted&&!op.observedComplete&&!op.wire&&!p.wire);
  const key=marketKey(op.command);let started=false;const wire=await this.ports.sign(p,guard,async()=>{need(!started,'Wallet approval already started.');guard();await this.store.startSigning(key);started=true;guard();},displayed,raw=>this.store.retain(key,raw).then(()=>undefined));
  need(started,'Wallet approval lacks its durable recovery marker.');await this.store.retainSigned(key,wire);this.dismiss();guard();
 });}
 upload(){return this.run(false,async guard=>{const op=await this.op(),p=purchase(op);need(p&&!p.release&&!op.observedComplete&&op.wire);await this.request({kind:'fill',action:'signed',id:p.fill.id,body:{signedTransactionHex:op.wire.signedTransactionHex}},guard,marketKey(op.command));guard();});}
 deliver(){return this.run(true,async guard=>{const op=await this.op(),p=purchase(op);need(p?.wire&&!p.release&&!op.observedComplete);const key=marketKey(op.command),retain=(raw:unknown)=>this.store.retain(key,raw).then(()=>undefined);
  let recovered=p;try{recovered=KeepEquipmentPurchaseSchema.parse(await this.request({kind:'fill',action:'recover',id:p.fill.id},guard,key));}
  catch(error){if(!(error instanceof ApiError)||error.status!==503||error.code!=='KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE')throw error;}
  guard();if(recovered.delivery||recovered.release){this.dismiss();return;}
  const quote=await this.ports.review(recovered,guard,retain);quote.assertFresh();await this.request({kind:'fill',action:'deliver',id:p.fill.id},()=>{guard();quote.assertFresh();},key);guard();this.dismiss();
 },undefined,'saved-delivery');}
 release(){return this.run(false,async guard=>{const op=await this.op(),p=purchase(op);need(p&&canRelease(op),'Recover the saved payment; this reservation cannot yet be released.');
  await this.request({kind:'fill',action:'release',id:p.fill.id},guard,marketKey(op.command));guard();this.set({reviewed:null,stock:null,offers:null});
 });}
 archive(){return this.run(false,async guard=>{const op=await this.op();await this.store.archive(marketKey(op.command));guard();this.set({selected:null,reviewed:null});});}
}
