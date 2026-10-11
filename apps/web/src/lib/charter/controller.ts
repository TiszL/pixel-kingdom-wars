import type {CharterClient,CharterActivity,CharterCreationRequest,CharterSaleDraft,CharterSaleAcceptance} from '@shardkeep/shared/charterApi';
import {CharterCreationRequestSchema,CharterSaleDraftSchema,CharterSaleAcceptanceSchema,CharterRefundRequestSchema} from '@shardkeep/shared/charterApi';
import {CharterJournalStore,type CharterJournal,type CharterOperation} from './journal';
import type {CharterAction,CharterKind,CharterRequest} from './transport';
import type {SignedCharter} from './signing';
export interface CharterPorts{
 capture(newAction:boolean):()=>void;key():string;lock<T>(key:string,run:()=>Promise<T>):Promise<T>;
 activity(guard:()=>void,cursor?:string):Promise<CharterActivity>;
 request(request:CharterRequest,guard:()=>void,retain:(raw:unknown)=>Promise<void>):Promise<CharterClient|null>;
 review(original:CharterClient,guard:()=>void):Promise<void>;
 sign(original:CharterClient,guard:()=>void):Promise<SignedCharter>;
}
export type CharterState={loaded:boolean;busy:boolean;journal:CharterJournal|null;activity:CharterActivity|null;reviewedMessage:string|null;error:string|null};
const initial=():CharterState=>({loaded:false,busy:false,journal:null,activity:null,reviewedMessage:null,error:null});
export class CharterController{
 private state=initial();private listeners=new Set<()=>void>();private pending:Promise<unknown>|null=null;
 constructor(readonly store:CharterJournalStore,private ports:CharterPorts){}
 getSnapshot=():CharterState=>this.state;subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};private set(patch:Partial<CharterState>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}
 async idle():Promise<void>{await this.pending?.catch(()=>undefined);}
 dismiss(){this.set({reviewedMessage:null});}
 private run<T>(newAction:boolean,work:(guard:()=>void)=>Promise<T>):Promise<T>{if(this.pending)return Promise.reject(Error('A Charter action is already running.'));const task=(async()=>{this.set({busy:true,error:null});try{const guard=this.ports.capture(newAction);return await this.ports.lock(this.store.key,async()=>{guard();const j=await this.store.read();this.set({journal:j,loaded:true});return work(guard);});}catch(e){this.set({error:e instanceof Error?e.message:'Charter action unavailable.',reviewedMessage:null});throw e;}finally{try{this.set({journal:await this.store.read(),loaded:true});}catch(e){this.set({error:e instanceof Error?e.message:'Cannot read saved Charter.'});}this.set({busy:false});}})();this.pending=task;void task.finally(()=>{if(this.pending===task)this.pending=null;}).catch(()=>undefined);return task;}
 private async op():Promise<CharterOperation>{const op=(await this.store.read()).operation;if(!op)throw Error('No saved Charter original.');return op;}
 private async request(r:CharterRequest,guard:()=>void):Promise<CharterClient|null>{const row=await this.store.read();if(!row.operation)throw Error('Save the original Charter first.');await this.store.change(row.revision,{actions:[...new Set([...row.operation.actions,r.action])]});guard();return this.ports.request(r,guard,async raw=>{await this.store.retain(raw);});}
 load(){return this.run(false,async guard=>{const activity=await this.ports.activity(guard);guard();this.set({activity});});}
 refreshActivity(cursor?:string){return this.run(false,async guard=>{const activity=await this.ports.activity(guard,cursor);guard();this.set({activity});});}
 create(value:CharterCreationRequest){const owned=structuredClone(value);return this.run(true,async guard=>{const request=CharterCreationRequestSchema.parse(owned);await this.store.begin({kind:'creation',key:request.creationIntentId,request});await this.request({kind:'creation',key:null,action:'create',body:request},guard);guard();});}
 createSale(value:CharterSaleDraft){const owned=structuredClone(value);return this.run(true,async guard=>{const request=CharterSaleDraftSchema.parse(owned);await this.store.begin({kind:'sale',key:request.idempotencyKey,request});await this.request({kind:'sale',key:null,action:'create',body:request},guard);guard();});}
 open(kind:CharterKind,key:string){return this.run(false,async guard=>{await this.store.begin({kind,key,request:null});await this.request({kind,key,action:'read'},guard);guard();});}
 private async lookup(guard:()=>void){const op=await this.op(),c=op.command;return this.request({kind:c.kind,key:op.original?.key??c.key,action:c.kind==='sale'&&c.request&&!op.original?'by-key':'read'},guard);}
 check(){return this.run(false,async guard=>{await this.lookup(guard);guard();});}
 retryOriginal(){return this.run(true,async guard=>{const op=await this.op();if(op.original||!op.command.request||op.signingStarted)throw Error('Check the saved original instead.');await this.request({kind:op.command.kind,key:null,action:'create',body:op.command.request},guard);guard();});}
 command(action:Exclude<CharterAction,'signed'|'signature'|'deliver'>,body:unknown={}){const raw=structuredClone(body);return this.run(!['recover','recover-preparation','refund','cancel'].includes(action),async guard=>{const owned=action==='accept'?CharterSaleAcceptanceSchema.parse(raw):action==='refund'?CharterRefundRequestSchema.parse(raw):raw;const op=await this.op();if(!op.original)throw Error('Recover the original ID first.');await this.request({kind:op.command.kind,key:op.original.key,action,body:owned},guard);guard();this.dismiss();});}
 accept(value:CharterSaleAcceptance){return this.command('accept',value);}
 review(){return this.run(true,async guard=>{const op=await this.op();if(!op.original?.signing||op.signingStarted||op.observed.length||op.original.state.terminal)throw Error('Original signing is unavailable.');await this.ports.review(op.original,guard);guard();this.set({reviewedMessage:op.original.signing.packet.messageSha256});});}
 sign(){return this.run(true,async guard=>{const row=await this.store.read(),op=row.operation;if(!op?.original?.signing||op.signingStarted||this.state.reviewedMessage!==op.original.signing.packet.messageSha256)throw Error('Review the original Charter before approving.');await this.store.change(row.revision,{signingStarted:true});guard();const signed=await this.ports.sign(op.original,guard);const current=await this.store.read();await this.store.change(current.revision,{signed});this.dismiss();guard();});}
 upload(){return this.run(false,async guard=>{const op=await this.op();if(!op.original||!op.signed)throw Error('No retained wallet approval.');const signed=op.signed;await this.request({kind:op.command.kind,key:op.original.key,action:signed.kind==='creation'?'signed':'signature',body:signed.kind==='creation'?{signedTransaction:signed.wire.signedTransaction}:{attemptId:signed.contribution.attemptId,messageSha256:signed.contribution.messageSha256,signature:signed.contribution.signature}},guard);guard();});}
 deliver(){return this.run(true,async guard=>{const op=await this.op();if(!op.original?.wire||op.original.state.terminal||op.observed.length)throw Error('Both approvals and the saved full wire are required.');await this.request({kind:op.command.kind,key:op.original.key,action:'deliver',body:{}},guard);guard();});}
 archive(){return this.run(false,async guard=>{await this.lookup(guard);guard();await this.store.archive();this.dismiss();});}
}
