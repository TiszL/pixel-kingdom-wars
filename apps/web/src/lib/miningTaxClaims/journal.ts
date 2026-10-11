/** Durable original tax consent and custody. Historical attestation binding does
 * not grant current signing/relay permission or independently prove finality. */
import {PublicKey} from '@solana/web3.js';
import {MiningTaxClaimPreparationSchema,type MiningTaxClaimPreparation,type MiningTaxClaimPrepareRequest} from '@shardkeep/shared/miningTaxClaimsApi';
import {validateMiningTaxClaimRecoveryEnvelope,type MiningTaxClaimRecoveryEnvelope} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import {prepareMiningTaxClaimSigning,verifySignedMiningTaxClaim,type SignedMiningTaxClaim,type MiningTaxClaimSigningTrust} from './signing';
import {verifyMiningTaxClaimSettlement} from './settlement';
import {MiningTaxClaimFailureEnvelopeSchema,type MiningTaxClaimFailureEnvelope} from '@shardkeep/shared/miningTaxClaimFailureApi';
import {verifyMiningTaxClaimFailure} from './failure';
import {MiningTaxClaimContinuationRequestSchema,MiningTaxClaimContinuationEnvelopeSchema,type MiningTaxClaimContinuationRequest} from '@shardkeep/shared/miningTaxClaimContinuationApi';
import {verifyMiningTaxClaimContinuation} from './continuation';
export type MiningTaxClaimContinuationIntent={request:MiningTaxClaimContinuationRequest;attempted:boolean;envelope:ReturnType<typeof MiningTaxClaimContinuationEnvelopeSchema.parse>|null};
export type MiningTaxClaimIdentity={origin:string;api:string;cluster:'devnet'|'mainnet-beta';wallet:string};
export type MiningTaxClaimCustody={ordinal:number;signingStarted:boolean;signed:SignedMiningTaxClaim|null;submitAttempted:boolean};
export type MiningTaxClaimOperation={request:MiningTaxClaimPrepareRequest;prepareAttempted:boolean;preparation:MiningTaxClaimPreparation|null;transactions:MiningTaxClaimCustody[];observed:number[];unattributedObserved:boolean;setup:MiningTaxClaimRecoveryEnvelope|null;settlement:MiningTaxClaimRecoveryEnvelope|null;failure?:MiningTaxClaimFailureEnvelope|null;failureObserved?:boolean;continuation?:MiningTaxClaimContinuationIntent;continuationObserved?:boolean};
export type MiningTaxClaimJournal={version:1;identity:MiningTaxClaimIdentity;revision:number;operation:MiningTaxClaimOperation|null;lastArchivedKey?:string};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function need(v:unknown,message:string):asserts v{if(!v)throw Error(message);}
function exact(v:unknown,names:string,optional:string[]=[]):Record<string,unknown>{
 need(v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null),'Invalid saved tax fields.');const required=names.split(' '),keys=Reflect.ownKeys(v);
 need(required.every(k=>Object.hasOwn(v,k))&&keys.every(k=>typeof k==='string'&&[...required,...optional].includes(k)&&'value' in Object.getOwnPropertyDescriptor(v,k)!),'Invalid saved tax fields.');return v as Record<string,unknown>;
}
const key=(v:unknown)=>MiningTaxClaimPreparationSchema.shape.idempotencyKey.parse(v);
function ordinal(v:unknown):number{need(typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=1,'Invalid tax wire ordinal.');return v;}
export function parseMiningTaxClaimIdentity(value:unknown):MiningTaxClaimIdentity{
 const r=exact(value,'origin api cluster wallet');need(typeof r.origin==='string'&&r.origin.length<=2048&&typeof r.api==='string'&&r.api.length<=2048&&(r.cluster==='devnet'||r.cluster==='mainnet-beta'),'Invalid tax scope.');const origin=new URL(r.origin),api=new URL(r.api);
 need(['https:','http:'].includes(origin.protocol)&&['https:','http:'].includes(api.protocol)&&origin.origin===r.origin&&!api.username&&!api.password&&!api.search&&!api.hash&&api.href.replace(/\/$/,'')===r.api,'Invalid tax origin or API scope.');
 need(typeof r.wallet==='string'&&r.wallet.length>=32&&r.wallet.length<=44&&new PublicKey(r.wallet).toBase58()===r.wallet,'Invalid tax wallet.');return Object.freeze({origin:r.origin,api:r.api,cluster:r.cluster,wallet:r.wallet});
}
function request(value:unknown):MiningTaxClaimPrepareRequest{const r=exact(value,'idempotencyKey round spot caps'),s=MiningTaxClaimPreparationSchema.shape;return {idempotencyKey:key(r.idempotencyKey),round:s.round.parse(r.round),spot:s.spot.parse(r.spot),caps:s.caps.parse(r.caps)};}
function pins(trust:MiningTaxClaimSigningTrust):MiningTaxClaimSigningTrust{return Object.freeze({genesisHash:trust.genesisHash,programId:trust.programId,configAddress:trust.configAddress,keepMint:trust.keepMint,reserveOwner:trust.reserveOwner,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256});}
async function parseOperation(value:unknown,identity:MiningTaxClaimIdentity,trust:MiningTaxClaimSigningTrust):Promise<MiningTaxClaimOperation>{
 const r=exact(value,'request prepareAttempted preparation transactions observed unattributedObserved setup settlement',['failure','failureObserved','continuation','continuationObserved']),original=request(r.request),prepareAttempted=r.prepareAttempted,unattributedObserved=r.unattributedObserved;
 need(r.failureObserved===undefined||typeof r.failureObserved==='boolean','Invalid tax failure observation.');
 need(r.continuationObserved===undefined||typeof r.continuationObserved==='boolean','Invalid tax continuation observation.');
 let continuation:MiningTaxClaimContinuationIntent|undefined;
 if(r.continuation!==undefined){const c=exact(r.continuation,'request attempted envelope');need(typeof c.attempted==='boolean','Invalid tax continuation attempt.');continuation={request:MiningTaxClaimContinuationRequestSchema.parse(c.request),attempted:c.attempted,envelope:c.envelope===null?null:MiningTaxClaimContinuationEnvelopeSchema.parse(c.envelope)};need(continuation.request.idempotencyKey!==original.idempotencyKey,'Continuation requires a distinct key.');}

 need(typeof prepareAttempted==='boolean'&&typeof unattributedObserved==='boolean','Invalid tax attempt or observation.');const preparation=r.preparation===null?null:MiningTaxClaimPreparationSchema.parse(r.preparation);
 if(preparation)need(prepareAttempted&&preparation.wallet===identity.wallet&&same(original,{idempotencyKey:preparation.idempotencyKey,round:preparation.round,spot:preparation.spot,caps:preparation.caps}),'Tax preparation differs from original consent.');
 // Technical packet count bounds, independent of current game policy. Copy all
 // input before any async cryptography; parsed objects are not trusted proofs.
 need(Array.isArray(r.transactions)&&r.transactions.length<=2&&Array.isArray(r.observed)&&r.observed.length<=2,'Invalid tax custody or observations.');
 const observed=r.observed.map(ordinal);need(observed.every((o,i)=>o>(observed[i-1]??-1)),'Tax observations must be unique and ordered.');
 const transactions=r.transactions.map((value):MiningTaxClaimCustody=>{const t=exact(value,'ordinal signingStarted signed submitAttempted'),o=ordinal(t.ordinal);need(preparation&&o<preparation.transactions.length&&typeof t.signingStarted==='boolean'&&typeof t.submitAttempted==='boolean','Invalid original tax transaction.');let signed:SignedMiningTaxClaim|null=null;
  if(t.signed!==null){const w=exact(t.signed,'ordinal wire signature messageSha256 wireSha256');need(w.ordinal===o&&typeof w.wire==='string'&&w.wire.length>=88&&w.wire.length<=1644&&typeof w.signature==='string'&&w.signature.length>=64&&w.signature.length<=88&&typeof w.messageSha256==='string'&&/^[0-9a-f]{64}$/.test(w.messageSha256)&&typeof w.wireSha256==='string'&&/^[0-9a-f]{64}$/.test(w.wireSha256),'Invalid saved tax wire.');signed={ordinal:o,wire:w.wire,signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256};}
  need((!signed||t.signingStarted)&&(!t.submitAttempted||signed),'Tax custody lacks original attempt markers.');return {ordinal:o,signingStarted:t.signingStarted,signed,submitAttempted:t.submitAttempted};
 });need(transactions.every((t,i)=>t.ordinal>(transactions[i-1]?.ordinal??-1)),'Tax custody must be unique and ordered.');
 const setup=r.setup===null?null:validateMiningTaxClaimRecoveryEnvelope(r.setup),settlement=r.settlement===null?null:validateMiningTaxClaimRecoveryEnvelope(r.settlement),failure=r.failure==null?r.failure:MiningTaxClaimFailureEnvelopeSchema.parse(r.failure);
 if(preparation)await prepareMiningTaxClaimSigning(preparation,trust);
 for(const t of transactions)if(t.signed){const verified=await verifySignedMiningTaxClaim(preparation!,t.signed.wire,t.ordinal);need(same(verified,t.signed),'Tax custody signature or hashes differ.');}
 for(const [phase,recovery] of [['setup',setup],['settled',settlement]] as const)if(recovery){need(preparation&&recovery.settlement&&observed.includes(recovery.settlement.ordinal),'Retain observed tax settlement before its receipt.');const bound=await verifyMiningTaxClaimSettlement({wallet:identity.wallet,request:original,preparation,wires:transactions.flatMap(t=>t.signed?[t.signed]:[])},recovery,trust);need(bound.phase===phase,'Tax receipt has the wrong settlement phase.');}
 if(failure){need(preparation&&failure.failures.every(f=>observed.includes(f.ordinal)),'Retain observed failure before its proof.');
  await verifyMiningTaxClaimFailure({wallet:identity.wallet,request:original,preparation,wires:transactions.flatMap(t=>t.signed?[t.signed]:[])},failure,trust);
  for(const success of [setup,settlement])if(success?.settlement)need(failure.failures.every(f=>f.ordinal>success.settlement!.ordinal),'Successful and failed tax outcomes conflict.');
  if(failure.recovery.settlement)need(setup&&same(setup.settlement,failure.recovery.settlement),'Retain the exact verified setup before failed claim history.');
 }
 if(continuation){need(preparation&&setup&&preparation.transactions.length===2,'Continuation requires original split setup.');if(continuation.envelope){need(continuation.attempted&&r.continuationObserved,'Persist continuation attempt and observation before proof.');await verifyMiningTaxClaimContinuation({wallet:identity.wallet,request:original,preparation,wires:transactions.flatMap(t=>t.signed?[t.signed]:[])},setup,continuation.request,continuation.envelope,trust);}}
 return {request:original,prepareAttempted,preparation,transactions,observed,unattributedObserved,setup,settlement,...(continuation?{continuation}:{}),...(r.continuationObserved===undefined?{}:{continuationObserved:r.continuationObserved as boolean}),...(failure===undefined?{}:{failure}),...(r.failureObserved===undefined?{}:{failureObserved:r.failureObserved as boolean})};
}
/** Presentation/transition predicate only; callers must first rebind the journal.
 * Missing outcomes and unknown observations never retire a split remainder. */
