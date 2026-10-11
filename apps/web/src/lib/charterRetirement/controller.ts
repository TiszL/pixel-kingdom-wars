import {Buffer} from 'buffer';
import {CharterRetirementRequestSchema,type CharterRetirementDraft,type CharterRetirementOperation,type CharterRetirementRequest,type CharterRetirementWire} from '@shardkeep/shared/charterRetirementApi';
import {RetirementJournalStore,type RetirementJournal} from './journal';
import type {RetirementRequest,RetirementAction} from './transport';
export interface RetirementPorts{
 capture(newAction:boolean):()=>void;key():string;lock<T>(key:string,run:()=>Promise<T>):Promise<T>;
 request(request:RetirementRequest,guard:()=>void,retain:(raw:unknown)=>Promise<void>):Promise<CharterRetirementDraft|null>;
 review(operation:CharterRetirementOperation,guard:()=>void):Promise<void>;
 sign(operation:CharterRetirementOperation,guard:()=>void):Promise<CharterRetirementWire>;
}
export type RetirementState={loaded:boolean;busy:boolean;journal:RetirementJournal|null;history:RetirementJournal[];reviewedMessage:string|null;error:string|null};
const initial=():RetirementState=>({loaded:false,busy:false,journal:null,history:[],reviewedMessage:null,error:null});
export class RetirementController{
 private state=initial();private listeners=new Set<()=>void>();private pending:Promise<unknown>|null=null;
 constructor(readonly store:RetirementJournalStore,private ports:RetirementPorts){}
 getSnapshot=():RetirementState=>this.state;subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};
 private set(patch:Partial<RetirementState>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}
 dismiss(){this.set({reviewedMessage:null});}async idle(){await this.pending?.catch(()=>undefined);}
 private run<T>(newAction:boolean,work:(guard:()=>void)=>Promise<T>):Promise<T>{
  if(this.pending)return Promise.reject(Error('A dissolution action is already running.'));
  const task=(async()=>{this.set({busy:true,error:null});try{const guard=this.ports.capture(newAction);return await this.ports.lock(this.store.key,async()=>{guard();this.set({journal:await this.store.read(),loaded:true});return work(guard);});}
   catch(e){this.set({error:e instanceof Error?e.message:'Dissolution is unavailable.',reviewedMessage:null});throw e;}
   finally{try{this.set({journal:await this.store.read(),loaded:true});}catch(e){this.set({error:e instanceof Error?e.message:'Saved dissolution is unavailable.'});}this.set({busy:false});}})();
  this.pending=task;void task.finally(()=>{if(this.pending===task)this.pending=null;}).catch(()=>undefined);return task;
 }
 private async request(r:RetirementRequest,guard:()=>void){guard();return this.ports.request(r,guard,async raw=>{await this.store.retain(raw);});}
 private async lookup(guard:()=>void){const j=await this.store.read();if(j.draftId)return this.request({key:j.draftId,action:'read'},guard);if(j.request)return this.request({key:j.request.idempotencyKey,action:'by-key'},guard);return null;}
 load(){return this.run(false,async guard=>{this.set({history:await this.store.archives()});await this.lookup(guard);guard();});}
 begin(raw:CharterRetirementRequest){const request=CharterRetirementRequestSchema.parse(structuredClone(raw));return this.run(true,async guard=>{await this.store.begin(request);await this.request({key:null,action:'create',body:request},guard);guard();});}
 open(key:string){return this.run(false,async guard=>{await this.store.open(key);await this.lookup(guard);guard();});}
 retryOriginal(){return this.run(true,async guard=>{const j=await this.store.read();if(!j.request||j.draftId||j.signingStarted||j.observed.length)throw Error('Check the saved dissolution instead.');await this.request({key:null,action:'create',body:j.request},guard);guard();});}
 command(action:Exclude<RetirementAction,'create'|'read'|'by-key'|'signed'|'deliver'>){return this.run(!['recover','recover-preparation','cancel'].includes(action),async guard=>{const j=await this.store.read();if(!j.draftId)throw Error('Recover the original dissolution ID first.');if(['prepare','pay-members'].includes(action)&&(j.observed.length||j.draft?.cancelled||j.draft?.operation?.terminal||j.signingStarted||j.draft?.operation?.signed))throw Error('Recover the original dissolution outcome first.');await this.request({key:j.draftId,action,body:{}},guard);guard();this.dismiss();});}
 review(){return this.run(true,async guard=>{const j=await this.store.read(),op=j.draft?.operation;if(!op?.preparation||op.terminal||op.signed||j.signingStarted||j.observed.length)throw Error('Original approval is unavailable.');await this.ports.review(op,guard);guard();this.set({reviewedMessage:op.preparation.packet.messageSha256});});}
 sign(){return this.run(true,async guard=>{
  const j=await this.store.read(),op=j.draft?.operation;if(!j.draftId||!op?.preparation||j.signingStarted||this.state.reviewedMessage!==op.preparation.packet.messageSha256)throw Error('Review this original dissolution before approving.');
  await this.store.beginSigning(op.preparation.packet.messageSha256);guard();const wire=await this.ports.sign(op,guard);
  // Retain valid late signatures even after navigation or account invalidation.
  await this.store.retainSigned(wire);guard();await this.request({key:j.draftId,action:'signed',body:{signedTransaction:Buffer.from(wire.signedTransactionHex,'hex').toString('base64')}},guard);guard();this.dismiss();
 });}
 deliver(){return this.run(true,async guard=>{let j=await this.store.read();if(!j.draftId||j.observed.length||j.draft?.cancelled||j.draft?.operation?.terminal)throw Error('Recover the original outcome instead.');
  if(j.signed&&!j.draft?.operation?.signed){await this.request({key:j.draftId,action:'signed',body:{signedTransaction:Buffer.from(j.signed.signedTransactionHex,'hex').toString('base64')}},guard);guard();j=await this.store.read();}
  if(!j.draft?.operation?.signed)throw Error('The original signature is unresolved.');await this.request({key:j.draftId,action:'deliver',body:{}},guard);guard();
 });}
 archive(){return this.run(false,async guard=>{guard();await this.store.archive();this.set({history:await this.store.archives()});this.dismiss();});}
}
