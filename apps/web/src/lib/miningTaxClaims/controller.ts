import {Buffer} from 'buffer';
import {MiningTaxClaimPreparationEnvelopeSchema,MiningTaxClaimPrepareRequestSchema,type MiningTaxClaimPreparation,type MiningTaxClaimPrepareRequest} from '@shardkeep/shared/miningTaxClaimsApi';
import {MiningTaxClaimSubmitResponseSchema,MiningTaxClaimSignedWireSchema,validateMiningTaxClaimRecoveryEnvelope,type MiningTaxClaimSignedWireView} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import {validateMiningTaxClaimCurrentReview} from '@shardkeep/shared/miningTaxClaimReviewApi';
import {prepareMiningTaxClaimSigning,verifySignedMiningTaxClaim,type MiningTaxClaimSigningTrust,type PreparedMiningTaxClaimSigning,type SignedMiningTaxClaim} from './signing';
import {verifyMiningTaxClaimSettlement} from './settlement';
import {MiningTaxClaimFailureEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimFailureApi';
import {verifyMiningTaxClaimFailure} from './failure';
import {MiningTaxClaimContinuationRequestSchema,MiningTaxClaimContinuationEnvelopeSchema,type MiningTaxClaimContinuationRequest} from '@shardkeep/shared/miningTaxClaimContinuationApi';
import {verifyMiningTaxClaimContinuation} from './continuation';
import type {MiningTaxClaimJournal,MiningTaxClaimOperation,MiningTaxClaimStore} from './journal';
type Guard=()=>void;
type Retain=(raw:unknown)=>Promise<void>;
type Review=ReturnType<typeof validateMiningTaxClaimCurrentReview>;
export interface MiningTaxClaimPorts{
 capture(newAction:boolean):Guard;lock<T>(name:string,run:()=>Promise<T>):Promise<T>;key():string;clock():number;
 prepare(request:MiningTaxClaimPrepareRequest,guard:Guard,retain:Retain):Promise<unknown>;
 getPreparation(request:MiningTaxClaimPrepareRequest,guard:Guard,retain:Retain):Promise<unknown>;
 getSaved(idempotencyKey:string,guard:Guard,retain:Retain):Promise<unknown>;
 getFailures(idempotencyKey:string,guard:Guard,retain:Retain):Promise<unknown>;
 getContinuation(idempotencyKey:string,guard:Guard,retain:Retain):Promise<unknown>;
 prepareContinuation(parentIdempotencyKey:string,request:MiningTaxClaimContinuationRequest,guard:Guard,retain:Retain):Promise<unknown>;
 currentReview(idempotencyKey:string,ordinal:number,guard:Guard):Promise<unknown>;
 sign(prepared:PreparedMiningTaxClaimSigning,guard:Guard):Promise<SignedMiningTaxClaim>;
 submit(request:{idempotencyKey:string;signedTransaction:string},guard:Guard,retain:Retain):Promise<unknown>;
}
export interface MiningTaxClaimState{loaded:boolean;busy:boolean;journal:MiningTaxClaimJournal|null;review:{preparation:MiningTaxClaimPreparation;current:Review;ordinal:number}|null;settlementHeld:boolean;error:string|null}
type Current={preparation:MiningTaxClaimPreparation;current:Review;ordinal:number;prepared:PreparedMiningTaxClaimSigning;started:number};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function need(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
// Positive evidence is inspected without invoking untrusted accessors and before
// any schema, cryptography or storage await can fail. Parsing remains strict.
const field=(raw:unknown,name:string):unknown=>raw&&typeof raw==='object'?Object.getOwnPropertyDescriptor(raw,name)?.value:undefined;
const ordinal=(value:unknown):number|undefined=>value===0||value===1?value:undefined;
/** Explicit, one-attempt effects on immutable consent. All remount/recovery work
 * is GET-only; only the store's fully bound terminal proof permits archival. */
export class MiningTaxClaimController{
 private state:MiningTaxClaimState=freeze({loaded:false,busy:false,journal:null,review:null,settlementHeld:false,error:null});
 private reviewed:(Current&{guard:Guard})|null=null;
 private running=false;private epoch=0;private listeners=new Set<()=>void>();private readonly trust:MiningTaxClaimSigningTrust;
 constructor(readonly store:MiningTaxClaimStore,private readonly ports:MiningTaxClaimPorts,trust:MiningTaxClaimSigningTrust){this.trust=Object.freeze({...trust});}
 snapshot=():MiningTaxClaimState=>this.state;
 subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private publish(change:Partial<MiningTaxClaimState>){this.state=freeze({...this.state,...change});this.listeners.forEach(f=>f());}
 dismiss(){this.epoch++;this.reviewed=null;this.publish({review:null});}
 private async action(newAction:boolean,run:(guard:Guard)=>Promise<void>){
  if(this.running)return;this.running=true;let guard:Guard|undefined;
  try{const captured=this.ports.capture(newAction),epoch=this.epoch;guard=()=>{captured();need(epoch===this.epoch,'The tax claim view changed. Recover the original request.');};guard();this.publish({busy:true,error:null});const current=guard;
   await this.ports.lock(`pkw-mining-tax-v1:${this.store.key}`,async()=>{await this.read(current);await run(current);});
  }catch(error){this.reviewed=null;try{guard?.();if(guard)this.publish({review:null,settlementHeld:this.store.settlementHeld(),error:error instanceof Error?error.message:'Keep and recover the original tax claim.'});}catch{/* Retention belongs to the original actor even after its view closes. */}}
  finally{this.running=false;try{guard?.();if(guard)this.publish({busy:false,settlementHeld:this.store.settlementHeld()});}catch{/* Obsolete session. */}}
 }
 private async read(guard:Guard){guard();const journal=await this.store.read();guard();this.publish({loaded:true,journal,settlementHeld:this.store.settlementHeld()});}
 private operation():MiningTaxClaimOperation{const op=this.state.journal?.operation;need(op,'No original tax claim is saved.');return op;}
 private async write(update:(old:MiningTaxClaimJournal)=>MiningTaxClaimJournal,guard:Guard){guard();const old=await this.store.read();guard();await this.store.compareAndSet(old.revision,row=>{guard();return update(row);});guard();await this.read(guard);}
 private unheld(op:MiningTaxClaimOperation,o:number){need(!op.unattributedObserved&&!op.settlement&&!op.failure&&!op.failureObserved&&!op.continuation&&!op.continuationObserved&&!op.observed.some(v=>v>=o||v<o&&!op.setup)&&!this.store.otherSettlementHeld(op.request.idempotencyKey)&&!this.store.settlementHeld(op.request.idempotencyKey,o),'Positive tax evidence holds this transaction. Recover its original proof.');}
 private eligible(op:MiningTaxClaimOperation,o:number,effect:'sign'|'submit'){
  need(ordinal(o)!==undefined&&op.preparation?.transactions[o],'Recover the selected original tax preparation first.');this.unheld(op,o);
  need(o!==1||op.setup,'Verify the original setup before reviewing its claim.');need(o!==0||!op.setup,'The setup is already verified. Review its separate claim.');
  const tx=op.transactions.find(t=>t.ordinal===o);
  if(effect==='sign')need(!tx?.signingStarted&&!tx?.signed,'The original wallet approval already started. Recover it without signing again.');
  else need(tx?.signed&&!tx.submitAttempted,'Recover the original signature or its prior submission; never submit it again.');
 }
 private observe(request:MiningTaxClaimPrepareRequest,raw:unknown,ackOrdinal?:number):(number|undefined)[]{
  const observed=new Set<number|undefined>(),receipt=field(raw,'settlement'),wires=field(raw,'wires'),wire=field(raw,'wire'),status=field(raw,'status'),delivery=field(raw,'delivery');
  if(receipt!==undefined&&receipt!==null)observed.add(ordinal(field(receipt,'ordinal')));
  if(wires!==undefined){if(Array.isArray(wires)&&wires.length<=2){for(const w of wires)observed.add(ordinal(field(w,'ordinal')));}else observed.add(undefined);}
  if(wire!==undefined&&wire!==null)observed.add(ordinal(field(wire,'ordinal'))??ackOrdinal);
  if((status==='signed'||status==='setup'||status==='settled')&&!observed.size)observed.add(undefined);
  if(delivery==='held'||delivery==='submitted'||delivery==='setup'||delivery==='settled')observed.add(ackOrdinal);
  for(const o of observed)this.store.observeSettlementKey(request.idempotencyKey,o);
  return [...observed];
 }
 private async persistObserved(request:MiningTaxClaimPrepareRequest,observed:(number|undefined)[]){
  for(const o of observed){const row=await this.store.read(),op=row.operation;need(op&&same(op.request,request),'The original tax observation changed.');if(o===undefined?!op.unattributedObserved:!op.observed.includes(o))await this.store.observeSettlement(row.revision,request.idempotencyKey,o);}
 }
 /** A valid late response is retained against its original actor/key regardless
  * of session, lifecycle or dismissal. It never authorizes the next effect. */
 private async retainPreparation(request:MiningTaxClaimPrepareRequest,raw:unknown){
  const observed=this.observe(request,raw);let value:ReturnType<typeof MiningTaxClaimPreparationEnvelopeSchema.parse>|undefined,invalid:unknown;
  try{value=MiningTaxClaimPreparationEnvelopeSchema.parse(raw);}catch(error){invalid=error;}
  await this.persistObserved(request,observed);if(invalid)throw invalid;need(value,'Invalid tax preparation.');
  need(value.wallet===this.store.identity.wallet&&value.idempotencyKey===request.idempotencyKey,'Preparation belongs to another original wallet or key.');
  const old=await this.store.read(),op=old.operation;need(op&&same(op.request,request),'The original tax request changed.');
  const p=value.preparation;if(!p){need(!op.preparation,'The original tax preparation is temporarily unavailable.');return;}
  need(same(request,{idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:p.caps}),'Preparation changed the original tax consent or SOL caps.');
  if(op.preparation){need(same(op.preparation,p),'The original tax preparation cannot change.');return;}
  await this.store.compareAndSet(old.revision,row=>({...row,operation:{...row.operation!,preparation:p}}));
 }
 private async retainSigned(p:MiningTaxClaimPreparation,signed:SignedMiningTaxClaim){
  const saved={ordinal:signed.ordinal,wire:signed.wire,signature:signed.signature,messageSha256:signed.messageSha256,wireSha256:signed.wireSha256};
  const verified=await verifySignedMiningTaxClaim(p,saved.wire,saved.ordinal);need(same(saved,verified),'The returned tax signature or hashes differ from its exact wire.');
  const old=await this.store.read(),op=old.operation,tx=op?.transactions.find(t=>t.ordinal===saved.ordinal);need(op&&same(op.preparation,p)&&tx?.signingStarted,'Signed tax custody lacks its original durable wallet marker.');
  if(tx.signed){need(same(tx.signed,verified),'The original signed tax wire cannot change.');return;}
  await this.store.compareAndSet(old.revision,row=>({...row,operation:{...row.operation!,transactions:row.operation!.transactions.map(t=>t.ordinal===saved.ordinal?{...t,signed:verified}:t)}}));
 }
 private async retainWire(p:MiningTaxClaimPreparation,w:MiningTaxClaimSignedWireView){
  const tx=p.transactions[w.ordinal];need(w.wallet===p.wallet&&w.idempotencyKey===p.idempotencyKey&&w.claimId===p.claimId&&tx?.kind===w.kind&&tx.messageSha256===w.messageSha256,'Server custody differs from the original tax packet.');
  await this.retainSigned(p,{ordinal:w.ordinal,wire:Buffer.from(w.signedTransactionHex,'hex').toString('base64'),signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256});
 }
 private nestedWires(raw: unknown): MiningTaxClaimSignedWireView[] {
  const values = field(raw, 'wires');
  if (!Array.isArray(values) || values.length > 2) return [];
  return values.flatMap(value => {
   const parsed = MiningTaxClaimSignedWireSchema.safeParse(value);
   return parsed.success ? [parsed.data] : [];
  });
 }
 private async retainNestedWires(request: MiningTaxClaimPrepareRequest, wires: MiningTaxClaimSignedWireView[]) {
  if (!wires.length) return;
  const row = await this.store.read(), op = row.operation;
  need(op && same(op.request, request), 'The original tax custody changed.');
  if (!op.preparation) return;
  // Nested exact custody belongs to an already-started original even when its
  // surrounding receipt or actor is malformed. Never manufacture that marker.
  let invalid: unknown;
  for (const wire of wires) {
   if (wire.wallet !== op.preparation.wallet || wire.idempotencyKey !== request.idempotencyKey
    || wire.claimId !== op.preparation.claimId || !op.transactions.some(t => t.ordinal === wire.ordinal && t.signingStarted)) continue;
   try { await this.retainWire(op.preparation, wire); } catch (error) { invalid ??= error; }
  }
  if (invalid) throw invalid;
 }
 private async retainSaved(request:MiningTaxClaimPrepareRequest,raw:unknown){
  const observed=this.observe(request,raw),nested=this.nestedWires(raw);let value:ReturnType<typeof validateMiningTaxClaimRecoveryEnvelope>|undefined,invalid:unknown;
  try{value=validateMiningTaxClaimRecoveryEnvelope(raw);}catch(error){invalid=error;}
  let observationError: unknown;
  try { await this.persistObserved(request, observed); } catch (error) { observationError = error; }
  if(invalid || observationError){await this.retainNestedWires(request,nested);throw observationError ?? invalid;}
  need(value,'Invalid saved tax recovery.');
  need(value.wallet===this.store.identity.wallet&&value.idempotencyKey===request.idempotencyKey,'Recovery belongs to another original wallet or key.');
  await this.retainPreparation(request,{wallet:value.wallet,idempotencyKey:value.idempotencyKey,status:value.preparation?'prepared':'unknown',preparation:value.preparation,serverNow:value.serverNow});
  const first=await this.store.read(),p=first.operation?.preparation;need(first.operation&&same(first.operation.request,request),'The original tax recovery changed.');
  let invalidWire: unknown;
  for(const wire of value.wires){
   try { need(p,'Server custody requires the original tax preparation.');await this.retainWire(p,wire); }
   catch (error) { invalidWire ??= error; }
  }
  if (invalidWire) throw invalidWire;
  if(value.settlement){const row=await this.store.read(),op=row.operation;need(op&&p&&same(op.request,request),'The original tax settlement changed.');
   const bound=await verifyMiningTaxClaimSettlement({wallet:this.store.identity.wallet,request,preparation:p,wires:op.transactions.flatMap(t=>t.signed?[t.signed]:[])},value,this.trust),name=bound.phase==='setup'?'setup':'settlement';
   const old=await this.store.read();need(old.operation&&same(old.operation.request,request),'The original tax settlement changed.');
   // Keep the first fully bound proof immutable. New GET clocks and additional
   // signed custody are not a change to the underlying historical attestation.
   if(old.operation[name])need(same(old.operation[name]!.settlement,bound.recovery.settlement),'The original tax settlement attestation changed.');
   else await this.store.compareAndSet(old.revision,j=>({...j,operation:{...j.operation!,[name]:bound.recovery}}));
  }
 }
 private async retainFailures(request:MiningTaxClaimPrepareRequest,raw:unknown){
  const recovery=field(raw,'recovery'),failures=field(raw,'failures'),observed=this.observe(request,recovery);
  if(Array.isArray(failures)&&failures.length<=2){for(const f of failures){const o=ordinal(field(f,'ordinal'));this.store.observeSettlementKey(request.idempotencyKey,o);observed.push(o);}}
  else if(failures!==undefined){this.store.observeSettlementKey(request.idempotencyKey);observed.push(undefined);}
  const positiveFailure=failures!==undefined&&(!Array.isArray(failures)||failures.length>0);
  if(positiveFailure)this.store.observeFailureKey(request.idempotencyKey);
  const parsed=MiningTaxClaimFailureEnvelopeSchema.safeParse(raw);let invalid:unknown;
  try{await this.persistObserved(request,observed);}catch(error){invalid=error;}
  if(positiveFailure)try{const row=await this.store.read();need(row.operation&&same(row.operation.request,request),'The original failure observation changed.');if(!row.operation.failureObserved)await this.store.compareAndSet(row.revision,r=>({...r,operation:{...r.operation!,failureObserved:true}}));}catch(error){invalid??=error;}
  // Exact nested bytes belong to the original even when the failure grammar,
  // observation write or current screen fails. Drain before surfacing errors.
  try{await this.retainSaved(request,recovery);}catch(error){invalid??=error;}
  if(invalid)throw invalid;need(parsed.success,'Invalid saved tax failure recovery.');
  const value=parsed.data,row=await this.store.read(),op=row.operation;
  need(op&&same(op.request,request),'The original tax failure changed.');
  if(!value.failures.length){need(!op.failure,'Saved failed tax outcomes are temporarily unavailable. Keep the original history.');return;}
  need(op.preparation,'Recover the original tax preparation before failed history.');
  const bound=await verifyMiningTaxClaimFailure({wallet:this.store.identity.wallet,request,preparation:op.preparation,wires:op.transactions.flatMap(t=>t.signed?[t.signed]:[])},value,this.trust);
  if(op.failure&&same(op.failure.failures,bound.envelope.failures)&&same(op.failure.recovery.settlement,bound.envelope.recovery.settlement))return;
  await this.store.compareAndSet(row.revision,r=>({...r,operation:{...r.operation!,failure:bound.envelope}}));
 }
 private async retainContinuation(request:MiningTaxClaimPrepareRequest,raw:unknown){
  const positive=field(raw,'status')==='continued'||field(raw,'continuation')!=null;
  if(positive)this.store.observeContinuationKey(request.idempotencyKey);
  const parsed=MiningTaxClaimContinuationEnvelopeSchema.safeParse(raw),first=await this.store.read();
  need(first.operation&&same(first.operation.request,request),'The original continuation observation changed.');
  if(positive&&!first.operation.continuationObserved)await this.store.compareAndSet(first.revision,row=>({...row,operation:{...row.operation!,continuationObserved:true}}));
  need(parsed.success,'Invalid saved tax continuation.');const envelope=parsed.data;
  need(envelope.wallet===this.store.identity.wallet&&envelope.parentIdempotencyKey===request.idempotencyKey,'Continuation belongs to another original wallet or key.');
  const row=await this.store.read(),op=row.operation;need(op&&same(op.request,request),'The original continuation changed.');
  if(!envelope.continuation){need(!op.continuation?.envelope,'Saved continuation is temporarily unavailable. Keep original recovery.');return;}
  need(op.preparation&&op.setup&&op.continuation?.attempted,'Recover the exact saved continuation consent first.');
  const bound=await verifyMiningTaxClaimContinuation({wallet:this.store.identity.wallet,request,preparation:op.preparation,wires:op.transactions.flatMap(t=>t.signed?[t.signed]:[])},op.setup,op.continuation.request,envelope,this.trust);
  if(op.continuation.envelope){need(same(op.continuation.envelope.continuation,bound.envelope.continuation),'The saved continuation link cannot change.');return;}
  await this.store.compareAndSet(row.revision,r=>({...r,operation:{...r.operation!,continuation:{...r.operation!.continuation!,envelope:bound.envelope}}}));
 }
 private async retainAcknowledgement(request:MiningTaxClaimPrepareRequest,o:number,raw:unknown){
  const observed=this.observe(request,raw,o);let value:ReturnType<typeof MiningTaxClaimSubmitResponseSchema.parse>|undefined,invalid:unknown;
  try{value=MiningTaxClaimSubmitResponseSchema.parse(raw);}catch(error){invalid=error;}
  await this.persistObserved(request,observed);if(invalid)throw invalid;need(value,'Invalid tax submission acknowledgement.');
  need(value.wallet===this.store.identity.wallet&&value.idempotencyKey===request.idempotencyKey,'Acknowledgement belongs to another original wallet or key.');
  const row=await this.store.read(),op=row.operation;need(op&&same(op.request,request)&&op.preparation&&op.transactions.some(t=>t.ordinal===o&&t.submitAttempted),'Acknowledgement lacks its original durable submission.');
  if(value.wire){need(value.wire.ordinal===o,'Acknowledgement changed the submitted tax ordinal.');await this.retainWire(op.preparation,value.wire);}
  // Even setup/settled delivery cannot supply receipt or archival authority.
 }
 private async recover(guard:Guard){
  const op=this.state.journal?.operation;if(!op||op.settlement)return;const request=op.request;
  if(!op.preparation){guard();const raw=await this.ports.getPreparation(request,guard,value=>this.retainPreparation(request,value));await this.retainPreparation(request,raw);guard();await this.read(guard);}
  guard();const raw=await this.ports.getSaved(request.idempotencyKey,guard,value=>this.retainSaved(request,value));await this.retainSaved(request,raw);guard();await this.read(guard);
  guard();const failed=await this.ports.getFailures(request.idempotencyKey,guard,value=>this.retainFailures(request,value));await this.retainFailures(request,failed);guard();await this.read(guard);
  if(this.operation().continuation){guard();const linked=await this.ports.getContinuation(request.idempotencyKey,guard,value=>this.retainContinuation(request,value));await this.retainContinuation(request,linked);guard();await this.read(guard);}
 }
 private fresh(value:Pick<Current,'preparation'|'current'|'started'>){const now=this.ports.clock(),elapsed=now-value.started,remaining=Date.parse(value.preparation.expiresAt)-Date.parse(value.current.serverNow);
  need(Number.isFinite(now)&&Number.isFinite(value.started)&&elapsed>=0&&elapsed<=Number.MAX_SAFE_INTEGER,'The monotonic tax claim clock is unavailable.');need(elapsed<remaining,'The original tax consent expired. Keep its recovery record.');
 }
 private async current(op:MiningTaxClaimOperation,o:number,guard:Guard):Promise<Current>{
  const p=op.preparation!;guard();const prepared=await prepareMiningTaxClaimSigning(p,this.trust,o);guard();const started=this.ports.clock(),raw=await this.ports.currentReview(p.idempotencyKey,o,guard);guard();const current=validateMiningTaxClaimCurrentReview(p,raw);
  need(current.ordinal===o&&current.status==='ready'&&current.review,'The original tax packet is unavailable for current review.');
  if(o===1){const receipt=op.setup?.settlement?.receipt;need(receipt&&current.review.paidFeeLamports===receipt.feeLamports&&current.review.paidRentLamports===receipt.rentLamports,'Current review changed the verified paid setup costs.');}
  const value={preparation:p,current,ordinal:o,prepared,started};this.fresh(value);guard();return value;
 }
 open():Promise<void>{return this.action(false,async guard=>{this.reviewed=null;this.publish({review:null});await this.recover(guard);});}
 check():Promise<void>{return this.open();}
 begin(round:string,spot:number,caps:MiningTaxClaimPrepareRequest['caps']):Promise<void>{return this.action(true,async guard=>{
  need(!this.store.settlementHeld()&&!this.state.journal?.operation,'Recover the original tax claim before another request.');const request=MiningTaxClaimPrepareRequestSchema.parse({idempotencyKey:this.ports.key(),round,spot,caps});
  await this.write(row=>{need(!row.operation,'Another tab saved an original tax request.');return {...row,operation:{request,prepareAttempted:false,preparation:null,transactions:[],observed:[],unattributedObserved:false,setup:null,settlement:null}};},guard);
  await this.write(row=>{need(row.operation&&!row.operation.prepareAttempted&&same(row.operation.request,request),'The original tax prepare attempt already started.');return {...row,operation:{...row.operation,prepareAttempted:true}};},guard);
  guard();const raw=await this.ports.prepare(request,guard,value=>this.retainPreparation(request,value));await this.retainPreparation(request,raw);guard();await this.read(guard);
 });}
 review(o=0):Promise<void>{return this.action(true,async guard=>{
  this.reviewed=null;this.publish({review:null});await this.recover(guard);const op=this.operation();this.eligible(op,o,'sign');const current=await this.current(op,o,guard);this.reviewed={...current,guard};this.publish({review:{preparation:current.preparation,current:current.current,ordinal:o}});
 });}
 sign():Promise<void>{return this.action(true,async guard=>{
  const reviewed=this.reviewed;need(reviewed,'Review the original tax packet and SOL caps before wallet approval.');reviewed.guard();this.fresh(reviewed);await this.recover(guard);const op=this.operation(),o=reviewed.ordinal;this.eligible(op,o,'sign');need(same(op.preparation,reviewed.preparation),'The reviewed original tax preparation changed.');
  const current=await this.current(op,o,guard);reviewed.guard();this.fresh(reviewed);
  await this.write(row=>{need(row.operation&&same(row.operation.preparation,reviewed.preparation),'The original tax preparation changed.');this.eligible(row.operation,o,'sign');return {...row,operation:{...row.operation,transactions:[...row.operation.transactions,{ordinal:o,signingStarted:true,signed:null,submitAttempted:false}].sort((a,b)=>a.ordinal-b.ordinal)}};},guard);
  const signingGuard=()=>{guard();reviewed.guard();this.fresh(reviewed);this.fresh(current);this.unheld(this.operation(),o);};signingGuard();
  const signed=await this.ports.sign(current.prepared,signingGuard);need(signed.ordinal===o,'The wallet returned another tax packet.');await this.retainSigned(reviewed.preparation,signed);guard();reviewed.guard();this.reviewed=null;this.publish({review:null});await this.read(guard);
 });}
 submit(o=0):Promise<void>{return this.action(true,async guard=>{
  await this.recover(guard);const op=this.operation();this.eligible(op,o,'submit');const current=await this.current(op,o,guard),saved=op.transactions.find(t=>t.ordinal===o)!.signed!,signed=await verifySignedMiningTaxClaim(op.preparation!,saved.wire,o);guard();this.fresh(current);need(same(saved,signed),'The original tax signature changed.');
  await this.write(row=>{need(row.operation&&same(row.operation.preparation,op.preparation)&&same(row.operation.transactions.find(t=>t.ordinal===o)?.signed,signed),'The original tax wire changed.');this.eligible(row.operation,o,'submit');return {...row,operation:{...row.operation,transactions:row.operation.transactions.map(t=>t.ordinal===o?{...t,submitAttempted:true}:t)}};},guard);
  const submitGuard=()=>{guard();this.fresh(current);this.unheld(this.operation(),o);};submitGuard();const raw=await this.ports.submit({idempotencyKey:op.request.idempotencyKey,signedTransaction:signed.wire},submitGuard,value=>this.retainAcknowledgement(op.request,o,value));await this.retainAcknowledgement(op.request,o,raw);guard();await this.read(guard);
 });}
 async prepareContinuation(caps:MiningTaxClaimContinuationRequest['caps']):Promise<void>{const ownedCaps=MiningTaxClaimContinuationRequestSchema.shape.caps.parse(caps);return this.action(true,async guard=>{
  this.reviewed=null;this.publish({review:null});await this.recover(guard);const op=this.operation();
  this.eligible(op,1,'sign');need(!op.continuation&&!op.continuationObserved,'Recover the saved continuation without another POST.');
  const existing=await this.ports.getContinuation(op.request.idempotencyKey,guard,value=>this.retainContinuation(op.request,value));await this.retainContinuation(op.request,existing);guard();
  const request=MiningTaxClaimContinuationRequestSchema.parse({idempotencyKey:this.ports.key(),caps:ownedCaps});need(request.idempotencyKey!==op.request.idempotencyKey,'Fresh continuation requires a distinct key.');
  await this.write(row=>{need(row.operation&&same(row.operation.request,op.request),'Original tax claim changed.');this.eligible(row.operation,1,'sign');return {...row,operation:{...row.operation,continuation:{request,attempted:false,envelope:null}}};},guard);
  await this.write(row=>{need(row.operation?.continuation&&!row.operation.continuation.attempted,'Continuation attempt already started.');need(!row.operation.failureObserved&&!row.operation.failure&&!row.operation.unattributedObserved&&!row.operation.transactions.some(t=>t.ordinal===1&&t.signingStarted)&&!this.store.settlementHeld(op.request.idempotencyKey,1)&&!this.store.otherSettlementHeld(op.request.idempotencyKey),'Unknown tax evidence holds continuation.');return {...row,operation:{...row.operation,continuation:{...row.operation.continuation,attempted:true}}};},guard);
  const postGuard=()=>{guard();need(!this.store.settlementHeld(op.request.idempotencyKey,1)&&!this.store.otherSettlementHeld(op.request.idempotencyKey),'Unknown tax evidence holds continuation.');};postGuard();
  const raw=await this.ports.prepareContinuation(op.request.idempotencyKey,request,postGuard,value=>this.retainContinuation(op.request,value));await this.retainContinuation(op.request,raw);guard();await this.read(guard);
 });}
 resumeContinuation():Promise<void>{return this.action(true,async guard=>{
  this.reviewed=null;this.publish({review:null});const before=await this.store.read(),original=before.operation;guard();
  need(original?.continuation,'No saved continuation preparation is available.');
  await this.recover(guard);const row=await this.store.read(),op=row.operation;guard();
  need(op&&same(op.request,original.request)&&op.continuation&&same(op.continuation.request,original.continuation.request),'Original continuation consent changed.');
  if(op.continuation.envelope)return; // A committed response needs adoption, never another POST.
  need(row.revision===before.revision,'Original recovery changed during the fresh reads. Check it before resuming.');
  const ready=()=>{guard();need(op.setup&&op.preparation?.transactions.length===2&&!op.settlement&&!op.failure&&!op.failureObserved&&!op.continuationObserved&&!op.unattributedObserved&&op.observed.every(o=>o===0)&&!op.transactions.some(t=>t.ordinal===1&&(t.signingStarted||t.signed||t.submitAttempted))&&!this.store.settlementHeld(op.request.idempotencyKey,1)&&!this.store.otherSettlementHeld(op.request.idempotencyKey),'Unknown tax evidence holds continuation.');};
  ready();await this.store.compareAndSet(before.revision,saved=>{ready();need(saved.operation?.continuation&&same(saved.operation.continuation.request,op.continuation!.request),'Original continuation changed.');return {...saved,operation:{...saved.operation,continuation:{...saved.operation.continuation,attempted:true}}};});await this.read(guard);
  ready();const raw=await this.ports.prepareContinuation(op.request.idempotencyKey,op.continuation.request,ready,value=>this.retainContinuation(op.request,value));await this.retainContinuation(op.request,raw);guard();await this.read(guard);
 });}
 activateContinuation():Promise<void>{return this.action(false,async guard=>{
  const row=await this.store.read(),op=row.operation;guard();need(op?.continuation?.envelope,'Recover the bound continuation first.');
  const parent=await this.ports.getSaved(op.request.idempotencyKey,guard,value=>this.retainSaved(op.request,value));await this.retainSaved(op.request,parent);guard();
  const failed=await this.ports.getFailures(op.request.idempotencyKey,guard,value=>this.retainFailures(op.request,value));await this.retainFailures(op.request,failed);guard();
  const link=await this.ports.getContinuation(op.request.idempotencyKey,guard,value=>this.retainContinuation(op.request,value));await this.retainContinuation(op.request,link);guard();
  await this.store.activateContinuation(row.revision,link,parent);guard();this.reviewed=null;this.publish({review:null});await this.read(guard);
 });}
 archive():Promise<void>{return this.action(false,async guard=>{
  need(this.operation().settlement,'Only a fully bound terminal tax payment can be archived.');guard();const row=await this.store.read();guard();await this.store.archive(row.revision);guard();this.reviewed=null;this.publish({review:null});await this.read(guard);
 });}
 archiveFailed():Promise<void>{return this.action(false,async guard=>{
  const row=await this.store.read(),op=row.operation;guard();need(op?.failure,'Recover the bound failed tax outcomes first.');
  const raw=await this.ports.getFailures(op.request.idempotencyKey,guard,value=>this.retainFailures(op.request,value));await this.retainFailures(op.request,raw);guard();
  // A newly discovered outcome or another tab's edit requires a new explicit
  // archive action. Never replace this revision with one read after the GET.
  await this.store.archiveFailure(row.revision,raw);guard();this.reviewed=null;this.publish({review:null});await this.read(guard);
 });}
}
