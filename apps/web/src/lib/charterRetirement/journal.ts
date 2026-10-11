import {CharterRetirementDraftSchema,CharterRetirementRequestSchema,CharterRetirementWireSchema,CharterRetirementJournalSchema as Shape,type CharterRetirementJournalRecord,type CharterRetirementDraft,type CharterRetirementRequest,type CharterRetirementWire} from '@shardkeep/shared/charterRetirementApi';
import {charterIdentity,type CharterIdentity} from '../charter/journal';
import {verifyRetirementWire} from './signing';
const Id=CharterRetirementRequestSchema.shape.clanId,outcomes=['completed','cancelled','draft_cancelled','unknown'] as const;
type Outcome=typeof outcomes[number];
export type RetirementJournal=Omit<CharterRetirementJournalRecord,'identity'>&{identity:CharterIdentity};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const fresh=(identity:CharterIdentity):RetirementJournal=>({version:1,identity,revision:0,request:null,draftId:null,draft:null,signingStarted:false,signed:null,observed:[]});
const holds=new WeakMap<object,Map<string,Set<Outcome>>>();
function compatible(before:CharterRetirementDraft,after:CharterRetirementDraft){
 for(const field of ['id','actor','request','clan','fenceId','totalShards','shares'] as const)need(same(before[field],after[field]),'The saved dissolution terms changed.');
 if(before.cancelled)need(after.cancelled,'Cancelled dissolution cannot reopen.');
 if(before.memberPayment)need(same(before.memberPayment,after.memberPayment),'The original member payout changed.');
 if(before.operation){
  const a=before.operation,b=after.operation;need(b&&same(a.original,b.original)&&same(a.memberPayment,b.memberPayment),'The original dissolution changed.');
  for(const field of ['attempt','preparation','signed','terminal'] as const)if(a[field])need(same(a[field],b[field]),'Original dissolution evidence changed.');
  const stages=['cleared','issuing','prepared','signed','completed','cancelled'];need(stages.indexOf(b.status)>=stages.indexOf(a.status),'Dissolution history cannot regress.');
 }
}
/** One wallet journal with strict IndexedDB compare-and-swap. Persist the request
 * before HTTP and the signing marker before the wallet can expose a signature. */
