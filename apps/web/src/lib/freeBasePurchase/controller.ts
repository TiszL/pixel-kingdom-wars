import { FreeBasePurchaseViewSchema, type FreeBasePurchaseRequest, type FreeBasePurchaseView } from '@shardkeep/shared/freeBasePurchaseApi';
import { ApiError } from '../api';
import { matchFreeBasePurchaseProof, freeBasePurchaseRefusalDefinitive, parseFreeBasePurchaseCommand, same,
  type FreeBasePurchaseCommand, type FreeBasePurchaseJournal, type FreeBasePurchaseProof, type FreeBasePurchaseStore } from './journal';

type Guard = () => void;
export interface FreeBasePurchasePorts {
  get(path: string, guard: Guard): Promise<unknown>;
  /** Original evidence is retained under response ownership before checking an obsolete view. */
  getProof(request: FreeBasePurchaseRequest, guard: Guard, retain: (raw: unknown) => Promise<void>): Promise<unknown>;
  post(request: FreeBasePurchaseRequest, guard: Guard, retain: (raw: unknown) => Promise<void>,
    observeResponseError: (error: unknown) => Promise<void>, firstAttempt: boolean): Promise<unknown>;
  /** Identity/lifecycle only for historical recovery; selected-base generation and
   * current authority additionally for review and the actual mutation enqueue. */
  capture(baseId?: string): Guard;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  key(): string;
}
export type FreeBasePurchaseReview = { command: FreeBasePurchaseCommand; view: FreeBasePurchaseView };
export type FreeBasePurchaseState = { loaded: boolean; busy: boolean; journal: FreeBasePurchaseJournal | null;
  review: FreeBasePurchaseReview | null; error: string | null };
