import { matchSeekerResourceEntitlementView, type SeekerResourceClaimRequest, type SeekerResourceEntitlementView } from '@shardkeep/shared/seekerResourceClaimsApi';
import { matchSeekerResourceClaimsProof, parseSeekerResourceClaimsCommand, same, type SeekerResourceClaimsCommand, type SeekerResourceClaimsJournal, type SeekerResourceClaimsProof, type SeekerResourceClaimsStore } from './journal';
type Guard=()=>void;
export interface SeekerResourceClaimsPorts {
 get(path:string,guard:Guard):Promise<unknown>;
 getProof(request:SeekerResourceClaimRequest,guard:Guard,retain:(raw:unknown)=>Promise<void>):Promise<unknown>;
 post(request:SeekerResourceClaimRequest,guard:Guard,retain:(raw:unknown)=>Promise<void>):Promise<unknown>;
 capture(baseId?:string):Guard; lock<T>(name:string,run:()=>Promise<T>):Promise<T>; key():string;
}
export type SeekerResourceEntitlementRow=SeekerResourceEntitlementView['rows'][number];
export type SeekerResourceClaimsReview={command:SeekerResourceClaimsCommand;row:SeekerResourceEntitlementRow};
export type SeekerResourceClaimsState={loaded:boolean;busy:boolean;journal:SeekerResourceClaimsJournal|null;view:SeekerResourceEntitlementView|null;review:SeekerResourceClaimsReview|null;error:string|null};
export const emptySeekerResourceClaimsState:SeekerResourceClaimsState={loaded:false,busy:false,journal:null,view:null,review:null,error:null};
type Review=SeekerResourceClaimsReview&{guard:Guard};
function admit(view:SeekerResourceEntitlementView,command:SeekerResourceClaimsCommand):SeekerResourceEntitlementRow {
 if (!view.claimsEnabled||view.status!=='available')throw Error('New resource claims are unavailable. Saved receipts remain recoverable.');
 const row=view.rows.find(r=>r.termId===command.request.termId&&r.spotId===command.request.spotId&&r.resourceId===command.request.resourceId);
 if(!row||row.termHash!==command.termHash||BigInt(row.dueQuantity)<=0n)throw Error('The original resource share is unavailable. Refresh the earned rights.');
 return row;
}
export async function seekerResourceClaimsLock<T>(name:string,run:()=>Promise<T>):Promise<T>{
 if(!navigator.locks?.request)throw Error('Update your browser to coordinate resource claims across tabs.');
 return navigator.locks.request(name,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('Another tab is handling these resource claims.');return run();});
}
/** Each saved original has one explicit POST; ambiguity permits only receipt GETs. */
export class SeekerResourceClaimsController {
 private state:SeekerResourceClaimsState={...emptySeekerResourceClaimsState}; private review:Review|null=null;
 private publicationGuard:Guard|null=null;private running=false;private epoch=0;private readonly listeners=new Set<()=>void>();
 constructor(readonly store:SeekerResourceClaimsStore,private readonly ports:SeekerResourceClaimsPorts){}
 snapshot=()=>this.state;subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 private publish(value:Partial<SeekerResourceClaimsState>){this.state={...this.state,...value};this.listeners.forEach(fn=>fn());}
 private clearReview(){this.review=null;this.publish({review:null});}
 dismiss(){this.epoch++;this.clearReview();}
 private command(){const c=this.state.journal?.operation?.command;if(!c)throw Error('There is no saved resource claim.');return c;}
 private async action(run:(guard:Guard)=>Promise<void>){
  if(this.running)return;this.running=true;this.publicationGuard=null;
  try{const captured=this.ports.capture(),epoch=this.epoch;const guard=()=>{captured();if(epoch!==this.epoch)throw Error('The resource claims view changed.');};
   guard();this.publicationGuard=guard;this.publish({busy:true,error:null});
   await this.ports.lock(`pkw-seeker-resource-claims-v1:${this.store.key}`,async()=>{await this.read(guard);await run(guard);});
  }catch(error){this.review=null;try{this.publicationGuard?.();if(this.publicationGuard)this.publish({review:null,error:error instanceof Error?error.message:'Resource claim recovery is incomplete.'});}catch{/* obsolete session */}}
  finally{this.running=false;try{this.publicationGuard?.();if(this.publicationGuard)this.publish({busy:false});}catch{/* obsolete view */}this.publicationGuard=null;}
 }
 private async read(guard:Guard){guard();const journal=await this.store.read();guard();this.publicationGuard?.();this.publish({loaded:true,journal});}
 private async write(update:(old:SeekerResourceClaimsJournal)=>SeekerResourceClaimsJournal,guard:Guard){guard();if(!this.state.journal)throw Error('Read saved claims first.');const journal=await this.store.compareAndSet(this.state.journal.revision,update);guard();this.publish({journal});}
 private async retain(command:SeekerResourceClaimsCommand,raw:unknown){
  const proof=matchSeekerResourceClaimsProof(raw,this.store.identity,command),journal=await this.store.read();
  const key=command.request.idempotencyKey,active=journal.operation?.command.request.idempotencyKey===key;
  const index=journal.archives.findIndex(r=>r.operation.command.request.idempotencyKey===key),operation=active?journal.operation:journal.archives[index]?.operation;
  if(!operation||!same(operation.command,command))throw Error('The original resource claim changed during recovery.');
  if(!proof.receipt){if(operation.proof)throw Error('The accepted original resource receipt is missing.');return;}
  if(same(operation.proof,proof))return;
  await this.store.compareAndSet(journal.revision,old=>active?{...old,operation:{...old.operation!,proof}}:{...old,archives:old.archives.map((r,i)=>i===index?{...r,operation:{...r.operation,proof}}:r)});
 }
 private async recover(command:SeekerResourceClaimsCommand,guard:Guard):Promise<SeekerResourceClaimsProof>{
  guard();const retain=(raw:unknown)=>this.retain(command,raw);const raw=await this.ports.getProof(command.request,guard,retain);await retain(raw);guard();await this.read(guard);return matchSeekerResourceClaimsProof(raw,this.store.identity,command);
 }
 private async page(cursor:string|null,guard:Guard){
  const path='/seeker/resource-claims'+(cursor?`?cursor=${encodeURIComponent(cursor)}`:'');guard();const raw=await this.ports.get(path,guard);guard();
  const view=matchSeekerResourceEntitlementView(raw,this.store.identity.wallet,cursor);this.publish({view});return view;
 }
 private baseGuard(baseId:string,guard:Guard){const base=this.ports.capture(baseId),current=()=>{guard();base();};this.publicationGuard=current;return current;}
 open(){return this.action(async guard=>{this.clearReview();if(this.state.journal!.operation)await this.recover(this.command(),guard);await this.page(null,guard);});}
 loadPage(cursor:string|null=null){return this.action(async guard=>{this.clearReview();await this.page(cursor,guard);});}
 checkOriginal(){return this.action(async guard=>{this.clearReview();await this.recover(this.command(),guard);});}
 beginClaim(baseId:string,row:SeekerResourceEntitlementRow){return this.action(async guard=>{
  this.clearReview();if(this.state.journal!.operation)throw Error('Recover the saved resource claim before starting another.');
  const current=this.baseGuard(baseId,guard),browseCursor=this.state.view?.cursor??null,view=await this.page(browseCursor,current);
  const command=parseSeekerResourceClaimsCommand({request:{idempotencyKey:this.ports.key(),baseId,termId:row.termId,spotId:row.spotId,resourceId:row.resourceId},termHash:row.termHash,browseCursor});
  const fresh=admit(view,command);await this.write(old=>({...old,operation:{command,attemptRevision:null,proof:null}}),current);
  this.review={command,row:fresh,guard:current};this.publish({review:{command,row:fresh}});
 });}
 reviewCommand(){return this.action(async guard=>{
  this.clearReview();const command=this.command();if((await this.recover(command,guard)).receipt)return;
  if(this.state.journal!.operation!.attemptRevision!==null)throw Error('The original claim was attempted. Check its receipt; do not send a new claim.');
  const current=this.baseGuard(command.request.baseId,guard),view=await this.page(command.browseCursor,current),row=admit(view,command);
  this.review={command,row,guard:current};this.publish({review:{command,row}});
 });}
 confirm(){return this.action(async guard=>{
  const review=this.review,command=this.command();if((await this.recover(command,guard)).receipt){this.clearReview();return;}
  if(this.state.journal!.operation!.attemptRevision!==null)throw Error('The original claim was attempted. Check its receipt; do not send a new claim.');
  if(!review)throw Error('Review the saved resource claim before confirming.');
  const current=this.baseGuard(command.request.baseId,guard),check=()=>{current();review.guard();if(!same(review.command,this.command()))throw Error('Review the original claim again.');};
  check();const view=await this.page(command.browseCursor,current),row=admit(view,command);check();
  if(!same(row,review.row))throw Error('The available resource share changed. Review the original request again.');
  await this.write(old=>({...old,operation:{...old.operation!,attemptRevision:old.revision+1}}),check);
  this.clearReview();check();const retain=(raw:unknown)=>this.retain(command,raw);const raw=await this.ports.post(command.request,check,retain);await retain(raw);check();await this.read(check);
 });}
 checkArchived(key:string){return this.action(async guard=>{this.clearReview();const row=this.state.journal!.archives.find(r=>r.operation.command.request.idempotencyKey===key);if(!row)throw Error('Choose a saved resource receipt.');await this.recover(row.operation.command,guard);});}
 finish(hydrate:(guard:Guard)=>Promise<void>){return this.action(async guard=>{
  this.clearReview();if(!(await this.recover(this.command(),guard)).receipt)throw Error('Keep the original claim until its receipt is recovered.');
  await hydrate(guard);guard();await this.write(old=>({...old,operation:null,archives:[...old.archives,{operation:old.operation!,reason:'accepted',evidence:null}]}),guard);
 });}
 abandonDraft(){return this.action(async guard=>{
  this.clearReview();const command=this.command();if(this.state.journal!.operation!.attemptRevision!==null)throw Error('An attempted resource claim must stay in recovery.');
  const evidence=await this.recover(command,guard);if(evidence.receipt)throw Error('The original claim succeeded. Keep its receipt.');
  await this.write(old=>({...old,operation:null,archives:[...old.archives,{operation:old.operation!,reason:'unattempted',evidence}]}),guard);
 });}
}
