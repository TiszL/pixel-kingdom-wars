/** Strict actor-scoped CAS storage. Never evict unresolved signed purchases. */
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as P} from '@shardkeep/shared';
import {KeepEquipmentMarketListingRequestSchema,KeepEquipmentMarketFillRequestSchema,KeepEquipmentMarketCancelRequestSchema,KeepEquipmentListingSchema,KeepEquipmentCancellationSchema,KeepEquipmentPurchaseSchema,KeepEquipmentHistoryItemSchema,type KeepEquipmentPurchase} from '@shardkeep/shared/keepEquipmentMarketApi';
import {charterIdentity,type CharterIdentity} from '../charter/journal';
import {need,verifyKeepEquipmentWire,verifyKeepEquipmentReceipt,type KeepEquipmentWire} from './signing';
export const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const requestSchemas={listing:KeepEquipmentMarketListingRequestSchema,fill:KeepEquipmentMarketFillRequestSchema,cancellation:KeepEquipmentMarketCancelRequestSchema};
const originalSchemas={listing:KeepEquipmentListingSchema,fill:KeepEquipmentPurchaseSchema,cancellation:KeepEquipmentCancellationSchema};
export type KeepMarketKind=keyof typeof requestSchemas;
export interface KeepMarketCommand {kind:KeepMarketKind;key:string;request:ReturnType<(typeof requestSchemas)[KeepMarketKind]['parse']>|null}
export type KeepMarketOriginal=ReturnType<(typeof originalSchemas)[KeepMarketKind]['parse']>;
export interface KeepMarketOperation {command:KeepMarketCommand;original:KeepMarketOriginal|null;signingStarted:boolean;wire:KeepEquipmentWire|null;actions:string[];observedComplete:boolean}
export interface KeepMarketJournal {version:1;identity:CharterIdentity;revision:number;pending:KeepMarketOperation[];archive:KeepMarketOperation[]}
const actions=['create','read','prepare','signed','recover','review','deliver','release'];
const keySchema=KeepEquipmentMarketCancelRequestSchema.shape.idempotencyKey;
export const marketKey=(command:Pick<KeepMarketCommand,'kind'|'key'>)=>command.kind+':'+command.key;
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{need(value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'Equipment recovery data is invalid.');}
function command(raw:unknown):KeepMarketCommand{
 exact(raw,['kind','key','request']);const kind=KeepEquipmentHistoryItemSchema.shape.kind.parse(raw.kind),key=keySchema.parse(raw.key),request=raw.request===null?null:requestSchemas[kind].parse(raw.request);
 if(kind==='fill')KeepEquipmentMarketFillRequestSchema.shape.idempotencyKey.parse(key);
 need(!request||request.idempotencyKey===key);return {kind,key,request};
}
export const purchase=(op:KeepMarketOperation):KeepEquipmentPurchase|null=>op.command.kind==='fill'&&op.original?KeepEquipmentPurchaseSchema.parse(op.original):null;
export const complete=(op:KeepMarketOperation)=>!!op.original&&(op.command.kind!=='fill'||!!(purchase(op)?.delivery||purchase(op)?.release));
/** Historical release never infers nonpayment from a missing wallet response. */
export function canRelease(op:KeepMarketOperation){const p=purchase(op);return !!p&&!op.observedComplete&&!p.delivery&&!p.release&&(!!p.wire||p.status==='reserved'&&!op.signingStarted&&!op.wire);}
function bind(raw:unknown,c:KeepMarketCommand,wallet:string):KeepMarketOriginal{
 const v=originalSchemas[c.kind].parse(raw),request=c.request;
 if(c.kind==='fill'){
  const p=KeepEquipmentPurchaseSchema.parse(v),f=p.fill;need(f.id===c.key&&f.buyerWallet===wallet);
  if(request){const r=KeepEquipmentMarketFillRequestSchema.parse(request);need(f.listingId===r.listingId&&f.buyerBaseId===r.buyerBaseId&&f.quantity===r.quantity);}
  return p;
 }
 if(c.kind==='listing'){
  const l=KeepEquipmentListingSchema.parse(v);need(l.id===c.key&&l.sellerWallet===wallet);
  if(request){const r=KeepEquipmentMarketListingRequestSchema.parse(request);need(l.sellerBaseId===r.baseId&&l.itemId===r.itemId&&l.quantity===r.quantity&&l.unitPriceBaseUnits===r.unitPriceBaseUnits);}
  return l;
 }
 const cancelled=KeepEquipmentCancellationSchema.parse(v);need(cancelled.id===c.key&&cancelled.actorWallet===wallet);
 if(request)need(cancelled.listingId===KeepEquipmentMarketCancelRequestSchema.parse(request).listingId);return cancelled;
}
async function operation(raw:unknown,wallet:string):Promise<KeepMarketOperation>{
 exact(raw,['command','original','signingStarted','wire','actions','observedComplete']);const c=command(raw.command);
 need(typeof raw.signingStarted==='boolean'&&typeof raw.observedComplete==='boolean'&&Array.isArray(raw.actions)&&raw.actions.length<=actions.length&&raw.actions.every(a=>typeof a==='string'&&actions.includes(a))&&new Set(raw.actions).size===raw.actions.length);
 let original=raw.original===null?null:bind(raw.original,c,wallet);if(c.kind==='fill'&&original)original=await verifyKeepEquipmentReceipt(original);
 const p=c.kind==='fill'&&original?KeepEquipmentPurchaseSchema.parse(original):null;
 need(!raw.signingStarted||p?.preparation);let wire:KeepEquipmentWire|null=null;
 if(raw.wire!==null){need(raw.signingStarted&&p);wire=await verifyKeepEquipmentWire(p,raw.wire as KeepEquipmentWire);if(p.wire)need(wire.signature===p.wire.signature&&wire.wireSha256===p.wire.wireSha256);}
 return {command:c,original,signingStarted:raw.signingStarted,wire,actions:raw.actions as string[],observedComplete:raw.observedComplete};
}
function monotone(a:KeepMarketOperation,b:KeepMarketOperation){
 need(same(a.command,b.command)&&a.actions.every(value=>b.actions.includes(value))&&(!a.signingStarted||b.signingStarted)&&(!a.wire||same(a.wire,b.wire))&&(!a.observedComplete||b.observedComplete),'Original purchase markers cannot reset.');
 if(!a.signingStarted&&b.signingStarted)need(purchase(a)?.status==='prepared'&&!a.observedComplete&&!b.wire);
 if(!a.wire&&b.wire)need(a.signingStarted);
 if(!a.original)return;need(b.original);
 if(a.command.kind==='fill'){
  const first=purchase(a)!,second=purchase(b)!;need(same(first.fill,second.fill));
  for(const field of ['preparation','wire','delivery','release'] as const)if(first[field])need(same(first[field],second[field]));
  const order=['reserved','prepared','signed','delivered','released'];need(order.indexOf(second.status)>=order.indexOf(first.status));
  if(first.delivery||first.release)need(second.status===first.status,'A finished purchase cannot change its outcome.');
 }else if(a.command.kind==='listing'){
  const first=KeepEquipmentListingSchema.parse(a.original),second=KeepEquipmentListingSchema.parse(b.original);
  const {availableQuantity:aa,reservedQuantity:ar,cancelledQuantity:ac,...ai}=first,{availableQuantity:ba,reservedQuantity:br,cancelledQuantity:bc,...bi}=second;
  need(same(ai,bi)&&BigInt(ba)<=BigInt(aa)&&BigInt(br)>=BigInt(ar)&&BigInt(bc)>=BigInt(ac));
 }else need(same(a.original,b.original));
}
const observed=new WeakMap<object,Map<string,Set<string>>>();
export class KeepMarketJournalStore {
 readonly identity:CharterIdentity;readonly key:string;private db:Promise<IDBDatabase>;private observations:Set<string>;
 constructor(identity:CharterIdentity,factory:IDBFactory|undefined=globalThis.indexedDB,name='pkw-keep-equipment-v1'){
  this.identity=charterIdentity(identity);this.key=JSON.stringify(this.identity);const owner=factory??globalThis;
  let scopes=observed.get(owner);if(!scopes){scopes=new Map();observed.set(owner,scopes);}const tag=name+this.key;this.observations=scopes.get(tag)??new Set();scopes.set(tag,this.observations);
  this.db=new Promise((resolve,reject)=>{if(!factory){reject(Error('Durable payment recovery is unavailable.'));return;}const request=factory.open(name,1);
   request.onupgradeneeded=()=>request.result.createObjectStore('commands');request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Close older market tabs to recover this purchase.'));
   request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};});void this.db.catch(()=>undefined);
 }
 private async raw(){const db=await this.db;return new Promise<unknown>((resolve,reject)=>{const tx=db.transaction('commands'),q=tx.objectStore('commands').get(this.key);let result:unknown;q.onsuccess=()=>{result=q.result;};tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(tx.error);});}
 private async parse(raw:unknown):Promise<KeepMarketJournal>{
  if(raw===undefined)return {version:1,identity:this.identity,revision:0,pending:[],archive:[]};exact(raw,['version','identity','revision','pending','archive']);
  need(raw.version===1&&same(charterIdentity(raw.identity),this.identity)&&typeof raw.revision==='number'&&Number.isSafeInteger(raw.revision)&&raw.revision>=0&&Array.isArray(raw.pending)&&raw.pending.length<=P.localPendingLimit&&Array.isArray(raw.archive)&&raw.archive.length<=P.localArchiveLimit);
  const pending=await Promise.all(raw.pending.map(value=>operation(value,this.identity.wallet))),archive=await Promise.all(raw.archive.map(value=>operation(value,this.identity.wallet))),all=[...pending,...archive];
  need(new Set(all.map(value=>marketKey(value.command))).size===all.length&&archive.every(value=>value.observedComplete&&complete(value)));
  return {version:1,identity:this.identity,revision:raw.revision,pending,archive};
 }
 async read(){const value=await this.parse(await this.raw());for(const op of [...value.pending,...value.archive])if(op.observedComplete)this.observations.add(marketKey(op.command));return value;}
 private async update(change:(journal:KeepMarketJournal)=>KeepMarketJournal){
  const captured=await this.raw(),old=await this.parse(captured);need(old.revision<Number.MAX_SAFE_INTEGER);
  const next=await this.parse({...change(old),revision:old.revision+1}),db=await this.db;
  const signingClaims=next.pending.filter(op=>op.signingStarted&&!old.pending.find(previous=>marketKey(previous.command)===marketKey(op.command))?.signingStarted).map(op=>marketKey(op.command));
  const assertSigningClaims=()=>need(signingClaims.every(key=>!this.observations.has(key)),'A completed original cannot be signed again.');
  return new Promise<KeepMarketJournal>((resolve,reject)=>{const tx=db.transaction('commands','readwrite',{durability:'strict'}),store=tx.objectStore('commands'),get=store.get(this.key);let error:unknown;
   get.onsuccess=()=>{try{need(same(get.result,captured),'Another tab changed this purchase. Recover the saved original.');assertSigningClaims();store.put(next,this.key);}catch(e){error=e;tx.abort();}};
   tx.oncomplete=()=>{try{assertSigningClaims();resolve(next);}catch(e){reject(e);}};tx.onabort=tx.onerror=()=>reject(error??tx.error);});
 }
 begin(input:KeepMarketCommand){const c=command(structuredClone(input));return this.update(j=>{
  const old=[...j.pending,...j.archive].find(op=>marketKey(op.command)===marketKey(c));if(old){need(same(old.command,c));return j;}
  need(j.pending.length<P.localPendingLimit,'Payment recovery is full. Keep unresolved purchases saved.');
  return {...j,pending:[...j.pending,{command:c,original:null,signingStarted:false,wire:null,actions:[],observedComplete:false}]};
 });}
 async change(key:string,patch:Partial<Omit<KeepMarketOperation,'command'>>){const copied=structuredClone(patch),j=await this.read(),old=j.pending.find(op=>marketKey(op.command)===key);need(old,'Open the saved original purchase.');
  need(copied.signingStarted!==true||!old.signingStarted,'Wallet approval already started. Recover its original result.');
  const next=await operation({...old,...copied},this.identity.wallet);monotone(old,next);
  if(!old.signingStarted&&next.signingStarted)need(!this.observations.has(key),'A completed original cannot be signed again.');
  return this.update(current=>{const previous=current.pending.find(op=>marketKey(op.command)===key);need(previous&&same(previous,old));return {...current,pending:current.pending.map(op=>op===previous?next:op)};});
 }
 async mark(key:string,action:string){need(actions.includes(action));const op=(await this.read()).pending.find(value=>marketKey(value.command)===key);need(op);return this.change(key,{actions:[...new Set([...op.actions,action])]});}
 async retain(key:string,raw:unknown){const owned=structuredClone(raw),op=(await this.read()).pending.find(value=>marketKey(value.command)===key);need(op);const original=bind(owned,op.command,this.identity.wallet);
  if(complete({...op,original})){this.observations.add(key);if(!op.observedComplete)await this.change(key,{observedComplete:true});}
  return this.change(key,{original:op.command.kind==='fill'?await verifyKeepEquipmentReceipt(original):original});
 }
 startSigning(key:string){return this.change(key,{signingStarted:true});}
 retainSigned(key:string,wire:KeepEquipmentWire){return this.change(key,{wire});}
 archive(key:string){return this.update(j=>{const op=j.pending.find(value=>marketKey(value.command)===key);need(op&&complete(op)&&op.observedComplete&&j.archive.length<P.localArchiveLimit,'Recover the completed original before archiving.');return {...j,pending:j.pending.filter(value=>value!==op),archive:[...j.archive,op]};});}
 async close(){(await this.db).close();}
}