export function hasCompleteMiningTaxFailure(op:MiningTaxClaimOperation):boolean{
 return !op.continuation&&!op.continuationObserved&&!!op.preparation&&!!op.failure?.failures.length&&!op.unattributedObserved&&!op.settlement&&op.observed.every(o=>o<op.preparation!.transactions.length)&&op.preparation.transactions.every((_,ordinal)=>
  op.failure!.failures.some(f=>f.ordinal===ordinal)||!!op.setup?.settlement&&op.setup.settlement.ordinal>=ordinal);
}
/** A continued parent is historical setup plus an unsigned retired remainder,
 * never a paid or failed claim. Only already-rebound journals use this predicate. */
export function hasCompleteMiningTaxContinuation(op:MiningTaxClaimOperation):boolean{return !!op.continuation?.attempted&&!!op.continuation.envelope?.continuation&&!!op.setup&&op.preparation?.transactions.length===2&&!op.failure&&!op.failureObserved&&!op.settlement&&!op.unattributedObserved&&op.observed.every(o=>o===0)&&!op.transactions.some(t=>t.ordinal===1&&(t.signingStarted||t.signed||t.submitAttempted));}
/** Parsing re-verifies original ABI, signed bytes and owner attestation bindings.
 * It never uses today's expiry, flags, wallet provider or current tax eligibility. */
