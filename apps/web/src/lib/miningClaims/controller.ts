import { MiningClaimReviewSchema, MiningClaimContinuationEnvelopeSchema, MiningClaimPreparationEnvelopeSchema, MiningClaimPreparationViewSchema, MiningClaimStatusViewSchema, MiningClaimSubmitResponseSchema, MiningClaimViewSchema,
  type MiningClaimPreparationView, type MiningClaimPrepareRequest, type MiningClaimStatusView, type MiningClaimSubmitRequest, type MiningClaimView } from '@shardkeep/shared/miningClaimsApi';
import { miningClaimArchivableFailure,continuedMiningOperation, emptyMiningOrdered, miningClaimOrdinal, miningClaimStep, withMiningStep, sameMiningContinuation, same, type MiningClaimJournal, type MiningClaimStore } from './journal';
import { verifySignedMiningClaim, type SignedMiningClaim } from './signing';
import {sha256} from '@noble/hashes/sha256';
import {Buffer} from 'buffer';
type Guard = () => void;
type Refusal = { status: number; code: string };
export interface MiningClaimPorts {
  capture(newAction: boolean): Guard;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  key(): string;
  clock(): number;
  getStatus(guard: Guard): Promise<unknown>;
  prepare(request: MiningClaimPrepareRequest, guard: Guard, retain: (raw: unknown) => Promise<void>, refusal: (raw: Refusal) => Promise<void>): Promise<unknown>;
  getPreparation(request: MiningClaimPrepareRequest, guard: Guard, retain: (raw: unknown) => Promise<void>): Promise<unknown>;
  getClaim(claimId: string, guard: Guard, retain: (raw: unknown) => Promise<void>): Promise<unknown>;
  live(preparation: MiningClaimPreparationView, guard: Guard, ordinal?: number): Promise<void>;
  sign(preparation: MiningClaimPreparationView, guard: Guard, ordinal?: number): Promise<SignedMiningClaim>;
  reviewOrdered?(claimId:string,ordinal:number,guard:Guard):Promise<unknown>;
  continuation?(parentClaimId:string,request:{idempotencyKey:string}|null,guard:Guard,retain:(raw:unknown)=>Promise<void>,refusal?:(raw:Refusal)=>Promise<void>):Promise<unknown>;
  submit(request: MiningClaimSubmitRequest, guard: Guard): Promise<unknown>;
}
export type MiningClaimState = { loaded: boolean; busy: boolean; journal: MiningClaimJournal | null;
  status: MiningClaimStatusView | null; reviewOrdinal?:number; review: MiningClaimPreparationView | null; error: string | null };
