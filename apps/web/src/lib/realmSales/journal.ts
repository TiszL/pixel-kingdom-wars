import {PublicKey} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {RealmSalePreparationSchema,RealmSalePrepareRequestSchema,RealmSaleSignedWireSchema,type RealmSalePreparationView,type RealmSalePrepareRequest,type RealmSaleSignedWireView} from '@shardkeep/shared/realmSalesApi';
import {RealmSaleSettlementSchema,type RealmSaleSettlementView} from '@shardkeep/shared/realmSaleSettlementApi';
import {verifySignedRealmSale,type SignedRealmSale} from './signing';
import {verifyRealmSaleSettlement} from './settlement';
import {RealmSaleFailureSchema,RealmSaleFailureEnvelopeSchema,type RealmSaleFailureView} from '@shardkeep/shared/realmSaleFailureApi';
import {verifyRealmSaleFailure,type RealmSaleFailureTrust} from './failure';
import {parseRealmSalePrepareRefusal,type RealmSalePrepareRefusal} from './refusal';
export type RealmSaleIdentity={origin:string;api:string;cluster:'devnet'|'mainnet-beta';wallet:string};
export type RealmSaleOperation={request:RealmSalePrepareRequest;prepareAttempted:boolean;preparation:RealmSalePreparationView|null;signingStarted:boolean;signed:SignedRealmSale|null;submitAttempted:boolean;prepareRefusal?:RealmSalePrepareRefusal;refusalConfirmedAbsent?:true;failureObserved?:true;failure?:{wire:RealmSaleSignedWireView;value:RealmSaleFailureView};settlementObserved?:true;settlement?:{wire:RealmSaleSignedWireView;value:RealmSaleSettlementView}};
export type RealmSaleJournal={version:1;identity:RealmSaleIdentity;revision:number;operation:RealmSaleOperation|null;lastArchivedKey?:string};
function refusedAndAbsent(op:RealmSaleOperation):boolean{return !!op.prepareRefusal&&op.refusalConfirmedAbsent===true&&op.preparation===null&&!op.signingStarted&&op.signed===null&&!op.submitAttempted&&!op.settlementObserved&&!op.settlement&&!op.failureObserved&&!op.failure;}
function archivable(op:RealmSaleOperation|null|undefined):boolean{return !!op&&(!!op.settlement&&!op.failureObserved||!!op.failure&&!op.settlementObserved||refusedAndAbsent(op));}
const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
function need(v:unknown,message:string):asserts v{if(!v)throw new Error(message);}
function exact(raw:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 need(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Reflect.ownKeys(raw).every(k=>typeof k==='string'&&[...keys,...optional].includes(k))&&keys.every(k=>Object.hasOwn(raw,k)),'Invalid saved realm sale fields.');return raw as Record<string,unknown>;
}
export function parseRealmSaleIdentity(raw:unknown):RealmSaleIdentity{
 const r=exact(raw,['origin','api','cluster','wallet']);need(typeof r.origin==='string'&&r.origin.length<=2048&&typeof r.api==='string'&&r.api.length<=2048&&(r.cluster==='devnet'||r.cluster==='mainnet-beta'),'Invalid realm sale scope.');
 const origin=new URL(r.origin),api=new URL(r.api);
 need(['http:','https:'].includes(origin.protocol)&&['http:','https:'].includes(api.protocol)&&origin.origin===r.origin&&!api.username&&!api.password&&!api.search&&!api.hash&&api.href.replace(/\/$/,'')===r.api,'Invalid realm sale origin or API scope.');
 need(typeof r.wallet==='string'&&r.wallet.length>=32&&r.wallet.length<=44&&new PublicKey(r.wallet).toBase58()===r.wallet,'Invalid realm sale wallet.');
 return Object.freeze({origin:r.origin,api:r.api,cluster:r.cluster,wallet:r.wallet});
}
async function parseOperation(raw:unknown,identity:RealmSaleIdentity,trust:RealmSaleFailureTrust|null):Promise<RealmSaleOperation>{
 const r=exact(raw,['request','prepareAttempted','preparation','signingStarted','signed','submitAttempted'],['settlementObserved','settlement','prepareRefusal','refusalConfirmedAbsent','failureObserved','failure']),request=RealmSalePrepareRequestSchema.parse(r.request);
 need(typeof r.prepareAttempted==='boolean'&&typeof r.signingStarted==='boolean'&&typeof r.submitAttempted==='boolean','Invalid realm sale attempt marker.');
 const prepareRefusal=r.prepareRefusal===undefined?undefined:parseRealmSalePrepareRefusal(r.prepareRefusal);
 need(!prepareRefusal||r.prepareAttempted,'A refusal requires the original prepare attempt.');
 need(r.refusalConfirmedAbsent===undefined||r.refusalConfirmedAbsent===true&&prepareRefusal,'Invalid refused absence marker.');const refusalConfirmedAbsent=r.refusalConfirmedAbsent as true|undefined;
 const preparation=r.preparation===null?null:RealmSalePreparationSchema.parse(r.preparation);
 if(preparation)need(r.prepareAttempted&&preparation.wallet===identity.wallet&&preparation.idempotencyKey===request.idempotencyKey&&preparation.spot===request.spot&&preparation.realm===request.realm,'Realm sale preparation differs from the original actor or request.');
 need(!r.signingStarted||preparation!==null,'Signing requires the original reviewed preparation.');
 // Own every remaining mutable input before cryptography yields to another task.
 const prepareAttempted=r.prepareAttempted,signingStarted=r.signingStarted,submitAttempted=r.submitAttempted;
 need(r.settlementObserved===undefined||r.settlementObserved===true,'Invalid settlement observation.');const settlementObserved=r.settlementObserved;
 const evidence=r.settlement===undefined?undefined:exact(r.settlement,['wire','value']);
 const savedEvidence=evidence?{wire:RealmSaleSignedWireSchema.parse(evidence.wire),value:RealmSaleSettlementSchema.parse(evidence.value)}:undefined;
 need(r.failureObserved===undefined||r.failureObserved===true,'Invalid failure observation.');const failureObserved=r.failureObserved;
 const failed=r.failure===undefined?undefined:exact(r.failure,['wire','value']);
 const savedFailure=failed?{wire:RealmSaleSignedWireSchema.parse(failed.wire),value:RealmSaleFailureSchema.parse(failed.value)}:undefined;
 let signed:SignedRealmSale|null=null;
 if(r.signed!==null){
  need(preparation&&signingStarted,'A signature requires the original signing marker.');const saved=exact(r.signed,['wire','signature']);
  need(typeof saved.wire==='string'&&saved.wire.length>=88&&saved.wire.length<=1644&&typeof saved.signature==='string'&&saved.signature.length>=64&&saved.signature.length<=88,'Invalid retained realm sale wire.');
  const wire=saved.wire,signature=saved.signature,verified=await verifySignedRealmSale(preparation,wire);
  need(verified.signature===signature,'Retained realm sale signature identity is invalid.');signed={wire:verified.wire,signature:verified.signature};
 }
 need(!submitAttempted||signed!==null,'Submission requires the exact retained signed wire.');
 let settlement:RealmSaleOperation['settlement'];
 if(savedEvidence){
  need(settlementObserved&&preparation&&signed,'Settlement requires the original signed purchase and observed receipt.');
  need(savedEvidence.wire.signedTransactionHex===Buffer.from(signed.wire,'base64').toString('hex')&&savedEvidence.wire.signature===signed.signature,'Settlement differs from the original signed purchase.');
  settlement={wire:savedEvidence.wire,value:await verifyRealmSaleSettlement(preparation,savedEvidence.wire,savedEvidence.value)};
 }
 let failure:RealmSaleOperation['failure'];
 if(savedFailure){
  need(failureObserved&&preparation&&signed&&trust&&!savedEvidence,'Failure requires independent trust and the original signed purchase without a conflicting settlement.');
  need(savedFailure.wire.signedTransactionHex===Buffer.from(signed.wire,'base64').toString('hex')&&savedFailure.wire.signature===signed.signature,'Failure differs from the original signed purchase.');
  failure={wire:savedFailure.wire,value:(await verifyRealmSaleFailure(preparation,savedFailure.wire,savedFailure.value,trust)).failure};
 }
 return {request,prepareAttempted,preparation,signingStarted,signed,submitAttempted,...(failureObserved?{failureObserved}:{}),...(failure?{failure}:{}),...(prepareRefusal?{prepareRefusal}:{}),...(refusalConfirmedAbsent?{refusalConfirmedAbsent}:{}),...(settlementObserved?{settlementObserved}:{}),...(settlement?{settlement}:{})};
}
/** Historical evidence is validated independently of view lifecycle and live admission. */
export async function parseRealmSaleJournal(raw:unknown,expected:RealmSaleIdentity,trust:RealmSaleFailureTrust|null=null):Promise<RealmSaleJournal>{
 const r=exact(raw,['version','identity','revision','operation'],['lastArchivedKey']),identity=parseRealmSaleIdentity(r.identity),scope=parseRealmSaleIdentity(expected);
 need(r.version===1&&same(identity,scope)&&Number.isSafeInteger(r.revision)&&Number(r.revision)>=0,'Invalid realm sale journal identity or revision.');
 const lastArchivedKey=r.lastArchivedKey===undefined?undefined:RealmSalePrepareRequestSchema.shape.idempotencyKey.parse(r.lastArchivedKey);
 const revision=r.revision as number,operation=r.operation===null?null:await parseOperation(r.operation,identity,trust===null?null:{...trust});
 need(revision>0||operation===null&&!lastArchivedKey,'Original realm sale intent requires a durable revision.');
 need(!lastArchivedKey||operation?.request.idempotencyKey!==lastArchivedKey,'Archived purchase keys cannot be reused.');
 return {version:1,identity,revision,operation,...(lastArchivedKey?{lastArchivedKey}:{})};
}
function assertTransition(old:RealmSaleJournal,next:RealmSaleJournal):void{
 need(old.lastArchivedKey===next.lastArchivedKey,'Archived realm sale history cannot change.');
 const a=old.operation,b=next.operation;
 if(!a){if(b)need(!b.prepareAttempted&&b.preparation===null&&!b.signingStarted&&b.signed===null&&!b.submitAttempted&&!b.settlementObserved&&!b.settlement&&!b.prepareRefusal&&!b.refusalConfirmedAbsent&&!b.failureObserved&&!b.failure,'Persist the original request before any external attempt or result.');return;}
 need(b,'The original realm sale cannot be cleared.');need(same(a.request,b.request),'The original realm sale request cannot change.');
 need(!a.prepareAttempted||b.prepareAttempted,'The original prepare attempt cannot reset.');need(!a.signingStarted||b.signingStarted,'The original signing marker cannot reset.');need(!a.submitAttempted||b.submitAttempted,'The original submit attempt cannot reset.');
 if(a.prepareRefusal)need(same(a.prepareRefusal,b.prepareRefusal),'The original preparation refusal cannot change.');
 need(!a.refusalConfirmedAbsent||b.refusalConfirmedAbsent,'Confirmed refused absence cannot reset.');
 if(!a.prepareRefusal&&b.prepareRefusal)need(a.prepareAttempted&&!a.preparation&&!a.signingStarted&&!a.signed&&!a.submitAttempted&&!a.settlementObserved&&!b.preparation&&!b.signingStarted&&!b.signed&&!b.submitAttempted&&!b.settlementObserved&&!b.refusalConfirmedAbsent&&!b.failureObserved&&!b.failure,'Only the first unsigned prepare response may record refusal.');
 if(!a.refusalConfirmedAbsent&&b.refusalConfirmedAbsent)need(a.prepareRefusal&&refusedAndAbsent(b),'Confirm an unsigned refused original is absent before archival.');
 if(a.preparation)need(same(a.preparation,b.preparation),'The original realm sale preparation cannot change.');
 if(a.signed)need(same(a.signed,b.signed),'The original signed realm sale cannot change.');
 need(!a.failureObserved||b.failureObserved,'An observed failure cannot disappear.');
 if(a.failure)need(same(a.failure,b.failure),'The verified failed purchase cannot change.');
 if(!a.failure&&b.failure)need(a.failureObserved&&a.signed,'Retain the original signed bytes and failure observation before its proof.');
 need(!a.settlementObserved||b.settlementObserved,'An observed settlement cannot disappear.');
 if(a.settlement)need(same(a.settlement,b.settlement),'The verified historical settlement cannot change.');
 if(!a.settlement&&b.settlement)need(a.settlementObserved&&a.signed,'Retain the original signed bytes and settlement observation before its verified receipt.');
 if(!a.preparation&&b.preparation)need(a.prepareAttempted,'Persist the original prepare attempt before its result.');
 if(!a.signingStarted&&b.signingStarted)need(a.preparation&&!b.signed&&!b.submitAttempted&&!b.settlementObserved&&!b.prepareRefusal&&!b.failureObserved,'Persist signing start before receiving wallet bytes; an observed settlement cannot sign again.');
 if(!a.signed&&b.signed)need(a.signingStarted,'Persist signing start before receiving wallet bytes.');
 if(!a.submitAttempted&&b.submitAttempted)need(a.signed&&!b.settlementObserved&&!b.failureObserved,'Persist signed bytes before submission; an observed settlement cannot submit again.');
}
export interface RealmSaleStore{
 readonly identity:RealmSaleIdentity;readonly key:string;
 observeSettlementKey(key:string):void;observeFailureKey(key:string):void;settlementHeld():boolean;
 read():Promise<RealmSaleJournal>;
 compareAndSet(revision:number,update:(old:RealmSaleJournal)=>RealmSaleJournal):Promise<RealmSaleJournal>;
 archive(revision:number):Promise<RealmSaleJournal>;
 archiveFailure(revision:number,fresh:unknown):Promise<RealmSaleJournal>;
 archived(idempotencyKey:string):Promise<RealmSaleJournal|null>;
}
// A failed durable write must still hold across stores and screen remounts in
// this browser process. Factories/databases keep independent storage isolated.
const memoryHolds=new WeakMap<object,Map<string,Set<string>>>();
const failureHolds=new WeakMap<object,Map<string,Set<string>>>();
/** Active consent and immutable history share one strict-durability transaction.
 * Separate history records keep every ordinary read's cryptographic work bounded.
 * A linked previous key preserves discovery without an ever-growing receipt array. */