type Review = FreeBasePurchaseReview & { guard: Guard };
function admit(view: FreeBasePurchaseView, command: FreeBasePurchaseCommand, wallet: string): void {
  if (view.wallet !== wallet || view.sourceBaseId !== command.request.sourceBaseId) throw new Error('Purchase authority is for another wallet or source kingdom.');
  if (!view.enabled || !view.admission.allowed) throw new Error('New purchase unavailable: ' + view.admission.reason + '. Saved receipts remain recoverable.');
  if (!same(view.terms, command.terms)) throw new Error('Reviewed purchase terms changed. Keep the original request.');
}
export async function freeBasePurchaseLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate second free base purchase commands across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is handling this second free base purchase command.');
    return run();
  });
}
/** Historical evidence never grants resources or publishes live inventory. */
export class FreeBasePurchaseController {
  private state: FreeBasePurchaseState = { loaded: false, busy: false, journal: null, review: null, error: null };
  private review: Review | null = null; private publicationGuard: Guard | null = null; private running = false; private epoch = 0; private readonly listeners = new Set<() => void>();
  constructor(readonly store: FreeBasePurchaseStore, private readonly ports: FreeBasePurchasePorts) {}
  snapshot = (): FreeBasePurchaseState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(value: Partial<FreeBasePurchaseState>): void { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
  private clearReview(): void { this.review = null; this.publish({ review: null }); }
  dismiss(): void { this.epoch++; this.clearReview(); }
  private command(): FreeBasePurchaseCommand {
    const c = this.state.journal?.operation?.command; if (!c) throw new Error('There is no original second free base purchase command.'); return c;
  }
  private async action(run: (guard: Guard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; this.publicationGuard = null; let guard: Guard | null = null;
    try {
      const captured = this.ports.capture(), epoch = this.epoch;
      guard = () => { captured(); if (epoch !== this.epoch) throw new Error('The second free base purchase view changed.'); };
      guard(); this.publicationGuard = guard; this.publish({ busy: true, error: null }); const current = guard;
      await this.ports.lock(`pkw-free-base-purchase-v1:${this.store.key}`, async () => {
        await this.read(current); await run(current);
      });
    } catch (error) {
      this.review = null;
      try { this.publicationGuard?.(); if (this.publicationGuard) this.publish({ review: null, error: error instanceof Error ? error.message : 'Second free base purchase recovery is incomplete.' }); } catch { /* obsolete session cannot publish */ }
    } finally { this.running = false; try { this.publicationGuard?.(); if (this.publicationGuard) this.publish({ busy: false }); } catch { /* obsolete view */ } this.publicationGuard = null; }
  }
  private async read(guard: Guard): Promise<void> {
    guard(); this.publicationGuard?.(); const journal = await this.store.read(); guard(); this.publicationGuard?.(); this.publish({ loaded: true, journal });
  }
  private async write(update: (old: FreeBasePurchaseJournal) => FreeBasePurchaseJournal, guard: Guard): Promise<void> {
    guard(); if (!this.state.journal) throw new Error('Read the original second free base purchase journal first.');
    const journal = await this.store.compareAndSet(this.state.journal.revision, update); guard(); this.publish({ journal });
  }
  /** This callback deliberately has no view guard. Complete owned evidence must
   * survive dismissal/logout; the caller only publishes after its own guard. */
  private async retain(command: FreeBasePurchaseCommand, raw: unknown): Promise<void> {
    const proof = matchFreeBasePurchaseProof(raw, this.store.identity, command), journal = await this.store.read();
    const key = command.request.idempotencyKey;
    const active = journal.operation?.command.request.idempotencyKey === key;
    const index = journal.archives.findIndex(row => row.operation.command.request.idempotencyKey === key);
    const operation = active ? journal.operation : journal.archives[index]?.operation;
    if (!operation || !same(operation.command, command)) throw new Error('The original second free base purchase command changed during recovery.');
    if (proof.status === 'unknown') {
      if (operation.proof) throw new Error('The original accepted second free base purchase receipt is missing.');
      return;
    }
    if (same(operation.proof, proof)) return;
    await this.store.compareAndSet(journal.revision, old => active
      ? { ...old, operation: { ...old.operation!, proof } }
      : { ...old, archives: old.archives.map((row, i) => i === index ? { ...row, operation: { ...row.operation, proof } } : row) });
  }
  private async recover(command: FreeBasePurchaseCommand, guard: Guard): Promise<FreeBasePurchaseProof> {
    guard(); const retain = (raw: unknown) => this.retain(command, raw);
    const raw = await this.ports.getProof(command.request, guard, retain);
    // Idempotent when the transport already retained under response ownership.
    await retain(raw); guard(); await this.read(guard);
    return matchFreeBasePurchaseProof(raw, this.store.identity, command);
  }
  private async view(baseId: string, guard: Guard): Promise<FreeBasePurchaseView> {
    guard(); const raw = await this.ports.get(`/bases/free-purchases?sourceBaseId=${encodeURIComponent(baseId)}`, guard); guard();
    const view = FreeBasePurchaseViewSchema.parse(raw);
    if (view.wallet !== this.store.identity.wallet || view.sourceBaseId !== baseId) throw new Error('Second free base purchase authority is for another wallet or base.');
    return view;
  }
  private baseGuard(baseId: string, guard: Guard): Guard {
    const base = this.ports.capture(baseId), current = () => { guard(); base(); };
    this.publicationGuard = current; return current;
  }
  private async reviewOriginal(guard: Guard): Promise<void> {
    this.clearReview(); const command = this.command();
    if ((await this.recover(command, guard)).status === 'accepted') return;
    if (this.state.journal!.operation!.refusal) throw new Error('The original request was declined. Explicitly archive its refusal before starting another.');
    const current = this.baseGuard(command.request.sourceBaseId, guard), view = await this.view(command.request.sourceBaseId, current);
    admit(view, command, this.store.identity.wallet); current();
    this.review = { command, view, guard: current }; this.publish({ review: { command, view } });
  }
  /** This purchase has no later completion event. Foreground recovers the active
   * original only; any archived outcome remains explicitly checkable by GET. */
  open(): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal?.operation) await this.recover(this.command(), guard);
  }); }
  beginPurchase(baseId: string): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal!.operation) throw new Error('Recover the original purchase before starting another.');
    const current = this.baseGuard(baseId, guard), view = await this.view(baseId, current);
    const command = parseFreeBasePurchaseCommand({ request: { idempotencyKey: this.ports.key(), sourceBaseId: baseId }, terms: view.terms });
    admit(view, command, this.store.identity.wallet);
    await this.write(old => ({ ...old, operation: { command, attemptRevision: null, proof: null, refusal: null } }), current);
    await this.reviewOriginal(guard);
  }); }
  reviewCommand(): Promise<void> { return this.action(guard => this.reviewOriginal(guard)); }
  private assertReview(review: Review, guard: Guard): void {
    guard(); review.guard(); if (!same(review.command, this.command())) throw new Error('Review the original second free base purchase command again.');
  }
  /** The sole POST path; original GET recovery precedes every live admission check. */
  confirm(): Promise<void> { return this.action(async guard => {
    const review = this.review, command = this.command();
    if ((await this.recover(command, guard)).status === 'accepted') { this.clearReview(); return; }
    if (!review) throw new Error('Review the original second free base purchase command before confirming.');
    if (this.state.journal!.operation!.refusal) throw new Error('A declined original command cannot be resubmitted.');
    this.assertReview(review, guard);
    const current = this.baseGuard(command.request.sourceBaseId, guard), view = await this.view(command.request.sourceBaseId, current);
    admit(view, command, this.store.identity.wallet); this.assertReview(review, current);
    const firstAttempt = this.state.journal!.operation!.attemptRevision === null;
    await this.write(old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }), current);
    const attemptRevision = this.state.journal!.revision, retain = (raw: unknown) => this.retain(command, raw);
    const observeResponseError = async (error: unknown) => {
      if (!firstAttempt || !(error instanceof ApiError) || !error.code || !freeBasePurchaseRefusalDefinitive(error.status, error.code)) return;
      const journal = await this.store.read();
      if (journal.revision !== attemptRevision || journal.operation?.attemptRevision !== attemptRevision || journal.operation.proof
        || !same(journal.operation.command, command)) return;
      await this.store.compareAndSet(attemptRevision, old => ({ ...old, operation: { ...old.operation!, refusal: { phase: 'first_post', status: error.status, code: error.code! } } }));
    };
    const sendGuard = () => this.assertReview(review, current); this.clearReview(); sendGuard();
    try {
      const raw = await this.ports.post(command.request, sendGuard, retain, observeResponseError, firstAttempt);
      await retain(raw); sendGuard(); await this.read(sendGuard);
    } catch (error) {
      await observeResponseError(error); sendGuard(); await this.read(sendGuard); throw error;
    }
  }); }
  checkArchived(key: string): Promise<void> { return this.action(async guard => {
    this.clearReview(); const row = this.state.journal!.archives.find(row => row.operation.command.request.idempotencyKey === key);
    if (!row) throw new Error('Choose an original second free base purchase record.');
    await this.recover(row.operation.command, guard);
  }); }
  finish(hydrate: (guard: Guard) => Promise<void>): Promise<void> { return this.action(async guard => {
    this.clearReview(); if ((await this.recover(this.command(), guard)).status !== 'accepted') throw new Error('Keep the original command until acceptance is recovered.');
    await hydrate(guard); guard();
    await this.write(old => ({ ...old, operation: null, archives: [...old.archives, { operation: old.operation!, reason: 'accepted', evidence: null }] }), guard);
  }); }
  archiveRefusal(): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (!this.state.journal!.operation?.refusal) throw new Error('Only a definitive first-request refusal can be archived.');
    const evidence = await this.recover(this.command(), guard);
    if (evidence.status !== 'unknown') throw new Error('The original request was accepted. Keep its receipt.');
    await this.write(old => ({ ...old, operation: null, archives: [...old.archives, { operation: old.operation!, reason: 'refused', evidence }] }), guard);
  }); }
  abandonDraft(): Promise<void> { return this.action(async guard => {
    this.clearReview(); this.command(); if (this.state.journal!.operation!.attemptRevision !== null) throw new Error('An attempted command must stay in recovery.');
    const evidence = await this.recover(this.command(), guard);
    if (evidence.status !== 'unknown') throw new Error('The original request was accepted. Keep its receipt.');
    await this.write(old => ({ ...old, operation: null, archives: [...old.archives, { operation: old.operation!, reason: 'unattempted', evidence }] }), guard);
  }); }
}
