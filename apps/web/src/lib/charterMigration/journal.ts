import {CharterMigrationSchema,CharterMigrationRequestSchema,CharterMigrationJournalSchema as Shape,type CharterMigrationJournalRecord,type CharterMigration,type CharterMigrationRequest} from '@shardkeep/shared/charterMigrationApi';
import {CharterWireSchema,type CharterWire} from '@shardkeep/shared/charterApi';
import {charterIdentity,type CharterIdentity} from '../charter/journal';
import {verifyCharterWire} from '../charter/signing';
const Id=CharterMigrationRequestSchema.shape.clanId,outcomes=['controlled','cancelled','unknown'] as const;
type Outcome=typeof outcomes[number];
export type MigrationJournal=Omit<CharterMigrationJournalRecord,'identity'>&{identity:CharterIdentity};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const fresh=(identity:CharterIdentity):MigrationJournal=>({version:1,identity,revision:0,request:null,migrationId:null,migration:null,signingStarted:false,signed:null,observed:[]});
const holds=new WeakMap<object,Map<string,Set<Outcome>>>();
function compatible(before:CharterMigration,after:CharterMigration){
 for(const field of ['id','actor','request','snapshot','original'] as const)need(same(before[field],after[field]),'The saved migration terms changed.');
 for(const field of ['signing','wire','terminal'] as const)if(before[field])need(same(before[field],after[field]),'Original migration evidence changed.');
 const stages=['pending','issuing','prepared','signed','controlled','cancelled'];need(stages.indexOf(after.status)>=stages.indexOf(before.status),'Migration history cannot regress.');
}
/** One wallet journal with strict IndexedDB compare-and-swap. Persist the stable-clan request
 * before HTTP and the signing marker before the wallet can expose a signature. */