export class RealmSaleJournalStore implements RealmSaleStore{
 readonly identity:RealmSaleIdentity;readonly key:string;private readonly database:Promise<IDBDatabase>;private readonly holds:Set<string>;private readonly failures:Set<string>;private readonly trust:RealmSaleFailureTrust|null;
 constructor(identity:RealmSaleIdentity,factory:IDBFactory|undefined=globalThis.indexedDB,name='pkw-realm-sale-v1',trust:RealmSaleFailureTrust|null=null){
  this.trust=trust===null?null:Object.freeze({...trust});
  this.identity=parseRealmSaleIdentity(identity);this.key=JSON.stringify(this.identity);
  const storage=factory??globalThis,scope=JSON.stringify([name,this.key]);let groups=memoryHolds.get(storage);if(!groups){groups=new Map();memoryHolds.set(storage,groups);}
  let holds=groups.get(scope);if(!holds){holds=new Set();groups.set(scope,holds);}this.holds=holds;
  let failureGroups=failureHolds.get(storage);if(!failureGroups){failureGroups=new Map();failureHolds.set(storage,failureGroups);}let failures=failureGroups.get(scope);if(!failures){failures=new Set();failureGroups.set(scope,failures);}this.failures=failures;
  this.database=new Promise((resolve,reject)=>{
   if(!factory){reject(new Error('Durable browser storage is unavailable. Realm sales cannot begin.'));return;}
   const request=factory.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('commands');
   request.onerror=()=>reject(request.error??new Error('Cannot open realm sale recovery.'));request.onblocked=()=>reject(new Error('Close older game tabs to open realm sale recovery.'));
   request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
  });void this.database.catch(()=>undefined);
 }
 observeSettlementKey(key:string):void{this.holds.add(RealmSalePrepareRequestSchema.shape.idempotencyKey.parse(key));}
 observeFailureKey(key:string):void{this.failures.add(RealmSalePrepareRequestSchema.shape.idempotencyKey.parse(key));}
 settlementHeld():boolean{return this.holds.size>0||this.failures.size>0;}
 private archiveCoversHold(op:RealmSaleOperation):boolean{return !!op.settlement&&!this.failures.has(op.request.idempotencyKey)||!!op.failure&&!this.holds.has(op.request.idempotencyKey);}
 private observationKey():string{return JSON.stringify(['archived-observations',this.identity]);}
 private observationRows(raw:unknown):Map<string,Set<'success'|'failure'>>{
  if(raw===undefined)return new Map();need(Array.isArray(raw),'Invalid archived realm observations.');const rows=new Map<string,Set<'success'|'failure'>>();
  for(const item of raw){need(Array.isArray(item)&&item.length===2&&Array.isArray(item[1])&&item[1].length<=2,'Invalid archived realm observation.');const id=RealmSalePrepareRequestSchema.shape.idempotencyKey.parse(item[0]);need(!rows.has(id),'Duplicate archived realm observation.');const tags=new Set<'success'|'failure'>();for(const tag of item[1]){need(tag==='success'||tag==='failure','Invalid archived realm observation tag.');need(!tags.has(tag),'Duplicate archived realm observation tag.');tags.add(tag);}rows.set(id,tags);}return rows;
 }
 private tags(id:string):Set<'success'|'failure'>{const tags=new Set<'success'|'failure'>();if(this.holds.has(id))tags.add('success');if(this.failures.has(id))tags.add('failure');return tags;}
 private mergeObservations(rows:Map<string,Set<'success'|'failure'>>):void{for(const [id,tags]of rows){if(tags.has('success'))this.holds.add(id);if(tags.has('failure'))this.failures.add(id);}}
 /** Preserve contradictory late observations separately from immutable receipt
  * history. Union other tabs and drain the two possible tags before returning. */
 private async persistArchivedObservations(id:string,op?:RealmSaleOperation):Promise<void>{
  const db=await this.database;let saved:Set<'success'|'failure'>|undefined;
  do{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite',{durability:'strict'}),store=tx.objectStore('commands'),q=store.get(this.observationKey());let error:unknown;
   q.onsuccess=()=>{try{const rows=this.observationRows(q.result);this.mergeObservations(rows);saved=this.tags(id);if(op&&this.archiveCoversHold(op))rows.delete(id);else rows.set(id,saved);store.put([...rows].map(([key,tags])=>[key,[...tags]]),this.observationKey());}catch(e){error=e;tx.abort();}};
   tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(error??tx.error??Error('Archived realm observations did not save.'));
  });}while([...this.tags(id)].some(tag=>!saved!.has(tag)));
  if(op&&this.archiveCoversHold(op)){this.holds.delete(id);this.failures.delete(id);}
 }
 private archiveKey(idempotencyKey:string):string{return JSON.stringify([this.identity,RealmSalePrepareRequestSchema.shape.idempotencyKey.parse(idempotencyKey)]);}
 private async snapshot(key=this.key):Promise<unknown>{
  const db=await this.database;return new Promise((resolve,reject)=>{
   const tx=db.transaction('commands','readonly'),request=tx.objectStore('commands').get(key);let raw:unknown;
   request.onsuccess=()=>{raw=request.result;};tx.oncomplete=()=>resolve(raw);tx.onabort=tx.onerror=()=>reject(tx.error??new Error('Cannot read original realm sale.'));
  });
 }
 private parse(raw:unknown):Promise<RealmSaleJournal>{return raw===undefined?Promise.resolve({version:1,identity:this.identity,revision:0,operation:null}):parseRealmSaleJournal(raw,this.identity,this.trust);}
 async read():Promise<RealmSaleJournal>{this.mergeObservations(this.observationRows(await this.snapshot(this.observationKey())));const row=await this.parse(await this.snapshot());if(row.operation?.settlementObserved)this.observeSettlementKey(row.operation.request.idempotencyKey);if(row.operation?.failureObserved)this.observeFailureKey(row.operation.request.idempotencyKey);
  for(const key of new Set([...this.holds,...this.failures]))if(key!==row.operation?.request.idempotencyKey)await this.archived(key);return row;}
 async archived(idempotencyKey:string):Promise<RealmSaleJournal|null>{
  this.mergeObservations(this.observationRows(await this.snapshot(this.observationKey())));const raw=await this.snapshot(this.archiveKey(idempotencyKey));if(raw===undefined)return null;
  if(this.tags(idempotencyKey).size)await this.persistArchivedObservations(idempotencyKey);
  const row=await parseRealmSaleJournal(raw,this.identity,this.trust);need(archivable(row.operation)&&row.operation!.request.idempotencyKey===idempotencyKey,'Invalid archived realm purchase.');
  if(this.tags(idempotencyKey).size)await this.persistArchivedObservations(idempotencyKey,row.operation!);return row;
 }
 async archive(revision:number):Promise<RealmSaleJournal>{
  const captured=await this.snapshot(),old=await this.parse(captured);
  need(Number.isSafeInteger(revision)&&revision===old.revision&&revision<Number.MAX_SAFE_INTEGER,'Another tab changed the original realm sale. Read its recovery record.');
  need(old.operation&&!old.operation.failureObserved&&archivable(old.operation),'Only a verified purchase or confirmed absent first refusal can use this archive.');
  const next:RealmSaleJournal={...old,revision:revision+1,operation:null,lastArchivedKey:old.operation!.request.idempotencyKey};
  return this.commit(captured,old,next,true);
 }
 async archiveFailure(revision:number,fresh:unknown):Promise<RealmSaleJournal>{
  const envelope=RealmSaleFailureEnvelopeSchema.parse(fresh),captured=await this.snapshot(),old=await this.parse(captured),op=old.operation;
  need(Number.isSafeInteger(revision)&&revision===old.revision&&revision<Number.MAX_SAFE_INTEGER,'Another tab changed the original realm sale. Read its recovery record.');
  need(op?.failure&&archivable(op)&&this.trust,'A complete bound failed purchase is required before archival.');
  const bound=await verifyRealmSaleFailure(op.preparation!,op.failure.wire,envelope.failure,this.trust);
  need(envelope.wallet===this.identity.wallet&&envelope.idempotencyKey===op.request.idempotencyKey&&same(bound.failure,op.failure.value),'Fresh recovery changed the saved failed purchase.');
  return this.commit(captured,old,{...old,revision:revision+1,operation:null,lastArchivedKey:op.request.idempotencyKey},true);
 }
 async compareAndSet(revision:number,update:(old:RealmSaleJournal)=>RealmSaleJournal):Promise<RealmSaleJournal>{
  need(Number.isSafeInteger(revision)&&revision>=0,'Invalid realm sale comparison revision.');
  const captured=await this.snapshot(),old=await this.parse(captured);
  need(revision===old.revision,'Another tab changed the original realm sale. Read its recovery record.');need(old.revision<Number.MAX_SAFE_INTEGER,'Realm sale revision exhausted.');
  // The callback runs exactly once. WebCrypto must finish before opening the write
  // transaction, since IndexedDB auto-commits while asynchronous work is pending.
  const proposed=structuredClone(update(structuredClone(old))),next=await parseRealmSaleJournal({...proposed,revision:old.revision+1},this.identity,this.trust);assertTransition(old,next);
  return this.commit(captured,old,next,false);
 }
 private async commit(captured:unknown,old:RealmSaleJournal,next:RealmSaleJournal,archive:boolean):Promise<RealmSaleJournal>{
  const db=await this.database;return new Promise((resolve,reject)=>{
   const tx=db.transaction('commands','readwrite',{durability:'strict'}),store=tx.objectStore('commands'),observations=store.get(this.observationKey());let failure:unknown;
   observations.onsuccess=()=>{try{this.mergeObservations(this.observationRows(observations.result));const request=store.get(this.key);
   request.onsuccess=()=>{try{
    const newlyStarting=!archive&&next.operation&&(!old.operation||!old.operation.signingStarted&&next.operation.signingStarted||!old.operation.submitAttempted&&next.operation.submitAttempted);
    need(!this.settlementHeld()||archive&&!!old.operation&&this.archiveCoversHold(old.operation)||!archive&&!newlyStarting,'A positive settlement response holds the original purchase.');
    const current=request.result as unknown,currentRevision=current===undefined?0:(current as {revision?:unknown})?.revision;
    need(currentRevision===old.revision&&same(current,captured),'Another tab changed the original realm sale. Read its recovery record.');
    if(archive){need(!old.operation?.failure&&!old.operation?.settlement||this.archiveCoversHold(old.operation),'Conflicting outcome observation holds this purchase.');store.add(old,this.archiveKey(old.operation!.request.idempotencyKey));store.put(next,this.key);}
    else if(!old.operation&&next.operation){
     const history=store.get(this.archiveKey(next.operation.request.idempotencyKey));
     history.onsuccess=()=>{try{need(history.result===undefined,'Archived purchase keys cannot be reused.');need(!this.settlementHeld(),'Positive outcome evidence holds the original purchase.');store.put(next,this.key);}catch(error){failure=error;tx.abort();}};
    }else store.put(next,this.key);
   }catch(error){failure=error;tx.abort();}};
   }catch(error){failure=error;tx.abort();}};
   tx.oncomplete=()=>{if(archive&&old.operation){if(this.archiveCoversHold(old.operation)){this.holds.delete(old.operation.request.idempotencyKey);this.failures.delete(old.operation.request.idempotencyKey);}else{void this.persistArchivedObservations(old.operation.request.idempotencyKey,old.operation).then(()=>resolve(next),reject);return;}}resolve(next);};tx.onabort=tx.onerror=()=>reject(failure??tx.error??new Error('The original realm sale did not save.'));
  });
 }
 async close():Promise<void>{(await this.database).close();}
}