export class RetirementJournalStore{
 readonly identity:CharterIdentity;readonly key:string;private db:Promise<IDBDatabase>;private held:Set<Outcome>;
 constructor(identity:CharterIdentity,factory:IDBFactory|undefined=globalThis.indexedDB,name='pkw-charter-retirement-v1'){
  this.identity=charterIdentity(identity);this.key=JSON.stringify(this.identity);const owner=factory??globalThis;let scopes=holds.get(owner);if(!scopes){scopes=new Map();holds.set(owner,scopes);}const scope=JSON.stringify([name,this.key]);this.held=scopes.get(scope)??new Set();scopes.set(scope,this.held);
  this.db=new Promise((resolve,reject)=>{if(!factory){reject(Error('Durable dissolution recovery is unavailable.'));return;}const q=factory.open(name,1);q.onupgradeneeded=()=>q.result.createObjectStore('commands');q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('Close older game tabs to recover dissolution.'));q.onsuccess=()=>{q.result.onversionchange=()=>q.result.close();resolve(q.result);};});void this.db.catch(()=>undefined);
 }
 private async raw():Promise<unknown>{const db=await this.db;return new Promise((resolve,reject)=>{const tx=db.transaction('commands'),q=tx.objectStore('commands').get(this.key);let value:unknown;q.onsuccess=()=>{value=q.result;};tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error);});}
 private async parse(raw:unknown):Promise<RetirementJournal>{
  if(raw===undefined)return fresh(this.identity);const v=Shape.parse(raw);need(same(charterIdentity(v.identity),this.identity),'Dissolution history belongs to another account.');
  need(new Set(v.observed).size===v.observed.length,'Duplicate dissolution outcome.');
  if(v.draft)need(v.draft.actor===this.identity.wallet&&v.draft.id===v.draftId&&(!v.request||same(v.request,v.draft.request)),'The saved dissolution identity changed.');
  if(v.signingStarted)need(v.draft?.operation?.preparation,'Signing lacks the original preparation.');
  if(v.signed){need(v.signingStarted&&v.draft?.operation,'A signature lacks its saved original.');await verifyRetirementWire(v.draft.operation,v.signed);}
  if(v.draft?.operation?.signed)await verifyRetirementWire(v.draft.operation,v.draft.operation.signed);
  return {...v,identity:this.identity};
 }
 private async write(captured:unknown,old:RetirementJournal,next:RetirementJournal){
  need(old.revision<Number.MAX_SAFE_INTEGER,'Dissolution history is full.');const parsed=await this.parse({...next,revision:old.revision+1}),db=await this.db;
  return new Promise<RetirementJournal>((resolve,reject)=>{const tx=db.transaction('commands','readwrite',{durability:'strict'}),s=tx.objectStore('commands'),q=s.get(this.key);let error:unknown;
   q.onsuccess=()=>{try{need(same(q.result,captured),'Another tab changed dissolution recovery.');s.put(parsed,this.key);}catch(e){error=e;tx.abort();}};
   tx.oncomplete=()=>resolve(parsed);tx.onabort=tx.onerror=()=>reject(error??tx.error??Error('Dissolution recovery did not save.'));});
 }
 private async update(fn:(old:RetirementJournal)=>RetirementJournal){const captured=await this.raw(),old=await this.parse(captured);return this.write(captured,old,fn(old));}
 async read(){const row=await this.parse(await this.raw());for(const tag of row.observed)this.held.add(tag);if([...this.held].some(tag=>!row.observed.includes(tag)))return this.update(j=>({...j,observed:[...new Set([...j.observed,...this.held])]}));return row;}
 begin(raw:CharterRetirementRequest){const request=CharterRetirementRequestSchema.parse(structuredClone(raw));return this.update(j=>{need(!j.request&&!j.draftId||same(j.request,request),'Recover the saved dissolution before starting another.');return {...j,request};});}
 open(raw:string){const draftId=Id.parse(raw);return this.update(j=>{need(!j.request&&!j.draftId||j.draftId===draftId,'Recover the saved dissolution before opening another.');return {...j,draftId};});}
 async retain(raw:unknown){
  const owned=structuredClone(raw),value=owned as Partial<CharterRetirementDraft>,row=await this.read();
  need(value.actor===this.identity.wallet&&Id.safeParse(value.id).success&&(row.draftId?row.draftId===value.id:row.request&&row.request.clanId===value.request?.clanId&&row.request.idempotencyKey===value.request?.idempotencyKey),'Dissolution response has no saved request.');
  // An observed terminal holds approval even if the remainder of its response
  // is malformed or the durable write fails. A later valid read resolves it.
  const tags:Outcome[]=[];
  if(value.cancelled===true)tags.push('draft_cancelled');
  if(value.operation?.status==='completed'||value.operation?.status==='cancelled')tags.push(value.operation.status);
  const terminal=value.operation?.terminal;
  if(terminal?.outcome==='completed'||terminal?.outcome==='cancelled')tags.push(terminal.outcome);
  else if(terminal!==undefined&&terminal!==null&&!tags.length)tags.push('unknown');
  if(tags.length){for(const tag of tags)this.held.add(tag);await this.update(j=>({...j,observed:[...new Set<Outcome>([...j.observed,...tags])]}));}
  const draft=CharterRetirementDraftSchema.parse(owned);
  const terminalValid=draft.cancelled||!!draft.operation?.terminal;const saved=await this.update(j=>{if(j.draft)compatible(j.draft,draft);return {...j,draftId:draft.id,draft,observed:terminalValid?j.observed.filter(tag=>tag!=='unknown'):j.observed};});if(terminalValid)this.held.delete('unknown');return saved;
 }
 beginSigning(messageSha256:string){return this.update(j=>{need(!j.signingStarted&&!j.observed.length&&!this.held.size&&j.draft?.operation?.preparation?.packet.messageSha256===messageSha256&&!j.draft.cancelled&&!j.draft.operation.terminal&&!j.draft.operation.signed,'Recover the original signature or outcome first.');return {...j,signingStarted:true};});}
 async retainSigned(raw:CharterRetirementWire){const wire=CharterRetirementWireSchema.parse(structuredClone(raw)),j=await this.read();need(j.signingStarted&&j.draft?.operation,'Save the signing request first.');await verifyRetirementWire(j.draft.operation,wire);return this.update(old=>{need(!old.signed||same(old.signed,wire),'The original signed transaction cannot change.');return {...old,signed:wire};});}
 async archives(){const db=await this.db,prefix=this.key+':archive:',rows=await new Promise<unknown[]>((resolve,reject)=>{const tx=db.transaction('commands'),q=tx.objectStore('commands').openCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'),'prev'),values:unknown[]=[];q.onsuccess=()=>{const cursor=q.result;if(cursor&&values.length<64){values.push(cursor.value);cursor.continue();}};tx.oncomplete=()=>resolve(values);tx.onabort=tx.onerror=()=>reject(tx.error);});return Promise.all(rows.map(row=>this.parse(row)));}
 async archive(){
  const captured=await this.raw(),old=await this.parse(captured),outcome=old.draft?.cancelled?'draft_cancelled':old.draft?.operation?.terminal?.outcome;
  need(outcome&&[...new Set([...old.observed,...this.held])].every(tag=>tag===outcome),'The original dissolution outcome is unresolved.');need(old.revision<Number.MAX_SAFE_INTEGER,'Dissolution history is full.');const next={...fresh(this.identity),revision:old.revision+1},db=await this.db;
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite',{durability:'strict'}),s=tx.objectStore('commands'),q=s.get(this.key);let error:unknown;q.onsuccess=()=>{try{need(same(q.result,captured),'Another tab changed dissolution recovery.');s.add(old,this.key+':archive:'+String(old.revision).padStart(16,'0'));s.put(next,this.key);}catch(e){error=e;tx.abort();}};tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(error??tx.error);});this.held.clear();return next;
 }
 async close(){(await this.db).close();}
}
