import * as A from '@shardkeep/shared/divineFragmentsApi';
import { matchDivineFragmentsProof, parseDivineFragmentsCommand, same, type DivineFragmentsCommand as Command, type DivineFragmentsJournal as Journal, type DivineFragmentsStore as Store } from './journal';
export type Guard=()=>void;
export interface DivineFragmentsPorts {
 get(path:string,guard:Guard):Promise<unknown>;
 original(command:Command,method:'GET'|'POST',guard:Guard,retain:(raw:unknown)=>Promise<void>):Promise<unknown>;
 capture(baseId?:string):Guard; lock<T>(name:string,run:()=>Promise<T>):Promise<T>; key():string;
}
export type FragmentReview={command:Command;quantity:string};
export type DivineFragmentsState={loaded:boolean;busy:boolean;journal:Journal|null;review:FragmentReview|null;error:string|null;
 awards:A.DivineFragmentAwardsPage|null;terms:A.DivineFragmentClaimablePage|null;termsCursor:string|null;stock:A.DivineFragmentStockView|null;policy:A.DivineFragmentPolicy|null};
export const emptyDivineFragmentsState:DivineFragmentsState={loaded:false,busy:false,journal:null,review:null,error:null,awards:null,terms:null,termsCursor:null,stock:null,policy:null};
/** All foreground work is read-only. A retry is explicit, retains the same key,
 * and first recovers its original receipt. No absence response proves failure. */
