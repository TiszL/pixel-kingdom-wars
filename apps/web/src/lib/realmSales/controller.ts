import {Buffer} from 'buffer';
import {RealmSalePreparationSchema,RealmSalePreparationEnvelopeSchema,RealmSalePrepareRequestSchema,RealmSaleSignedWireSchema,type RealmSalePreparationView,type RealmSalePrepareRequest} from '@shardkeep/shared/realmSalesApi';
import {validateRealmSaleReview} from '@shardkeep/shared/realmSaleReviewApi';
import {RealmSaleSettlementSchema,type RealmSaleSettlementView} from '@shardkeep/shared/realmSaleSettlementApi';
import {verifyRealmSaleSettlement} from './settlement';
import {RealmSaleFailureSchema,RealmSaleFailureEnvelopeSchema} from '@shardkeep/shared/realmSaleFailureApi';
import {verifySignedRealmSale,type SignedRealmSale} from './signing';
import {parseRealmSalePrepareRefusal,type RealmSalePrepareRefusal} from './refusal';
import type {RealmSaleJournal,RealmSaleStore,RealmSaleOperation} from './journal';
type Guard=()=>void;
type Retain=(raw:unknown)=>Promise<void>;
type Review=ReturnType<typeof validateRealmSaleReview>;
export interface RealmSalePorts{
 capture(newAction:boolean):Guard;lock<T>(name:string,run:()=>Promise<T>):Promise<T>;key():string;clock():number;
 prepare(request:RealmSalePrepareRequest,guard:Guard,retain:Retain,refusal:(value:RealmSalePrepareRefusal)=>Promise<void>):Promise<unknown>;
 getPreparation(request:RealmSalePrepareRequest,guard:Guard,retain:Retain):Promise<unknown>;
 getSaved(idempotencyKey:string,guard:Guard,retain:Retain):Promise<unknown>;
 getFailure(idempotencyKey:string,guard:Guard,retain:Retain):Promise<unknown>;
 currentReview(preparation:RealmSalePreparationView,guard:Guard):Promise<unknown>;
 sign(preparation:RealmSalePreparationView,guard:Guard):Promise<SignedRealmSale>;
 submit(request:{idempotencyKey:string;signedTransaction:string},guard:Guard,retain:Retain):Promise<unknown>;
}
export interface RealmSaleState{loaded:boolean;busy:boolean;journal:RealmSaleJournal|null;review:{preparation:RealmSalePreparationView;current:Review}|null;settlementHeld:boolean;error:string|null}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function object(raw:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{need(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid saved realm purchase response.');const keys=Reflect.ownKeys(raw);need(keys.every(k=>typeof k==='string'&&[...required,...optional].includes(k))&&required.every(k=>Object.hasOwn(raw,k)),'Invalid saved realm purchase fields.');return raw as Record<string,unknown>;}
/** One original prepare, wallet approval and submit attempt. Only a bound
 * owner-attested settlement, or separately recovered definite unsigned refusal,
 * permits atomic archival of the complete original. */
export class RealmSaleController{
 private state:RealmSaleState=freeze({loaded:false,busy:false,journal:null,review:null,settlementHeld:false,error:null});
 private reviewed:{preparation:RealmSalePreparationView;current:Review;started:number;guard:Guard}|null=null;
 private running=false;private epoch=0;private held=false;private listeners=new Set<()=>void>();
 constructor(readonly store:RealmSaleStore,private readonly ports:RealmSalePorts){}
 snapshot=():RealmSaleState=>this.state;
 subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
 private publish(change:Partial<RealmSaleState>){this.state=freeze({...this.state,...change});this.listeners.forEach(f=>f());}
 dismiss(){this.epoch++;this.reviewed=null;this.publish({review:null});}
 private async action(newAction:boolean,run:(guard:Guard)=>Promise<void>){
  if(this.running)return;this.running=true;let guard:Guard|undefined;
  try{const captured=this.ports.capture(newAction),epoch=this.epoch;guard=()=>{captured();need(epoch===this.epoch,'The purchase view changed. Check the original saved request.');};guard();this.publish({busy:true,error:null});const current=guard;
   await this.ports.lock(`pkw-realm-sales-v1:${this.store.key}`,async()=>{await this.read(current);await run(current);});
  }catch(error){this.reviewed=null;try{guard?.();if(guard)this.publish({review:null,settlementHeld:this.held,error:error instanceof Error?error.message:'Check the original saved purchase.'});}catch{/* obsolete view; owned evidence is retained separately */}}
  finally{this.running=false;try{guard?.();if(guard)this.publish({busy:false,settlementHeld:this.held});}catch{/* old session */}}
 }
 private async read(guard:Guard){
  guard();const journal=await this.store.read();
  // The store shares failed-write holds across instances and releases only
  // verified settlement archives; reopening cannot clear contradictory evidence.
  this.held=this.store.settlementHeld();guard();this.publish({loaded:true,journal,settlementHeld:this.held});
 }
 private operation():RealmSaleOperation{const op=this.state.journal?.operation;need(op,'No original realm purchase is saved.');return op;}
 private async write(update:(old:RealmSaleJournal)=>RealmSaleJournal,guard:Guard){guard();const old=await this.store.read();guard();await this.store.compareAndSet(old.revision,update);await this.read(guard);}
 private unheld(){need(!this.held,'A settlement response requires receipt verification. Keep this original purchase.');}
 /** Retention has no view guard: a late valid response belongs to its actor/key. */
 private async retainPreparation(request:RealmSalePrepareRequest,raw:unknown){
  const value=RealmSalePreparationEnvelopeSchema.parse(raw);need(value.wallet===this.store.identity.wallet&&value.idempotencyKey===request.idempotencyKey,'Preparation belongs to another wallet or key.');
  const old=await this.store.read(),op=old.operation;need(op&&same(op.request,request),'The original purchase request changed.');
  if(value.preparation===null){need(!op.preparation,'The original preparation is temporarily unavailable.');return;}
  const p=value.preparation;need(p.spot===request.spot&&p.realm===request.realm,'The preparation changed the original spot or realm.');
  if(op.preparation){need(same(op.preparation,p),'The original purchase preparation changed.');return;}
  await this.store.compareAndSet(old.revision,row=>({...row,operation:{...row.operation!,preparation:p}}));
 }
 private async retainSigned(preparation:RealmSalePreparationView,signed:SignedRealmSale){
  const wire=signed.wire,signature=signed.signature,verified=await verifySignedRealmSale(preparation,wire);need(signature===verified.signature,'The returned signature differs from its wire.');
  const old=await this.store.read(),op=old.operation;need(op?.signingStarted&&op.preparation&&same(op.preparation,preparation),'Signing has no original durable marker.');
  if(op.signed){need(same(op.signed,verified),'The original signed purchase cannot change.');return;}
  await this.store.compareAndSet(old.revision,row=>({...row,operation:{...row.operation!,signed:verified}}));
 }
 private async retainSaved(request:RealmSalePrepareRequest,raw:unknown,submitted=false){
  const value=object(raw,submitted?['wallet','idempotencyKey','wire','settlement','delivery']:['wallet','idempotencyKey','preparation','wire','settlement'],submitted?['reason','reconciliation']:[]);
  need(value.wallet===this.store.identity.wallet&&value.idempotencyKey===request.idempotencyKey,'Saved response belongs to another actor or key.');
  if(submitted)need(['held','submitted','settled'].includes(value.delivery as string),'Unknown delivery response.');
  const hasSettlement=value.settlement!==null;if(hasSettlement){this.store.observeSettlementKey(request.idempotencyKey);this.held=true;} // Unparsed positive settlement always holds this original key.
  // Own bounded data before yielding. Even malformed adjacent evidence cannot
  // erase the durable positive observation; valid wire survives a bad receipt.
  let wire:ReturnType<typeof RealmSaleSignedWireSchema.parse>|null=null,p:RealmSalePreparationView|null=null,invalid:unknown,settlement:RealmSaleSettlementView|undefined,invalidSettlement:unknown;
  try{wire=value.wire===null?null:RealmSaleSignedWireSchema.parse(value.wire);p=submitted||value.preparation===null?null:RealmSalePreparationSchema.parse(value.preparation);}catch(error){invalid=error;}
  if(hasSettlement)try{settlement=RealmSaleSettlementSchema.parse(value.settlement);}catch(error){invalidSettlement=error;}
  if(hasSettlement){const row=await this.store.read();need(row.operation&&same(row.operation.request,request),'The original purchase changed.');
   if(!row.operation.settlementObserved)await this.store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,settlementObserved:true}}));
  }
  if(invalid)throw invalid;
  if(!submitted)await this.retainPreparation(request,{wallet:this.store.identity.wallet,idempotencyKey:request.idempotencyKey,preparation:p});
  const old=await this.store.read(),preparation=old.operation?.preparation;need(old.operation&&same(old.operation.request,request),'Original purchase changed during recovery.');
  if(wire){need(preparation&&wire.wallet===preparation.wallet&&wire.idempotencyKey===preparation.idempotencyKey&&wire.saleId===preparation.saleId&&wire.messageSha256===preparation.quote.messageSha256,'Retained wire belongs to another original purchase.');
   const bytes=Buffer.from(wire.signedTransactionHex,'hex'),digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));need(Buffer.from(digest).toString('hex')===wire.wireSha256,'Retained wire hash differs.');
   await this.retainSigned(preparation,{wire:bytes.toString('base64'),signature:wire.signature});
  }else need(!submitted,'Submission did not retain its original wire.');
  if(invalidSettlement)throw invalidSettlement;
  if(settlement){
   need(preparation&&wire,'Settlement requires its original preparation and signed wire.');const checked=await verifyRealmSaleSettlement(preparation,wire,settlement);
   const row=await this.store.read();need(row.operation&&same(row.operation.request,request),'Original purchase changed during settlement recovery.');
   const evidence={wire,value:checked};
   if(row.operation.settlement)need(same(row.operation.settlement,evidence),'The original settled receipt changed.');
   else await this.store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,settlement:evidence}}));
  }
 }
 /** A positive owner failure holds the original before nested decoding, crypto
  * or view checks. Retention belongs to the captured actor/key after logout too. */
 private async retainFailure(request:RealmSalePrepareRequest,wireMetadata:unknown,raw:unknown){
  const value=object(raw,['wallet','idempotencyKey','failure']);need(value.wallet===this.store.identity.wallet&&value.idempotencyKey===request.idempotencyKey,'Failed purchase belongs to another actor or key.');
  const positive=value.failure!==null;if(positive){this.store.observeFailureKey(request.idempotencyKey);this.held=true;}
  const parsed=positive?RealmSaleFailureSchema.safeParse(value.failure):null,wire=RealmSaleSignedWireSchema.safeParse(wireMetadata);
  let row=await this.store.read();need(row.operation&&same(row.operation.request,request),'The original failed purchase changed.');
  if(!positive){need(!row.operation.failure,'The saved failed outcome is temporarily unavailable. Keep the original purchase.');return;}
  if(!row.operation.failureObserved){await this.store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,failureObserved:true}}));row=await this.store.read();}
  need(parsed?.success&&wire.success,'The failed purchase requires complete original wire and outcome evidence.');
  const evidence={wire:wire.data,value:parsed.data};
  if(row.operation!.failure){need(same(row.operation!.failure,evidence),'The saved failed purchase changed.');return;}
  await this.store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,failure:evidence}}));
 }
 private async failure(request:RealmSalePrepareRequest,wire:unknown,guard:Guard){
  const raw=await this.ports.getFailure(request.idempotencyKey,guard,value=>this.retainFailure(request,wire,value));await this.retainFailure(request,wire,raw);guard();await this.read(guard);return RealmSaleFailureEnvelopeSchema.parse(raw);
 }
 private async recover(guard:Guard){
  const op=this.state.journal?.operation;if(!op||op.settlement)return;const request=op.request;
  const prep=await this.ports.getPreparation(request,guard,raw=>this.retainPreparation(request,raw));await this.retainPreparation(request,prep);guard();await this.read(guard);
  const saved=await this.ports.getSaved(request.idempotencyKey,guard,raw=>this.retainSaved(request,raw));const wire=saved&&typeof saved==='object'&&'wire'in saved?structuredClone(saved.wire):null;await this.retainSaved(request,saved);guard();await this.read(guard);
  if(this.state.journal?.operation?.signingStarted)await this.failure(request,wire,guard);
 }
 private fresh(value:{preparation:RealmSalePreparationView;current:Review;started:number}){
  const now=this.ports.clock(),elapsed=now-value.started;need(Number.isFinite(now)&&Number.isFinite(value.started)&&elapsed>=0&&elapsed<=Number.MAX_SAFE_INTEGER,'The monotonic purchase clock is unavailable.');
  const remaining=BigInt(value.preparation.terms.validUntil)-BigInt(value.current.unixTimestamp);need(remaining>=0n&&BigInt(Math.ceil(elapsed))<=remaining*1000n,'The original purchase consent has expired. Keep its recovery record.');
 }
 private async current(preparation:RealmSalePreparationView,guard:Guard){const started=this.ports.clock(),raw=await this.ports.currentReview(preparation,guard),current=validateRealmSaleReview(preparation,raw);guard();const value={preparation,current,started};this.fresh(value);return value;}
 open():Promise<void>{return this.action(false,guard=>this.recover(guard));}
 check():Promise<void>{return this.open();}
 archive():Promise<void>{return this.action(false,async guard=>{
  need(this.operation().settlement,'Verify the saved purchase receipt before archiving.');
  const row=await this.store.read();guard();await this.store.archive(row.revision);this.held=false;this.reviewed=null;
  guard();this.publish({review:null});await this.read(guard);
 });}
 archiveFailed():Promise<void>{return this.action(false,async guard=>{
  const row=await this.store.read(),op=row.operation;guard();need(op?.failure,'Recover the bound failed purchase before archiving.');
  const saved=await this.ports.getSaved(op.request.idempotencyKey,guard,value=>this.retainSaved(op.request,value));const wire=saved&&typeof saved==='object'&&'wire'in saved?structuredClone(saved.wire):null;
  await this.retainSaved(op.request,saved);guard();const fresh=await this.failure(op.request,wire,guard);guard();
  await this.store.archiveFailure(row.revision,fresh);guard();this.reviewed=null;this.publish({review:null});await this.read(guard);
 });}
 begin(spot:number,realm:number):Promise<void>{return this.action(true,async guard=>{
  this.unheld();need(!this.state.journal?.operation,'Recover the original purchase before another request.');const request=RealmSalePrepareRequestSchema.parse({idempotencyKey:this.ports.key(),spot,realm});
  await this.write(row=>{need(row.operation===null,'Another tab already saved the original purchase.');return {...row,operation:{request,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}};},guard);
  await this.write(row=>{need(row.operation&&!row.operation.prepareAttempted&&same(row.operation.request,request),'The original prepare attempt already started.');return {...row,operation:{...row.operation,prepareAttempted:true}};},guard);
  const refusal=async(raw:RealmSalePrepareRefusal)=>{const value=parseRealmSalePrepareRefusal(raw),old=await this.store.read();need(old.operation&&same(old.operation.request,request),'The original prepare request changed.');
   await this.store.compareAndSet(old.revision,row=>({...row,operation:{...row.operation!,prepareRefusal:value}}));
   try{await this.read(guard);}catch{/* valid late refusal remains with its original actor/key */}
  };
  const raw=await this.ports.prepare(request,guard,value=>this.retainPreparation(request,value),refusal);await this.retainPreparation(request,raw);guard();await this.read(guard);
 });}
 archiveRefusal():Promise<void>{return this.action(false,async guard=>{
  this.unheld();need(this.operation().prepareRefusal,'This original preparation has no definitive refusal.');
  // Both authenticated original GETs must finish; missing/failed replies cannot
  // substitute for an explicit refused response or erase contradictory evidence.
  await this.recover(guard);await this.read(guard);this.unheld();
  await this.write(row=>{const op=row.operation;need(op?.prepareRefusal&&!op.preparation&&!op.signingStarted&&!op.signed&&!op.submitAttempted&&!op.settlementObserved&&!op.settlement,'Keep the original purchase and recover its evidence.');return {...row,operation:{...op,refusalConfirmedAbsent:true}};},guard);
  const row=await this.store.read();guard();await this.store.archive(row.revision);this.reviewed=null;this.publish({review:null});await this.read(guard);
 });}
 review():Promise<void>{return this.action(true,async guard=>{
  this.reviewed=null;this.publish({review:null});await this.recover(guard);this.unheld();const op=this.operation();need(!op.prepareRefusal,'The refused purchase has contradictory preparation evidence. Keep its original record.');need(!op.signingStarted&&!op.signed,'The original wallet approval was already started. Recover its saved outcome.');need(op.preparation,'Recover the original purchase preparation first.');
  const current=await this.current(op.preparation,guard);this.reviewed={...current,guard};this.publish({review:{preparation:current.preparation,current:current.current}});
 });}
 sign():Promise<void>{return this.action(true,async guard=>{
  const reviewed=this.reviewed;need(reviewed,'Review the original purchase and its SOL limits before wallet approval.');reviewed.guard();this.fresh(reviewed);await this.recover(guard);this.unheld();const op=this.operation();
  need(!op.signingStarted&&!op.signed,'Wallet approval was already started. Recover the original signature; do not sign again.');need(op.preparation&&same(op.preparation,reviewed.preparation),'The reviewed original preparation changed.');
  await this.current(op.preparation,guard);reviewed.guard();this.fresh(reviewed);
  await this.write(row=>{need(row.operation&&!row.operation.signingStarted&&!row.operation.signed&&same(row.operation.preparation,reviewed.preparation),'Another wallet approval already started.');return {...row,operation:{...row.operation,signingStarted:true}};},guard);reviewed.guard();this.fresh(reviewed);
  const signed=await this.ports.sign(reviewed.preparation,guard);await this.retainSigned(reviewed.preparation,signed);guard();reviewed.guard();this.reviewed=null;this.publish({review:null});await this.read(guard);
 });}
 submit():Promise<void>{return this.action(true,async guard=>{
  await this.recover(guard);this.unheld();const op=this.operation();need(!op.submitAttempted,'This original signed purchase was already submitted. Check its saved outcome.');need(op.preparation&&op.signed,'Recover the original signed purchase first.');
  const current=await this.current(op.preparation,guard),signed=await verifySignedRealmSale(op.preparation,op.signed.wire);guard();this.fresh(current);need(signed.signature===op.signed.signature,'Original signature changed.');
  await this.write(row=>{need(row.operation&&!row.operation.submitAttempted&&same(row.operation.signed,signed),'The original submit attempt already started.');return {...row,operation:{...row.operation,submitAttempted:true}};},guard);this.fresh(current);
  const raw=await this.ports.submit({idempotencyKey:op.request.idempotencyKey,signedTransaction:signed.wire},guard,value=>this.retainSaved(op.request,value,true));await this.retainSaved(op.request,raw,true);guard();await this.read(guard);
 });}
}