export class MigrationJournalStore{
 readonly identity:CharterIdentity;readonly key:string;private db:Promise<IDBDatabase>;private held:Set<Outcome>;
 constructor(identity:CharterIdentity,factory:IDBFactory|undefined=globalThis.indexedDB,name='pkw-charter-migration-v1'){
  this.identity=charterIdentity(identity);this.key=JSON.stringify(this.identity);const owner=factory??globalThis;let scopes=holds.get(owner);if(!scopes){scopes=new Map();holds.set(owner,scopes);}const scope=JSON.stringify([name,this.key]);this.held=scopes.get(scope)??new Set();scopes.set(scope,this.held);
  this.db=new Promise((resolve,reject)=>{if(!factory){reject(Error('Durable migration recovery is unavailable.'));return;}const q=factory.open(name,1);q.onupgradeneeded=()=>q.result.createObjectStore('commands');q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('Close older game tabs to recover migration.'));q.onsuccess=()=>{q.result.onversionchange=()=>q.result.close();resolve(q.result);};});void this.db.catch(()=>undefined);
 }
 private async raw():Promise<unknown>{const db=await this.db;return new Promise((resolve,reject)=>{const tx=db.transaction('commands'),q=tx.objectStore('commands').get(this.key);let value:unknown;q.onsuccess=()=>{value=q.result;};tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error);});}
 private async parse(raw:unknown):Promise<MigrationJournal>{
  if(raw===undefined)return fresh(this.identity);const v=Shape.parse(raw);need(same(charterIdentity(v.identity),this.identity),'Migration history belongs to another account.');
  need(new Set(v.observed).size===v.observed.length,'Duplicate migration outcome.');
  if(v.migration)need(v.migration.actor===this.identity.wallet&&v.migration.id===v.migrationId&&(!v.request||same(v.request,v.migration.request)),'The saved migration identity changed.');
  if(v.signingStarted)need(v.migration?.signing,'Signing lacks the original preparation.');
  if(v.signed){need(v.signingStarted&&v.migration?.signing,'A signature lacks its saved original.');await verifyCharterWire(v.migration.signing,v.signed);}
  if(v.migration?.wire){need(v.migration.signing,'A saved wire lacks its registration packet.');await verifyCharterWire(v.migration.signing,v.migration.wire);}
  return {...v,identity:this.identity};
 }
 private async write(captured:unknown,old:MigrationJournal,next:MigrationJournal){
  need(old.revision<Number.MAX_SAFE_INTEGER,'Migration history is full.');const parsed=await this.parse({...next,revision:old.revision+1}),db=await this.db;
  return new Promise<MigrationJournal>((resolve,reject)=>{const tx=db.transaction('commands','readwrite',{durability:'strict'}),s=tx.objectStore('commands'),q=s.get(this.key);let error:unknown;
   q.onsuccess=()=>{try{need(same(q.result,captured),'Another tab changed migration recovery.');s.put(parsed,this.key);}catch(e){error=e;tx.abort();}};
   tx.oncomplete=()=>resolve(parsed);tx.onabort=tx.onerror=()=>reject(error??tx.error??Error('Migration recovery did not save.'));});
 }
 private async update(fn:(old:MigrationJournal)=>MigrationJournal){const captured=await this.raw(),old=await this.parse(captured);return this.write(captured,old,fn(old));}
 async read(){const row=await this.parse(await this.raw());for(const tag of row.observed)this.held.add(tag);if([...this.held].some(tag=>!row.observed.includes(tag)))return this.update(j=>({...j,observed:[...new Set([...j.observed,...this.held])]}));return row;}
 begin(raw:CharterMigrationRequest){const request=CharterMigrationRequestSchema.parse(structuredClone(raw));return this.update(j=>{need(!j.request&&!j.migrationId||same(j.request,request),'Recover the saved migration before starting another.');return {...j,request};});}
 open(raw:string){const migrationId=Id.parse(raw);return this.update(j=>{need(!j.request&&!j.migrationId||j.migrationId===migrationId,'Recover the saved migration before opening another.');return {...j,migrationId};});}
 async retain(raw:unknown){
  const owned=structuredClone(raw),value=owned as Partial<CharterMigration>,row=await this.read();
  need(value.actor===this.identity.wallet&&Id.safeParse(value.id).success&&(row.migrationId?row.migrationId===value.id:row.request&&row.request.clanId===value.request?.clanId&&row.request.idempotencyKey===value.request?.idempotencyKey),'Migration response has no saved request.');
  // An observed terminal holds approval even if the remainder of its response
  // is malformed or the durable write fails. A later valid read resolves it.
  const tags:Outcome[]=[];
  if(value.status==='controlled'||value.status==='cancelled')tags.push(value.status);
  if(value.terminal?.outcome==='controlled'||value.terminal?.outcome==='cancelled')tags.push(value.terminal.outcome);
  else if(value.terminal!==undefined&&value.terminal!==null&&!tags.length)tags.push('unknown');
  if(tags.length){for(const tag of tags)this.held.add(tag);await this.update(j=>({...j,observed:[...new Set<Outcome>([...j.observed,...tags])]}));}
  const migration=CharterMigrationSchema.parse(owned);
  const saved=await this.update(j=>{if(j.migration)compatible(j.migration,migration);return {...j,migrationId:migration.id,migration,observed:migration.terminal?j.observed.filter(tag=>tag!=='unknown'):j.observed};});if(migration.terminal)this.held.delete('unknown');return saved;
 }
 beginSigning(messageSha256:string){return this.update(j=>{need(!j.signingStarted&&!j.observed.length&&!this.held.size&&j.migration?.signing?.packet.messageSha256===messageSha256&&!j.migration.terminal&&!j.migration.wire,'Recover the original signature or outcome first.');return {...j,signingStarted:true};});}
 async retainSigned(raw:CharterWire){const wire=CharterWireSchema.parse(structuredClone(raw)),j=await this.read();need(j.signingStarted&&j.migration?.signing,'Save the signing request first.');await verifyCharterWire(j.migration.signing,wire);return this.update(old=>{need(!old.signed||same(old.signed,wire),'The original signed transaction cannot change.');return {...old,signed:wire};});}
 async archives(){const db=await this.db,prefix=this.key+':archive:',rows=await new Promise<unknown[]>((resolve,reject)=>{const tx=db.transaction('commands'),q=tx.objectStore('commands').openCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'),'prev'),values:unknown[]=[];q.onsuccess=()=>{const cursor=q.result;if(cursor&&values.length<64){values.push(cursor.value);cursor.continue();}};tx.oncomplete=()=>resolve(values);tx.onabort=tx.onerror=()=>reject(tx.error);});return Promise.all(rows.map(row=>this.parse(row)));}
 async archive(){
  const captured=await this.raw(),old=await this.parse(captured),outcome=old.migration?.terminal?.outcome;
  need(outcome&&[...new Set([...old.observed,...this.held])].every(tag=>tag===outcome),'The original migration outcome is unresolved.');need(old.revision<Number.MAX_SAFE_INTEGER,'Migration history is full.');const next={...fresh(this.identity),revision:old.revision+1},db=await this.db;
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite',{durability:'strict'}),s=tx.objectStore('commands'),q=s.get(this.key);let error:unknown;q.onsuccess=()=>{try{need(same(q.result,captured),'Another tab changed migration recovery.');s.add(old,this.key+':archive:'+String(old.revision).padStart(16,'0'));s.put(next,this.key);}catch(e){error=e;tx.abort();}};tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(error??tx.error);});this.held.clear();return next;
 }
 async close(){(await this.db).close();}
}
