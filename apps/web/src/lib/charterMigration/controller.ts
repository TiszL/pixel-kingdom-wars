import {CharterMigrationRequestSchema,type CharterMigration,type CharterMigrationRequest} from '@shardkeep/shared/charterMigrationApi';
import type {CharterWire} from '@shardkeep/shared/charterApi';
import {MigrationJournalStore,type MigrationJournal} from './journal';
import type {MigrationRequest,MigrationAction} from './transport';
export interface MigrationPorts{
 capture(newAction:boolean):()=>void;key():string;lock<T>(key:string,run:()=>Promise<T>):Promise<T>;
 request(request:MigrationRequest,guard:()=>void,retain:(raw:unknown)=>Promise<void>):Promise<CharterMigration|null>;
 review(operation:CharterMigration,guard:()=>void):Promise<void>;
 sign(operation:CharterMigration,guard:()=>void):Promise<CharterWire>;
}
export type MigrationState={loaded:boolean;busy:boolean;journal:MigrationJournal|null;history:MigrationJournal[];reviewedMessage:string|null;error:string|null};
const initial=():MigrationState=>({loaded:false,busy:false,journal:null,history:[],reviewedMessage:null,error:null});
export class MigrationController{
 private state=initial();private listeners=new Set<()=>void>();private pending:Promise<unknown>|null=null;
 constructor(readonly store:MigrationJournalStore,private ports:MigrationPorts){}
 getSnapshot=():MigrationState=>this.state;subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};
 private set(patch:Partial<MigrationState>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}
 dismiss(){this.set({reviewedMessage:null});}async idle(){await this.pending?.catch(()=>undefined);}
 private run<T>(newAction:boolean,work:(guard:()=>void)=>Promise<T>):Promise<T>{
  if(this.pending)return Promise.reject(Error('A migration action is already running.'));
  const task=(async()=>{this.set({busy:true,error:null});try{const guard=this.ports.capture(newAction);return await this.ports.lock(this.store.key,async()=>{guard();this.set({journal:await this.store.read(),loaded:true});return work(guard);});}
   catch(e){this.set({error:e instanceof Error?e.message:'Migration is unavailable.',reviewedMessage:null});throw e;}
   finally{try{this.set({journal:await this.store.read(),loaded:true});}catch(e){this.set({error:e instanceof Error?e.message:'Saved migration is unavailable.'});}this.set({busy:false});}})();
  this.pending=task;void task.finally(()=>{if(this.pending===task)this.pending=null;}).catch(()=>undefined);return task;
 }
 private async request(r:MigrationRequest,guard:()=>void){guard();return this.ports.request(r,guard,async raw=>{await this.store.retain(raw);});}
 private async lookup(guard:()=>void){const j=await this.store.read();if(j.migrationId)return this.request({key:j.migrationId,action:'read'},guard);if(j.request)return this.request({key:j.request.idempotencyKey,action:'by-key'},guard);return null;}
 load(){return this.run(false,async guard=>{this.set({history:await this.store.archives()});await this.lookup(guard);guard();});}
 begin(raw:CharterMigrationRequest){const request=CharterMigrationRequestSchema.parse(structuredClone(raw));return this.run(true,async guard=>{await this.store.begin(request);await this.request({key:null,action:'create',body:request},guard);guard();});}
 open(key:string){return this.run(false,async guard=>{await this.store.open(key);await this.lookup(guard);guard();});}
 retryOriginal(){return this.run(true,async guard=>{const j=await this.store.read();if(!j.request||j.migrationId||j.signingStarted||j.observed.length)throw Error('Check the saved migration instead.');await this.request({key:null,action:'create',body:j.request},guard);guard();});}
 command(action:Exclude<MigrationAction,'create'|'read'|'by-key'|'signed'|'deliver'>){return this.run(!['recover','recover-preparation','cancel'].includes(action),async guard=>{const j=await this.store.read();if(!j.migrationId)throw Error('Recover the original migration ID first.');if(action==='prepare'&&(j.observed.length||j.migration?.terminal||j.signingStarted||j.migration?.wire))throw Error('Recover the original migration outcome first.');await this.request({key:j.migrationId,action,body:{}},guard);guard();this.dismiss();});}
 review(){return this.run(true,async guard=>{const j=await this.store.read(),op=j.migration;if(!op?.signing||op.terminal||op.wire||j.signingStarted||j.observed.length)throw Error('Original approval is unavailable.');await this.ports.review(op,guard);guard();this.set({reviewedMessage:op.signing.packet.messageSha256});});}
 sign(){return this.run(true,async guard=>{
  const j=await this.store.read(),op=j.migration;if(!j.migrationId||!op?.signing||j.signingStarted||this.state.reviewedMessage!==op.signing.packet.messageSha256)throw Error('Review this original migration before approving.');
  await this.store.beginSigning(op.signing.packet.messageSha256);guard();const wire=await this.ports.sign(op,guard);
  // Retain valid late signatures even after navigation or account invalidation.
  await this.store.retainSigned(wire);guard();await this.request({key:j.migrationId,action:'signed',body:{signedTransaction:wire.signedTransaction}},guard);guard();this.dismiss();
 });}
 deliver(){return this.run(true,async guard=>{let j=await this.store.read();if(!j.migrationId||j.observed.length||j.migration?.terminal)throw Error('Recover the original outcome instead.');
  if(j.signed&&!j.migration?.wire){await this.request({key:j.migrationId,action:'signed',body:{signedTransaction:j.signed.signedTransaction}},guard);guard();j=await this.store.read();}
  if(!j.migration?.wire)throw Error('The original signature is unresolved.');await this.request({key:j.migrationId,action:'deliver',body:{}},guard);guard();
 });}
 archive(){return this.run(false,async guard=>{guard();await this.store.archive();this.set({history:await this.store.archives()});this.dismiss();});}
}