export async function parseMiningTaxClaimJournal(value:unknown,expected:MiningTaxClaimIdentity,trust:MiningTaxClaimSigningTrust):Promise<MiningTaxClaimJournal>{
 const r=exact(value,'version identity revision operation',['lastArchivedKey']),identity=parseMiningTaxClaimIdentity(r.identity),scope=parseMiningTaxClaimIdentity(expected),revision=r.revision,lastArchivedKey=r.lastArchivedKey===undefined?undefined:key(r.lastArchivedKey),savedPins=pins(trust);
 need(r.version===1&&same(identity,scope)&&typeof revision==='number'&&Number.isSafeInteger(revision)&&revision>=0,'Invalid tax journal identity or revision.');const operation=r.operation===null?null:await parseOperation(r.operation,identity,savedPins);
 need(revision>0||operation===null&&!lastArchivedKey,'Tax intent requires a durable revision.');need(!lastArchivedKey||operation?.request.idempotencyKey!==lastArchivedKey,'Archived tax keys cannot be reused.');return {version:1,identity,revision,operation,...(lastArchivedKey?{lastArchivedKey}:{})};
}
function assertTransition(old:MiningTaxClaimJournal,next:MiningTaxClaimJournal):void{
 need(old.lastArchivedKey===next.lastArchivedKey,'Tax archive history cannot change.');const a=old.operation,b=next.operation;
 if(!a){if(b)need(!b.prepareAttempted&&!b.preparation&&!b.transactions.length&&!b.observed.length&&!b.unattributedObserved&&!b.setup&&!b.settlement&&!b.failure&&!b.failureObserved&&!b.continuation&&!b.continuationObserved,'Persist tax intent before external attempts or evidence.');return;}
 need(b,'Original tax consent cannot be cleared.');need(same(a.request,b.request),'Original tax intent cannot change.');need(!a.prepareAttempted||b.prepareAttempted,'Tax prepare attempt cannot reset.');need(!a.failureObserved||b.failureObserved,'Tax failure observations cannot reset.');need(!a.continuationObserved||b.continuationObserved,'Tax continuation observations cannot reset.');
 if(a.continuation){need(b.continuation&&same(a.continuation.request,b.continuation.request)&&(!a.continuation.attempted||b.continuation.attempted),'Continuation intent cannot change or reset.');if(a.continuation.envelope)need(same(a.continuation.envelope,b.continuation.envelope),'Bound continuation cannot change.');}
 else if(b.continuation)need(a.setup&&a.preparation?.transactions.length===2&&!a.transactions.some(t=>t.ordinal===1&&t.signingStarted)&&!a.failure&&!a.failureObserved&&!a.unattributedObserved&&!a.settlement&&a.observed.every(o=>o===0)&&!b.continuation.attempted&&!b.continuation.envelope,'Persist unsigned split continuation intent before its attempt.');
 if(b.continuation?.envelope&&!a.continuation?.envelope)need(a.continuation?.attempted&&a.continuationObserved,'Persist continuation attempt and observation before binding.');
 if(a.preparation)need(same(a.preparation,b.preparation),'Original tax preparation cannot change.');else if(b.preparation)need(a.prepareAttempted,'Persist tax prepare attempt before its result.');
 need(a.observed.every(o=>b.observed.includes(o))&&(!a.unattributedObserved||b.unattributedObserved),'Positive tax observations cannot disappear.');
 for(const field of ['setup','settlement'] as const){if(a[field])need(same(a[field],b[field]),'Verified tax evidence cannot change.');else if(b[field]){const receipt=b[field]!.settlement!;need(a.observed.includes(receipt.ordinal)&&Array.from({length:receipt.ordinal+1},(_,o)=>o).every(o=>a.transactions.some(t=>t.ordinal===o&&t.signed)),'Persist the signed prefix and observation before its receipt.');}}
 if(a.failure)need(b.failure&&a.failure.failures.every(f=>b.failure!.failures.some(g=>same(f,g))),'Verified tax failures cannot disappear or change.');
 if(b.failure)for(const f of b.failure.failures)need(a.observed.includes(f.ordinal)&&a.transactions.some(t=>t.ordinal===f.ordinal&&t.signed),'Persist signed custody and observation before failed history.');
 for(const t of a.transactions){const u=b.transactions.find(u=>u.ordinal===t.ordinal);need(u&&(!t.signingStarted||u.signingStarted)&&(!t.submitAttempted||u.submitAttempted),'Original tax markers cannot reset.');if(t.signed)need(same(t.signed,u.signed),'Original tax signed bytes cannot change.');}
 for(const u of b.transactions){const t=a.transactions.find(t=>t.ordinal===u.ordinal);
  if(u.signingStarted&&!t?.signingStarted)need(a.preparation&&!u.signed&&!u.submitAttempted&&!b.observed.includes(u.ordinal)&&!b.unattributedObserved&&!b.settlement&&!b.failure&&!b.failureObserved&&!b.continuation&&!b.continuationObserved,'Persist tax signing start before wallet bytes.');
  if(u.signed&&!t?.signed)need(t?.signingStarted,'Persist tax signing start before receiving bytes.');
  if(u.submitAttempted&&!t?.submitAttempted)need(t?.signed&&!b.observed.includes(u.ordinal)&&!b.unattributedObserved&&!b.settlement&&!b.failure&&!b.failureObserved&&!b.continuation&&!b.continuationObserved,'Persist tax signed bytes before submission.');
 }
}
export interface MiningTaxClaimStore{
 readonly identity:MiningTaxClaimIdentity;readonly key:string;
 observeSettlementKey(idempotencyKey:string,ordinal?:number):void;
 observeFailureKey(idempotencyKey:string):void;
 observeContinuationKey(idempotencyKey:string):void;
 settlementHeld(idempotencyKey?:string,ordinal?:number):boolean;
 otherSettlementHeld(idempotencyKey:string):boolean;
 observeSettlement(revision:number,idempotencyKey:string,ordinal?:number):Promise<MiningTaxClaimJournal>;
 read():Promise<MiningTaxClaimJournal>;
 compareAndSet(revision:number,update:(old:MiningTaxClaimJournal)=>MiningTaxClaimJournal):Promise<MiningTaxClaimJournal>;
 archive(revision:number):Promise<MiningTaxClaimJournal>;
 archiveFailure(revision:number,fresh:unknown):Promise<MiningTaxClaimJournal>;
 activateContinuation(revision:number,fresh:unknown,parent:unknown):Promise<MiningTaxClaimJournal>;
 archived(idempotencyKey:string):Promise<MiningTaxClaimJournal|null>;
}
// In-process holds survive failed reads/writes and screen/store remounts. Durable
// observations protect other tabs/restarts once their transaction has completed.
type Observation=number|null|'failure'|'continuation';
const memoryHolds=new WeakMap<object,Map<string,Map<string,Set<Observation>>>>();
/** Presence only. No stored field, server response or missing deployment pin can
 * make an old journal disappear from the recovery entry. This grants no effect
 * or receipt authority and never reads the unverified stored value. */