export class DivineFragmentsController {
 private state={...emptyDivineFragmentsState};private review:(FragmentReview&{guard:Guard})|null=null;
 private epoch=0;private running=false;private readonly listeners=new Set<()=>void>();
 constructor(readonly store:Store,private readonly ports:DivineFragmentsPorts){}
 snapshot=()=>this.state;subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 private publish(value:Partial<DivineFragmentsState>){this.state={...this.state,...value};this.listeners.forEach(fn=>fn());}
 dismiss(){this.epoch++;this.review=null;this.publish({review:null,stock:null,busy:false});}
 private async action(run:(guard:Guard)=>Promise<void>){if(this.running)return;this.running=true;let guard:Guard|undefined;
  try{const captured=this.ports.capture(),epoch=this.epoch;guard=()=>{captured();if(epoch!==this.epoch)throw Error('The fragment view changed. Check the saved receipt.');};
   guard();this.publish({busy:true,error:null});await this.ports.lock(`pkw-divine-fragments-v1:${this.store.key}`,async()=>{await this.read(guard!);await run(guard!);});
  }catch(error){this.review=null;try{guard?.();if(guard)this.publish({review:null,error:error instanceof Error?error.message:'Fragment recovery is incomplete.'});}catch{/* obsolete view; original transport still retains owned evidence */}}
  finally{this.running=false;try{guard?.();if(guard)this.publish({busy:false});}catch{/* obsolete session */}}}
 private async read(guard:Guard){guard();const journal=await this.store.read();guard();this.publish({loaded:true,journal});}
 private async write(update:(old:Journal)=>Journal,guard:Guard){guard();const journal=await this.store.compareAndSet(this.state.journal!.revision,update);guard();this.publish({journal});}
 private command(){const command=this.state.journal?.operation?.command;if(!command)throw Error('Choose a saved fragment request.');return command;}
 private async retain(command:Command,raw:unknown){const proof=matchDivineFragmentsProof(raw,this.store.identity,command),journal=await this.store.read();
  const key=command.consent.request.idempotencyKey,active=journal.operation?.command.consent.request.idempotencyKey===key;
  const index=journal.archives.findIndex(a=>a.operation.command.consent.request.idempotencyKey===key),op=active?journal.operation:journal.archives[index]?.operation;
  if(!op||!same(op.command,command))throw Error('Original fragment request changed.');
  if(!proof.receipt){if(op.proof)throw Error('An accepted fragment receipt disappeared.');return;}
  if(same(op.proof,proof))return;
  await this.store.compareAndSet(journal.revision,old=>active?{...old,operation:{...old.operation!,proof}}:{...old,archives:old.archives.map((a,i)=>i===index?{...a,operation:{...a.operation,proof}}:a)});
 }
 private async recover(command:Command,guard:Guard){guard();const retain=(raw:unknown)=>this.retain(command,raw),raw=await this.ports.original(command,'GET',guard,retain);await retain(raw);guard();await this.read(guard);return matchDivineFragmentsProof(raw,this.store.identity,command);}
 private async awards(cursor:string|null,guard:Guard){const raw=await this.ports.get('/divine-fragments/awards'+(cursor?`?cursor=${encodeURIComponent(cursor)}`:''),guard);guard();const awards=A.matchDivineFragmentAwardsPage(raw,this.store.identity.wallet,cursor);this.publish({awards});return awards;}
 private async terms(cursor:string|null,guard:Guard){const raw=await this.ports.get('/divine-fragments/seeker/terms'+(cursor?`?cursor=${encodeURIComponent(cursor)}`:''),guard);guard();const terms=A.matchDivineFragmentClaimablePage(raw,this.store.identity.wallet,cursor);this.publish({terms,termsCursor:cursor});return terms;}
 private async stock(baseId:string,guard:Guard){const raw=await this.ports.get(`/divine-fragments/stock/${encodeURIComponent(baseId)}`,guard);guard();const stock=A.DivineFragmentStockViewSchema.parse(raw);if(stock.wallet!==this.store.identity.wallet||stock.baseId!==baseId)throw Error('Fragment stock belongs to another kingdom.');this.publish({stock});return stock;}
 open(baseId?:string){return this.action(async guard=>{this.review=null;this.publish({review:null,stock:null});if(this.state.journal!.operation)await this.recover(this.command(),guard);
  const policy=A.DivineFragmentPolicySchema.parse(await this.ports.get('/divine-fragments/policy',guard));guard();this.publish({policy});await this.awards(null,guard);await this.terms(null,guard);if(baseId)await this.stock(baseId,guard);});}
 loadAwards(cursor:string|null=null){return this.action(guard=>this.awards(cursor,guard).then(()=>undefined));}
 loadTerms(cursor:string|null=null){return this.action(guard=>this.terms(cursor,guard).then(()=>undefined));}
 checkOriginal(){return this.action(async guard=>{this.review=null;this.publish({review:null});await this.recover(this.command(),guard);});}
 private async fresh(command:Command,guard:Guard):Promise<string>{const base=this.ports.capture(command.consent.request.baseId),check=()=>{guard();base();};check();await this.stock(command.consent.request.baseId,check);
  if(command.kind==='delivery'){const view=A.matchDivineFragmentEventView(await this.ports.get(`/divine-fragments/events/${command.consent.eventId}`,check),command.consent.wallet,command.consent.eventId);check();
   if(!same(view.award,command.consent.award)||view.delivery)throw Error('This original award is already delivered or its source changed. Check its event history.');return command.consent.award.net;}
  // Discovery cursors are not authority: arbitrarily many newly retained terms
  // may sort before an old original. Read its exact permanent term directly.
  const termId=command.consent.request.termId;
  const raw=await this.ports.get(`/divine-fragments/seeker/terms/${termId}`,check);check();
  const terms=A.matchDivineFragmentClaimablePage(raw,this.store.identity.wallet);
  if(terms.nextCursor!==null||terms.rows.some(row=>row.termId!==termId))throw Error('Exact fragment term response changed its original identity.');
  const row=terms.rows.find(r=>r.spotId===command.consent.request.spotId);
  if(!row||row.termHash!==command.termHash||BigInt(row.claimable)<=0n)throw Error('No unpaid fragment share remains for this original spot.');return row.claimable;
 }
 private async reviewCommandInner(command:Command,guard:Guard){const base=this.ports.capture(command.consent.request.baseId),check=()=>{guard();base();};const quantity=await this.fresh(command,check);check();this.review={command,quantity,guard:check};this.publish({review:{command,quantity}});}
 beginDelivery(baseId:string,award:A.DivineFragmentAward){return this.begin({kind:'delivery',consent:{version:1,wallet:this.store.identity.wallet,eventId:award.eventId,award,request:{idempotencyKey:this.ports.key(),baseId}}});}
 beginClaim(baseId:string,row:A.DivineFragmentSeekerEntitlement,browseCursor:string|null){return this.begin({kind:'claim',consent:{version:1,wallet:this.store.identity.wallet,request:{idempotencyKey:this.ports.key(),baseId,termId:row.termId,spotId:row.spotId}},termHash:row.termHash,browseCursor});}
 private begin(raw:Command){return this.action(async guard=>{this.review=null;this.publish({review:null});if(this.state.journal!.operation)throw Error('Finish the saved fragment request first.');
  const command=parseDivineFragmentsCommand(raw);if(command.consent.wallet!==this.store.identity.wallet)throw Error('Foreign fragment request.');const base=this.ports.capture(command.consent.request.baseId),check=()=>{guard();base();};
  await this.fresh(command,check);await this.write(old=>({...old,operation:{command,attemptRevision:null,proof:null}}),check);await this.reviewCommandInner(command,check);});}
 reviewOriginal(){return this.action(async guard=>{this.review=null;this.publish({review:null});const command=this.command();if((await this.recover(command,guard)).receipt)return;await this.reviewCommandInner(command,guard);});}
 confirm(){return this.action(async guard=>{const review=this.review,command=this.command();if((await this.recover(command,guard)).receipt){this.review=null;this.publish({review:null});return;}
  if(!review||!same(review.command,command))throw Error('Review this saved fragment request first.');const check=()=>{guard();review.guard();};check();const quantity=await this.fresh(command,check);check();if(quantity!==review.quantity)throw Error('The cumulative share changed. Review the original request again.');
  await this.write(old=>({...old,operation:{...old.operation!,attemptRevision:old.revision+1}}),check);this.review=null;this.publish({review:null});check();
  const retain=(raw:unknown)=>this.retain(command,raw),raw=await this.ports.original(command,'POST',check,retain);await retain(raw);check();await this.read(check);this.publish({stock:null});
 });}
 archive(){return this.action(async guard=>{this.review=null;this.publish({review:null});const proof=await this.recover(this.command(),guard),op=this.state.journal!.operation!;if(!proof.receipt&&op.attemptRevision!==null)throw Error('Outcome unknown. Keep the original request and check or explicitly retry the same key.');
  await this.write(old=>({...old,operation:null,archives:[...old.archives,{operation:old.operation!,reason:proof.receipt?'accepted':'unattempted',evidence:proof.receipt?null:proof}]}),guard);});}
 checkArchived(key:string){return this.action(async guard=>{const row=this.state.journal!.archives.find(a=>a.operation.command.consent.request.idempotencyKey===key);if(!row)throw Error('Choose an original history record.');await this.recover(row.operation.command,guard);});}
}