export async function miningClaimLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error('This browser cannot coordinate saved mining claims across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw Error('Another tab is handling this mining claim.'); return run();
  });
}
/** One original prepare and submit attempt. GETs never sign or send. */
export class MiningClaimController {
  private state: MiningClaimState = { loaded: false, busy: false, journal: null, status: null, review: null, error: null };
  private reviewValue: { preparation: MiningClaimPreparationView; ordinal:number; started: number; guard: Guard } | null = null;
  private running = false;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readonly store: MiningClaimStore, private readonly ports: MiningClaimPorts) {}
  snapshot = (): MiningClaimState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<MiningClaimState>): void { this.state = { ...this.state, ...change }; this.listeners.forEach(f => f()); }
  dismiss(): void { this.epoch++; this.reviewValue = null; this.publish({ review: null }); }
  private async action(newAction: boolean, run: (guard: Guard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; let guard: Guard | undefined;
    try {
      const captured = this.ports.capture(newAction), epoch = this.epoch;
      guard = () => { captured(); if (epoch !== this.epoch) throw Error('The mining claim view changed.'); };
      guard(); this.publish({ busy: true, error: null }); const current = guard;
      await this.ports.lock(`pkw-mining-claims-v1:${this.store.key}`, async () => { await this.read(current); await run(current); });
    } catch (error) {
      this.reviewValue = null;
      try { guard?.(); if (guard) this.publish({ review: null, error: error instanceof Error ? error.message : 'Check the saved mining claim.' }); } catch { /* original evidence may still be retained; obsolete view cannot publish */ }
    } finally {
      this.running = false;
      try { guard?.(); if (guard) this.publish({ busy: false }); } catch { /* old session */ }
    }
  }
  private async read(guard: Guard): Promise<void> { guard(); const journal = await this.store.read(); guard(); this.publish({ loaded: true, journal }); }
  private async write(update: (old: MiningClaimJournal) => MiningClaimJournal, guard: Guard): Promise<void> {
    guard(); const old = await this.store.read(); guard(); await this.store.compareAndSet(old.revision, update); await this.read(guard);
  }
  private operation() { const op = this.state.journal?.operation; if (!op) throw Error('No saved mining claim.'); return op; }
  /** Evidence retention deliberately has no view guard. */
  private async retainPreparation(key: string, raw: unknown): Promise<MiningClaimPreparationView> {
    const preparation = MiningClaimPreparationViewSchema.parse(raw), old = await this.store.read();
    if ((preparation.version===2)!==(old.operation?.request.profile==='ordered-v0') || preparation.wallet !== this.store.identity.wallet || preparation.idempotencyKey !== key || old.operation?.request.idempotencyKey !== key) throw Error('The preparation belongs to another saved request.');
    if (old.operation.preparation && same({ ...old.operation.preparation, serverNow: preparation.serverNow }, preparation)) return preparation;
    await this.store.compareAndSet(old.revision, row => ({ ...row, operation: { ...row.operation!, preparation } }));
    return preparation;
  }
  private async retainClaim(claimId: string, raw: unknown): Promise<void> {
    const old = await this.store.read();
    try {
      const claim = MiningClaimViewSchema.parse(raw);
      if (claim.wallet !== this.store.identity.wallet || claim.claimId !== claimId || old.operation?.preparation?.claimId !== claimId) throw Error('The claim receipt belongs to another preparation.');
      if (claim.state === 'unknown') { if (old.operation.claim) throw Error('The saved claim receipt is temporarily unavailable.'); return; }
      if (old.operation.claim && same({ ...old.operation.claim, serverNow: claim.serverNow }, claim)) return;
      await this.store.compareAndSet(old.revision, row => ({ ...row, operation: { ...row.operation!, claim } }));
    } catch(error) {
      const r=raw&&typeof raw==='object'?raw as Record<string,unknown>:null;
      if(r?.wallet===this.store.identity.wallet&&r.claimId===claimId&&(r.state==='settled'||r.state==='failed')){
        const current=await this.store.read();
        if(current.operation?.ordered&&current.operation.preparation?.claimId===claimId&&!current.operation.ordered.held)
          await this.store.compareAndSet(current.revision,row=>({...row,operation:{...row.operation!,ordered:{...row.operation!.ordered!,held:true}}}));
      }
      throw error;
    }
  }

  private async preparation(guard: Guard): Promise<MiningClaimPreparationView | null> {
    const request = this.operation().request;
    const retain = async (raw: unknown) => {
      const envelope = MiningClaimPreparationEnvelopeSchema.parse(raw);
      if (envelope.wallet !== this.store.identity.wallet || envelope.idempotencyKey !== request.idempotencyKey) throw Error('The preparation response belongs to another request.');
      if (envelope.receipt) await this.retainPreparation(request.idempotencyKey, envelope.receipt);
      else if ((await this.store.read()).operation?.preparation) throw Error('The saved preparation is temporarily unavailable.');
    };
    const raw = await this.ports.getPreparation(request, guard, retain); await retain(raw); guard(); await this.read(guard);
    return MiningClaimPreparationEnvelopeSchema.parse(raw).receipt;
  }
  private async claim(guard: Guard): Promise<MiningClaimView | null> {
    const p = this.operation().preparation; if (!p) return null;
    const retain = (raw: unknown) => this.retainClaim(p.claimId, raw);
    const raw = await this.ports.getClaim(p.claimId, guard, retain); await retain(raw); guard(); await this.read(guard);
    return MiningClaimViewSchema.parse(raw);
  }
  private async status(guard: Guard): Promise<MiningClaimStatusView> {
    const status = MiningClaimStatusViewSchema.parse(await this.ports.getStatus(guard)); guard();
    if (status.wallet !== this.store.identity.wallet) throw Error('Mining status belongs to another wallet.');
    this.publish({ status }); return status;
  }
  private fresh(p: MiningClaimPreparationView, started: number): void {
    const elapsed = this.ports.clock() - started, left = Date.parse(p.expiresAt) - Date.parse(p.serverNow);
    if (!Number.isFinite(elapsed) || elapsed < 0 || left <= 0 || elapsed >= left) throw Error('This claim fee quote has expired. Keep its recovery record.');
  }
  open(): Promise<void> { return this.action(false, async guard => {
    this.reviewValue = null; this.publish({ review: null });
    if (this.state.journal?.operation) { await this.preparation(guard); await this.claim(guard); await this.recoverContinuation(guard); }
    await this.status(guard);
  }); }
  begin(profile?:'ordered-v0'): Promise<void> { return this.action(true, async guard => {
    if (this.state.journal?.operation) throw Error('Recover the saved mining request before starting another.');
    const status = await this.status(guard); if (!status.preparationAllowed || status.state !== 'ready') throw Error('New mining claims are currently unavailable.');
    if(profile && status.features.claims.ordered!==1)throw Error('Two-step claims are not available.');
    const request:MiningClaimPrepareRequest = { idempotencyKey: this.ports.key(),...(profile?{profile}:{}) };
    await this.write(row => ({ ...row, operation: { request, prepareAttempted: false, preparation: null, signingStarted: false,
      signed: null, submitAttempted: false, claim: null, prepareRefusal: null, refusalConfirmedAbsent: false,...(profile?{ordered:emptyMiningOrdered()}:{}) } }), guard);
    await this.write(row => ({ ...row, operation: { ...row.operation!, prepareAttempted: true } }), guard);
    const retain = (raw: unknown) => this.retainPreparation(request.idempotencyKey, raw).then(() => undefined);
    const refusal = async (value: Refusal) => {
      const old = await this.store.read();
      if (old.operation?.request.idempotencyKey !== request.idempotencyKey) throw Error('The original prepare request changed.');
      await this.store.compareAndSet(old.revision, row => ({ ...row, operation: { ...row.operation!, prepareRefusal: value } }));
    };
    const raw = await this.ports.prepare(request, guard, retain, refusal); await retain(raw); guard(); await this.read(guard);
  }); }
  private orderedAction():void{
    const o=this.operation().ordered;if(o?.held||o?.continuationRequest||o?.continuation)throw Error('Keep this original for recovery. New signatures and delivery are held.');
  }
  private async orderedReview(p:MiningClaimPreparationView,ordinal:number,guard:Guard):Promise<void>{
    if(p.version!==2)return;this.orderedAction();
    if(!this.ports.reviewOrdered)throw Error('Current ordered review is unavailable.');
    const view=MiningClaimReviewSchema.parse(await this.ports.reviewOrdered(p.claimId,ordinal,guard));guard();
    const tx=p.transactions[ordinal]!,hash=Buffer.from(sha256(Buffer.from(tx.message,'base64'))).toString('hex');
    if(view.wallet!==p.wallet||view.claimId!==p.claimId||view.ordinal!==ordinal||view.messageSha256!==hash||view.blockhash!==tx.blockhash
      ||view.preparedAt!==p.preparedAt||view.expiresAt!==p.expiresAt||view.lastValidBlockHeight!==tx.lastValidBlockHeight)throw Error('The fresh review differs from the original claim.');
    if(ordinal===1){const setup=this.operation().signed,receipt=this.operation().claim?.transactions[0];
      if(!setup||receipt?.landing!=='finalized'||receipt.signature!==setup.signature||view.setup?.claimId!==p.claimId||view.setup.signature!==setup.signature
        ||view.setup.wireSha256!==Buffer.from(sha256(Buffer.from(setup.wire,'base64'))).toString('hex')
        ||view.setup.messageSha256!==Buffer.from(sha256(Buffer.from(p.transactions[0]!.message,'base64'))).toString('hex'))throw Error('The original setup has not been independently finalized.');
    }
  }
  review(): Promise<void> { return this.action(true, async guard => {
    this.reviewValue = null; this.publish({ review: null }); const started = this.ports.clock();
    const p = await this.preparation(guard); if (!p) throw Error('The original preparation has not been recovered.');
    await this.claim(guard); if (this.operation().claim?.state === 'settled' || this.operation().claim?.state === 'failed') throw Error('Recover the terminal claim receipt before another claim.');
    const status = await this.status(guard);
    if (status.state !== 'ready' || status.rootSequence !== p.rootSequence || !status.preparationAllowed) throw Error('The original mining allocation is no longer ready.');
    const ordinal=miningClaimOrdinal(this.operation()),step=miningClaimStep(this.operation(),ordinal);
    if(step.signed)throw Error('Wallet approval already started for this transaction. Check its original receipt.');
    await this.orderedReview(p,ordinal,guard);
    this.fresh(p, started); this.reviewValue = { preparation: p, ordinal, started, guard }; this.publish({ review: p,reviewOrdinal:ordinal });
  }); }
  sign(): Promise<void> { return this.action(true, async guard => {
    const review = this.reviewValue, op = this.operation();
    if (op.claim?.state === 'failed' || op.claim?.state === 'settled') throw Error('This original claim already has a terminal receipt.');
    const ordinal=miningClaimOrdinal(op),step=miningClaimStep(op,ordinal);
    if(step.signed)throw Error('The original approval already started. Keep its recovery record.');
    if (!review || review.ordinal!==ordinal || review.preparation.claimId !== op.preparation?.claimId) throw Error('Review the original claim and estimated SOL before wallet approval.');
    review.guard(); this.fresh(review.preparation, review.started);
    await this.orderedReview(review.preparation,ordinal,guard);
    await this.ports.live(review.preparation, guard,ordinal); review.guard(); this.fresh(review.preparation, review.started);
    await this.write(row => ({ ...row, operation: withMiningStep(row.operation!,ordinal,{signingStarted:true}) }), guard);
    const signed = verifySignedMiningClaim(review.preparation, (await this.ports.sign(review.preparation, guard,ordinal)).wire,ordinal);
    // A late valid signature is evidence, even after logout or an expired quote.
    const old = await this.store.read();
    if (old.operation?.preparation?.claimId !== review.preparation.claimId) throw Error('The original claim changed while the wallet was open.');
    await this.store.compareAndSet(old.revision, row => ({ ...row, operation: withMiningStep(row.operation!,ordinal,{signed}) }));
    guard(); review.guard(); this.reviewValue = null; this.publish({ review: null }); await this.read(guard);
  }); }
  submit(): Promise<void> { return this.action(true, async guard => {
    const op = this.operation(),ordinal=miningClaimOrdinal(op),step=miningClaimStep(op,ordinal); if (step.submitAttempted) throw Error('This signed claim was already submitted. Recover it with Check claim.');
    if (!step.signed) throw Error('Approve and save the original wallet signature first.');
    const started = this.ports.clock(), p = await this.preparation(guard); if (!p) throw Error('The saved preparation is unavailable.');
    await this.claim(guard); if (this.operation().claim?.state === 'settled') return;
    if (this.operation().claim?.state === 'failed') throw Error('The original transaction failed. Archive its verified receipt before preparing another claim.');
    await this.orderedReview(p,ordinal,guard); this.fresh(p, started); await this.ports.live(p, guard,ordinal); this.fresh(p, started);
    const signed = verifySignedMiningClaim(p, step.signed.wire,ordinal);
    await this.write(row => ({ ...row, operation: withMiningStep(row.operation!,ordinal,{submitAttempted:true}) }), guard);
    const result = MiningClaimSubmitResponseSchema.parse(await this.ports.submit({ claimId: p.claimId, signedTransaction: signed.wire }, guard));
    if (result.claimId !== p.claimId || result.signature !== signed.signature) throw Error('The reply differs from the saved claim. Check its original receipt.');
    guard(); await this.claim(guard);
  }); }
  private async retainContinuation(parentId:string,raw:unknown):Promise<void>{
    const envelope=MiningClaimContinuationEnvelopeSchema.parse(raw),old=await this.store.read(),op=old.operation;
    if(envelope.wallet!==this.store.identity.wallet||envelope.parentClaimId!==parentId||op?.preparation?.claimId!==parentId||!op.ordered)throw Error('Continuation belongs to another original.');
    if(!envelope.continuation){if(op.ordered.continuation)throw Error('Saved continuation is temporarily unavailable.');if(op.ordered.continuationRefusal&&!op.ordered.continuationAbsent)await this.store.compareAndSet(old.revision,row=>({...row,operation:{...row.operation!,ordered:{...row.operation!.ordered!,continuationAbsent:true}}}));return;}
    const link=envelope.continuation,hash=(v:string)=>Buffer.from(sha256(Buffer.from(v,'base64'))).toString('hex');
    if(op.preparation.transactions[0]!.kind==='setup'){
      if(!op.signed||op.claim?.transactions[0]?.landing!=='finalized'||op.claim.transactions[0].signature!==op.signed.signature
        ||link.setup.claimId!==parentId||link.setup.signature!==op.signed.signature||link.setup.wireSha256!==hash(op.signed.wire)
        ||link.setup.messageSha256!==hash(op.preparation.transactions[0]!.message))throw Error('Continuation does not preserve the original finalized setup.');
    }else{
      const parent=old.archives.find(a=>a.ordered?.continuation?.childClaimId===parentId)?.ordered?.continuation;
      if(!parent||!same(parent.setup,link.setup))throw Error('Continuation lost its authenticated setup ancestry.');
    }
    const remainder=miningClaimStep(op,op.preparation.transactions.length-1),landing=op.claim?.transactions.at(-1);
    if(link.reason==='unsigned-expired'&&(remainder.signed||op.claim?.state==='settled'))throw Error('A signed remainder cannot be treated as unsigned expiry.');
    if(link.reason==='failed'&&(!remainder.signed||landing?.landing!=='failed'||link.failure?.signature!==remainder.signed.signature
      ||link.failure.wireSha256!==hash(remainder.signed.wire)||link.failure.messageSha256!==hash(op.preparation.transactions.at(-1)!.message)))throw Error('Continuation lacks the original failed remainder.');
    if(op.ordered.continuation){if(!sameMiningContinuation(op.ordered.continuation,link))throw Error('Saved continuation changed.');return;}
    await this.store.compareAndSet(old.revision,row=>({...row,operation:{...row.operation!,ordered:{...row.operation!.ordered!,continuation:link}}}));
  }
  continueClaim():Promise<void>{return this.action(true,async guard=>{
    const op=this.operation();if(!op.ordered||op.preparation?.version!==2||!this.ports.continuation)throw Error('This claim cannot continue.');
    if(op.ordered.held)throw Error('Original receipt verification is held.');
    if(op.ordered.continuationRequest&&(!op.ordered.continuationRefusal||!op.ordered.continuationAbsent))throw Error('Check the original continuation request. Do not repeat it.');
    await this.claim(guard);if(this.operation().claim?.state==='settled')throw Error('This original already paid.');
    const request={idempotencyKey:this.ports.key()};
    await this.write(row=>({...row,operation:{...row.operation!,ordered:{...row.operation!.ordered!,continuationRequest:request,continuationAttempted:false,continuationRefusal:null,continuationAbsent:false,refusedContinuations:[...row.operation!.ordered!.refusedContinuations,...(op.ordered!.continuationRequest?[{...op.ordered!.continuationRequest,...op.ordered!.continuationRefusal!}]:[])]}}}),guard);
    await this.write(row=>({...row,operation:{...row.operation!,ordered:{...row.operation!.ordered!,continuationAttempted:true}}}),guard);
    const retain=(raw:unknown)=>this.retainContinuation(op.preparation!.claimId,raw);
    const refusal=async(value:Refusal)=>{const old=await this.store.read();if(old.operation?.ordered?.continuationRequest?.idempotencyKey!==request.idempotencyKey)throw Error('Original continuation request changed.');await this.store.compareAndSet(old.revision,row=>({...row,operation:{...row.operation!,ordered:{...row.operation!.ordered!,continuationRefusal:value}}}));};
    const raw=await this.ports.continuation(op.preparation.claimId,request,guard,retain,refusal);await retain(raw);guard();await this.read(guard);
  });}
  private async recoverContinuation(guard:Guard):Promise<void>{
    const op=this.operation();if(!op.ordered?.continuationAttempted||!op.preparation||!this.ports.continuation)return;
    const retain=(raw:unknown)=>this.retainContinuation(op.preparation!.claimId,raw);
    const raw=await this.ports.continuation(op.preparation.claimId,null,guard,retain);await retain(raw);guard();await this.read(guard);
  }
  useContinuation():Promise<void>{return this.action(false,async guard=>{
    await this.recoverContinuation(guard);if(this.operation().ordered?.held)throw Error('The original terminal verification remains held.');const link=this.operation().ordered?.continuation;if(!link)throw Error('No verified continuation has been recovered.');
    await this.write(row=>({...row,archives:[...row.archives,row.operation!],operation:continuedMiningOperation(link)}),guard);
    this.reviewValue=null;this.publish({review:null});
  });}
  finish(): Promise<void> { return this.action(false, async guard => {
    if(this.operation().ordered?.held)throw Error('The original terminal verification remains held.');
    await this.claim(guard); if (this.operation().claim?.state !== 'settled') throw Error('Keep this claim until payment is independently finalized.');
    await this.write(row => ({ ...row, operation: null, archives: [...row.archives, row.operation!] }), guard);
    this.reviewValue = null; this.publish({ review: null });
  }); }
  archiveRefusal(): Promise<void> { return this.action(false, async guard => {
    if (!this.operation().prepareRefusal) throw Error('This original preparation has no definitive refusal.');
    if (await this.preparation(guard)) throw Error('The original preparation exists and must be recovered.');
    await this.write(row => ({ ...row, operation: { ...row.operation!, refusalConfirmedAbsent: true } }), guard);
    await this.write(row => ({ ...row, operation: null, archives: [...row.archives, row.operation!] }), guard);
  }); }
  archiveFailed(): Promise<void> { return this.action(false, async guard => {
    if(this.operation().ordered?.held)throw Error('The original terminal verification remains held.');
    const expected = await this.store.read(), failed = expected.operation?.claim;
    if (!expected.operation || !miningClaimArchivableFailure(expected.operation)) throw Error('Check the verified single-transaction failed claim first.');
    const proof = await this.claim(guard); guard();
    if (!proof || !same({ ...failed, serverNow: proof.serverNow }, proof)) throw Error('The failed receipt changed. Keep its recovery record.');
    await this.store.compareAndSet(expected.revision, row => ({ ...row, operation: null, archives: [...row.archives, row.operation!] }));
    await this.read(guard); this.reviewValue = null; this.publish({ review: null });
  }); }
}