export async function hasMiningTaxClaimRecovery(identity:MiningTaxClaimIdentity,factory:IDBFactory|undefined=globalThis.indexedDB,name='pkw-mining-tax-v1'):Promise<boolean>{
 const scope=parseMiningTaxClaimIdentity(identity),key=JSON.stringify(scope);
 if(memoryHolds.get(factory??globalThis)?.get(JSON.stringify([name,key]))?.size)return true;
 if(!factory)throw Error('Durable browser storage is unavailable. Keep saved tax history.');
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{let abandoned=false;const q=factory.open(name,1);q.onupgradeneeded=()=>q.result.createObjectStore('commands');q.onerror=()=>{abandoned=true;reject(q.error??Error('Cannot discover tax recovery.'));};q.onblocked=()=>{abandoned=true;reject(Error('Tax recovery storage is blocked.'));};q.onsuccess=()=>{if(abandoned)q.result.close();else resolve(q.result);};});
 try{return await new Promise<boolean>((resolve,reject)=>{const tx=db.transaction('commands','readonly'),q=tx.objectStore('commands').getKey(key);let found=false;q.onsuccess=()=>{found=q.result!==undefined;};tx.oncomplete=()=>resolve(found);tx.onabort=tx.onerror=()=>reject(tx.error??Error('Cannot discover tax recovery.'));});}finally{db.close();}
}
export class MiningTaxClaimJournalStore implements MiningTaxClaimStore{
 readonly identity:MiningTaxClaimIdentity;readonly key:string;private readonly trust:MiningTaxClaimSigningTrust;private readonly database:Promise<IDBDatabase>;private readonly holds:Map<string,Set<Observation>>;
 constructor(identity:MiningTaxClaimIdentity,trust:MiningTaxClaimSigningTrust,factory:IDBFactory|undefined=globalThis.indexedDB,name='pkw-mining-tax-v1'){
  this.identity=parseMiningTaxClaimIdentity(identity);this.key=JSON.stringify(this.identity);this.trust=pins(trust);const storage=factory??globalThis,scope=JSON.stringify([name,this.key]);let groups=memoryHolds.get(storage);if(!groups){groups=new Map();memoryHolds.set(storage,groups);}let holds=groups.get(scope);if(!holds){holds=new Map();groups.set(scope,holds);}this.holds=holds;
  this.database=new Promise((resolve,reject)=>{if(!factory){reject(Error('Durable browser storage is unavailable. Tax claims cannot begin.'));return;}const q=factory.open(name,1);q.onupgradeneeded=()=>q.result.createObjectStore('commands');q.onerror=()=>reject(q.error??Error('Cannot open tax recovery.'));q.onblocked=()=>reject(Error('Close older game tabs to open tax recovery.'));q.onsuccess=()=>{q.result.onversionchange=()=>q.result.close();resolve(q.result);};});void this.database.catch(()=>undefined);
 }
 observeSettlementKey(idempotencyKey:string,wireOrdinal?:number):void{const id=key(idempotencyKey),o=wireOrdinal===undefined?null:ordinal(wireOrdinal);let held=this.holds.get(id);if(!held){held=new Set();this.holds.set(id,held);}held.add(o);}
 observeFailureKey(idempotencyKey:string):void{const id=key(idempotencyKey);let held=this.holds.get(id);if(!held){held=new Set();this.holds.set(id,held);}held.add('failure');}
 observeContinuationKey(idempotencyKey:string):void{const id=key(idempotencyKey);let held=this.holds.get(id);if(!held){held=new Set();this.holds.set(id,held);}held.add('continuation');}
 settlementHeld(idempotencyKey?:string,wireOrdinal?:number):boolean{if(idempotencyKey===undefined)return this.holds.size>0;const held=this.holds.get(key(idempotencyKey));return !!held&&(wireOrdinal===undefined||[...held].some(o=>o===null||o==='failure'||o==='continuation'||o>=ordinal(wireOrdinal)));}
 otherSettlementHeld(idempotencyKey: string): boolean {
  const original = key(idempotencyKey);
  return [...this.holds.keys()].some(held => held !== original);
 }
 async observeSettlement(revision:number,idempotencyKey:string,wireOrdinal?:number):Promise<MiningTaxClaimJournal>{
  this.observeSettlementKey(idempotencyKey,wireOrdinal);return this.compareAndSet(revision,old=>{need(old.operation?.request.idempotencyKey===idempotencyKey,'Tax observation differs from the active original.');const op=old.operation;return {...old,operation:{...op,observed:wireOrdinal===undefined?op.observed:[...new Set([...op.observed,wireOrdinal])].sort(),unattributedObserved:op.unattributedObserved||wireOrdinal===undefined}};});
 }
 private archiveKey(idempotencyKey:string):string{return JSON.stringify([this.identity,key(idempotencyKey)]);}
 private observationKey():string{return JSON.stringify(['archived-observations',this.identity]);}
 private observationRows(raw:unknown):Map<string,Set<Observation>>{
  if(raw===undefined)return new Map();
  need(Array.isArray(raw),'Invalid archived tax observations.');
  const rows=new Map<string,Set<Observation>>();
  for(const item of raw){need(Array.isArray(item)&&item.length===2&&Array.isArray(item[1])&&item[1].length<=5,'Invalid archived tax observation.');const id=key(item[0]);need(!rows.has(id),'Duplicate archived tax observation.');const tags=new Set<Observation>();for(const value of item[1]){need(value===null||value==='failure'||value==='continuation'||value===0||value===1,'Invalid archived tax observation tag.');need(!tags.has(value),'Duplicate archived tax observation tag.');tags.add(value);}rows.set(id,tags);}
  return rows;
 }
 private mergeObservations(rows:Map<string,Set<Observation>>):void{for(const [id,tags] of rows){let held=this.holds.get(id);if(!held){held=new Set();this.holds.set(id,held);}for(const tag of tags)held.add(tag);}}
 private continuationHoldsCovered(op:MiningTaxClaimOperation):boolean{return hasCompleteMiningTaxContinuation(op)&&[...this.holds.get(op.request.idempotencyKey)??[]].every(o=>o===0||o==='continuation');}
 private archiveCoversHolds(op:MiningTaxClaimOperation):boolean{return op.continuation?this.continuationHoldsCovered(op):op.settlement?!this.holds.get(op.request.idempotencyKey)?.has('failure')&&!this.holds.get(op.request.idempotencyKey)?.has('continuation'):this.failureHoldsCovered(op);}
 /** Sidecar metadata preserves later contradictions without rewriting immutable
  * receipt history. The transaction unions other tabs' observations; a tag
  * arriving during completion is drained before this read returns. */
 private async persistArchivedObservations(id:string,op?:MiningTaxClaimOperation):Promise<void>{
  const db=await this.database;
  let saved:Set<Observation>|undefined;
  do{
   await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite',{durability:'strict'}),store=tx.objectStore('commands'),q=store.get(this.observationKey());let failure:unknown;
    q.onsuccess=()=>{try{const rows=this.observationRows(q.result);this.mergeObservations(rows);saved=new Set(this.holds.get(id));if(op&&this.archiveCoversHolds(op))rows.delete(id);else rows.set(id,saved);store.put([...rows].map(([key,tags])=>[key,[...tags]]),this.observationKey());}catch(error){failure=error;tx.abort();}};
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(failure??tx.error??Error('Archived tax observations did not save.'));
   });
   // There are only five possible tags. New unknown evidence cannot be erased
   // by a transaction whose writes were queued before it arrived.
  }while([...this.holds.get(id)??[]].some(tag=>!saved!.has(tag)));
  if(op&&this.archiveCoversHolds(op))this.holds.delete(id);
 }

 private async snapshot(storageKey=this.key):Promise<unknown>{const db=await this.database;return new Promise((resolve,reject)=>{const tx=db.transaction('commands','readonly'),q=tx.objectStore('commands').get(storageKey);let raw:unknown;q.onsuccess=()=>{raw=q.result;};tx.oncomplete=()=>resolve(raw);tx.onabort=tx.onerror=()=>reject(tx.error??Error('Cannot read tax recovery.'));});}
 private latch(op:MiningTaxClaimOperation|null):void{if(op){if(op.continuationObserved)this.observeContinuationKey(op.request.idempotencyKey);if(op.failureObserved||op.failure)this.observeFailureKey(op.request.idempotencyKey);for(const o of op.observed)this.observeSettlementKey(op.request.idempotencyKey,o);if(op.unattributedObserved)this.observeSettlementKey(op.request.idempotencyKey);}}
 private async parse(raw:unknown):Promise<MiningTaxClaimJournal>{const row=raw===undefined?{version:1 as const,identity:this.identity,revision:0,operation:null}:await parseMiningTaxClaimJournal(raw,this.identity,this.trust);this.latch(row.operation);return row;}
 async read():Promise<MiningTaxClaimJournal>{this.mergeObservations(this.observationRows(await this.snapshot(this.observationKey())));const row=await this.parse(await this.snapshot());for(const id of this.holds.keys())if(id!==row.operation?.request.idempotencyKey)await this.archived(id);return row;}
 private failureHoldsCovered(op:MiningTaxClaimOperation):boolean{return hasCompleteMiningTaxFailure(op)&&[...(this.holds.get(op.request.idempotencyKey)??[])].every(o=>o==='failure'||typeof o==='number'&&o<op.preparation!.transactions.length);}
 async archived(idempotencyKey:string):Promise<MiningTaxClaimJournal|null>{this.mergeObservations(this.observationRows(await this.snapshot(this.observationKey())));const raw=await this.snapshot(this.archiveKey(idempotencyKey));if(raw===undefined)return null;if(this.holds.has(idempotencyKey))await this.persistArchivedObservations(idempotencyKey);const row=await parseMiningTaxClaimJournal(raw,this.identity,this.trust);need(row.operation&&(row.operation.settlement||hasCompleteMiningTaxFailure(row.operation)||hasCompleteMiningTaxContinuation(row.operation))&&row.operation.request.idempotencyKey===idempotencyKey,'Invalid archived tax evidence.');if(this.holds.has(idempotencyKey))await this.persistArchivedObservations(idempotencyKey,row.operation);return row;}
 async archive(revision:number):Promise<MiningTaxClaimJournal>{const captured=await this.snapshot(),old=await this.parse(captured);need(Number.isSafeInteger(revision)&&revision===old.revision&&revision<Number.MAX_SAFE_INTEGER,'Another tab changed the original tax claim. Read recovery.');need(old.operation?.settlement&&!old.operation.failureObserved&&!old.operation.continuation&&!old.operation.continuationObserved,'Only an uncontradicted bound terminal tax payment can be archived.');return this.commit(captured,old,{...old,revision:revision+1,operation:null,lastArchivedKey:old.operation.request.idempotencyKey},true);}
 async archiveFailure(revision:number,fresh:unknown):Promise<MiningTaxClaimJournal>{
  // Copy the GET result before storage/crypto awaits. The controller owns its
  // authenticated transport; this store supplies exact binding and atomic CAS.
  const envelope=MiningTaxClaimFailureEnvelopeSchema.parse(fresh),captured=await this.snapshot(),old=await this.parse(captured),op=old.operation;
  need(Number.isSafeInteger(revision)&&revision===old.revision&&revision<Number.MAX_SAFE_INTEGER,'Another tab changed the original tax claim. Read recovery.');
  need(op&&hasCompleteMiningTaxFailure(op),'Every planned tax packet needs a complete bound outcome before failed archival.');
  await verifyMiningTaxClaimFailure({wallet:this.identity.wallet,request:op.request,preparation:op.preparation!,wires:op.transactions.flatMap(t=>t.signed?[t.signed]:[])},envelope,this.trust);
  need(same(op.failure!.failures,envelope.failures)&&same(op.setup?.settlement??null,envelope.recovery.settlement),'Fresh recovery changed the saved tax outcomes.');
  return this.commit(captured,old,{...old,revision:revision+1,operation:null,lastArchivedKey:op.request.idempotencyKey},true);
 }
 async activateContinuation(revision:number,fresh:unknown,parent:unknown):Promise<MiningTaxClaimJournal>{
  const envelope=MiningTaxClaimContinuationEnvelopeSchema.parse(fresh),recovery=validateMiningTaxClaimRecoveryEnvelope(parent),captured=await this.snapshot(),old=await this.parse(captured),op=old.operation;
  need(Number.isSafeInteger(revision)&&revision===old.revision&&revision<Number.MAX_SAFE_INTEGER,'Another tab changed the original tax claim. Read recovery.');
  need(op&&hasCompleteMiningTaxContinuation(op),'Only an unsigned split remainder with a bound link can continue.');
  need(recovery.status==='setup'&&recovery.wires.length===1&&recovery.wires[0]?.ordinal===0&&same(recovery.settlement,op.setup!.settlement),'Fresh parent history changed. Keep original recovery.');
  await verifyMiningTaxClaimContinuation({wallet:this.identity.wallet,request:op.request,preparation:op.preparation!,wires:op.transactions.flatMap(t=>t.signed?[t.signed]:[])},recovery,op.continuation!.request,envelope,this.trust);
  need(same(envelope.continuation,op.continuation!.envelope!.continuation),'Fresh continuation changed the saved link.');
  const p=envelope.continuation!.childPreparation;
  const next=await parseMiningTaxClaimJournal({...old,revision:revision+1,lastArchivedKey:op.request.idempotencyKey,operation:{request:{idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:p.caps},prepareAttempted:true,preparation:p,transactions:[],observed:[],unattributedObserved:false,setup:null,settlement:null}},this.identity,this.trust);
  return this.commit(captured,old,next,true);
 }
 async compareAndSet(revision:number,update:(old:MiningTaxClaimJournal)=>MiningTaxClaimJournal):Promise<MiningTaxClaimJournal>{
  need(Number.isSafeInteger(revision)&&revision>=0,'Invalid tax comparison revision.');const captured=await this.snapshot(),old=await this.parse(captured);need(revision===old.revision&&revision<Number.MAX_SAFE_INTEGER,'Another tab changed the original tax claim. Read recovery.');
  // Own the callback result immediately; crypto must finish before the IDB write
  // transaction opens. The callback executes once, never as an implicit retry.
  const proposed=structuredClone(update(structuredClone(old))),next=await parseMiningTaxClaimJournal({...proposed,revision:revision+1},this.identity,this.trust);assertTransition(old,next);this.latch(next.operation);return this.commit(captured,old,next,false);
 }
 private async commit(captured:unknown,old:MiningTaxClaimJournal,next:MiningTaxClaimJournal,archive:boolean):Promise<MiningTaxClaimJournal>{const db=await this.database;return new Promise((resolve,reject)=>{
  const tx=db.transaction('commands','readwrite',{durability:'strict'}),store=tx.objectStore('commands'),observations=store.get(this.observationKey()),q=store.get(this.key);let failure:unknown;
  observations.onsuccess=()=>{try{this.mergeObservations(this.observationRows(observations.result));}catch(error){failure=error;tx.abort();}};
  q.onsuccess=()=>{try{const current=q.result as unknown;need((current===undefined?0:(current as {revision?:unknown})?.revision)===old.revision&&same(current,captured),'Another tab changed the original tax claim. Read recovery.');
   const a=old.operation,b=next.operation;
   if(!archive&&b){if(a&&b.continuation&&!a.continuation)need(!this.otherSettlementHeld(b.request.idempotencyKey)&&![...this.holds.get(b.request.idempotencyKey)??[]].some(o=>o!==0),'Unknown tax evidence holds continuation.');if(!a)need(!this.settlementHeld(),'Positive tax settlement holds original recovery.');else{const held=this.holds.get(b.request.idempotencyKey);for(const u of b.transactions){const t=a.transactions.find(t=>t.ordinal===u.ordinal),starting=u.signingStarted&&!t?.signingStarted||u.submitAttempted&&!t?.submitAttempted;if(starting){need(![...this.holds.keys()].some(id=>id!==b.request.idempotencyKey),'Positive tax settlement holds another original request.');need(!held||![...held].some(o=>o===null||o==='failure'||o==='continuation'||o>=u.ordinal||o<u.ordinal&&!a.setup),'Positive tax settlement holds this transaction.');}}}}
   if(archive){if(b){need(this.continuationHoldsCovered(a!)&&!this.otherSettlementHeld(a!.request.idempotencyKey),'Unknown tax evidence holds continuation.');const prior=store.get(this.archiveKey(b.request.idempotencyKey));prior.onsuccess=()=>{try{need(prior.result===undefined,'Archived tax keys cannot be reused.');need(this.continuationHoldsCovered(a!)&&!this.otherSettlementHeld(a!.request.idempotencyKey),'Unknown tax evidence holds continuation.');store.add(old,this.archiveKey(a!.request.idempotencyKey));store.put(next,this.key);}catch(error){failure=error;tx.abort();}};}else{if(a!.settlement)need(!a!.failureObserved&&!a!.continuationObserved&&this.archiveCoversHolds(a!),'Failed tax observation holds original payment recovery.');else need(this.failureHoldsCovered(a!),'Unknown tax evidence holds failed archival.');store.add(old,this.archiveKey(a!.request.idempotencyKey));store.put(next,this.key);}}
   else if(!a&&b){const history=store.get(this.archiveKey(b.request.idempotencyKey));history.onsuccess=()=>{try{need(history.result===undefined,'Archived tax keys cannot be reused.');store.put(next,this.key);}catch(error){failure=error;tx.abort();}};}
   else if(a&&b?.continuation&&!a.continuation){const history=store.get(this.archiveKey(b.continuation.request.idempotencyKey));history.onsuccess=()=>{try{need(history.result===undefined,'Archived tax keys cannot be reused.');need(!this.otherSettlementHeld(b.request.idempotencyKey)&&![...this.holds.get(b.request.idempotencyKey)??[]].some(o=>o!==0),'Unknown tax evidence holds continuation.');store.put(next,this.key);}catch(error){failure=error;tx.abort();}};}
   else store.put(next,this.key);
  }catch(error){failure=error;tx.abort();}};
  tx.oncomplete=()=>{if(archive){const op=old.operation!;if(this.archiveCoversHolds(op))this.holds.delete(op.request.idempotencyKey);else{void this.persistArchivedObservations(op.request.idempotencyKey,op).then(()=>resolve(next),reject);return;}}resolve(next);};tx.onabort=tx.onerror=()=>reject(failure??tx.error??Error('Original tax recovery did not save.'));
 });}
 async close():Promise<void>{(await this.database).close();}
}
