import { TrainingFinishIntentSchema, trainingFinishBody, trainingFinishReceiptPath, matchTrainingFinishProof,
  type TrainingFinishIntent, type TrainingFinishProof } from '@shardkeep/shared/trainingFinish';
import { parseTrainingRefusal, same, type TrainingFinishJournal, type TrainingFinishStore, type TrainingRefusal } from './journal';
type Guard = () => void;
export type TrainingReviewInput = Pick<TrainingFinishIntent, 'baseId'>;
export interface TrainingFinishPorts {
  /** Guards are repeated at actual transport, including after auth-cookie waits. */
  get(path: string, guard: Guard): Promise<unknown>;
  post(path: string, body: unknown, currency: TrainingFinishIntent['expectedCurrency'], guard: Guard, observeResponseError?: (error: unknown) => Promise<void>): Promise<unknown>;
  capture(baseId?: string | null): Guard;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  key(): string;
  /** Fresh owned roster and balances determine price/episode/currency. */
  prepare(input: TrainingReviewInput, key: string, guard: Guard): Promise<TrainingFinishIntent>;
  /** May refuse changed authority/episode/price/funds; must never switch currency. */
  validate(intent: TrainingFinishIntent, guard: Guard): Promise<void>;
  definitiveRefusal(error: unknown, intent: TrainingFinishIntent): TrainingRefusal | null;
}
export type TrainingFinishState = { loaded: boolean; busy: boolean; journal: TrainingFinishJournal | null; review: TrainingFinishIntent | null; error: string | null };
export async function trainingFinishLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate Training commands across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is handling this Training command.'); return run();
  });
}
/** Automatic recovery is GET-only. The receipt is historical evidence, never a
 * source for current roster/balance publication. The UI refreshes these separately. */
export class TrainingFinishController {
  private state: TrainingFinishState = { loaded: false, busy: false, journal: null, review: null, error: null };
  private approval: { intent: TrainingFinishIntent; guard: Guard } | null = null;
  private running = false; private epoch = 0; private readonly listeners = new Set<() => void>();
  constructor(readonly store: TrainingFinishStore, private readonly ports: TrainingFinishPorts) {}
  snapshot = (): TrainingFinishState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(value: Partial<TrainingFinishState>): void { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
  private clearReview(): void { this.approval = null; this.publish({ review: null }); }
  dismiss(): void { this.epoch++; this.clearReview(); }
  private intent(): TrainingFinishIntent { const intent = this.state.journal?.operation?.intent; if (!intent) throw new Error('There is no original Training command.'); return intent; }
  private async action(baseId: string | null | undefined, run: (guard: Guard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; let guard: Guard | null = null;
    try {
      const captured = this.ports.capture(baseId), epoch = this.epoch;
      guard = () => { captured(); if (epoch !== this.epoch) throw new Error('The Training view changed.'); };
      guard(); this.publish({ busy: true, error: null }); const current = guard;
      await this.ports.lock(`pkw-training-finish-v1:${this.store.key}`, async () => {
        current(); const journal = await this.store.read(); current(); this.publish({ loaded: true, journal }); await run(current);
      });
    } catch (error) {
      this.approval = null;
      try { guard?.(); if (guard) this.publish({ review: null, error: error instanceof Error ? error.message : 'Training recovery is incomplete.' }); } catch { /* obsolete session */ }
    } finally {
      this.running = false;
      // This controller owns no global state. Dismissal must not strand its busy
      // bit when a request's guard expires; remount still performs GET-only open.
      this.publish({ busy: false });
    }
  }
  private async write(update: (old: TrainingFinishJournal) => TrainingFinishJournal, guard: Guard): Promise<void> {
    guard(); if (!this.state.journal) throw new Error('Read the original Training journal first.');
    const journal = await this.store.compareAndSet(this.state.journal.revision, update); guard(); this.publish({ journal });
  }
  private async recover(guard: Guard): Promise<TrainingFinishProof> {
    const intent = this.intent(); guard(); const raw = await this.ports.get(trainingFinishReceiptPath({ baseId: intent.baseId, idempotencyKey: intent.idempotencyKey }), guard); guard();
    const proof = matchTrainingFinishProof(raw, this.store.identity.wallet, intent), saved = this.state.journal!.operation!;
    if (saved.refusal && proof.status === 'accepted') throw new Error('The refused Training command has conflicting acceptance evidence. Keep its original record.');
    if (saved.proof) {
      if (proof.status !== 'accepted' || !same(saved.proof, proof)) throw new Error('The original accepted Training receipt changed or is missing.');
    } else if (proof.status === 'accepted') await this.write(old => ({ ...old, operation: { ...old.operation!, proof } }), guard);
    return proof;
  }
  open(): Promise<void> { return this.action(undefined, async guard => { this.clearReview(); if (this.state.journal?.operation) await this.recover(guard); }); }
  begin(input: TrainingReviewInput): Promise<void> {
    return this.action(input.baseId, async guard => {
      this.clearReview(); if (this.state.journal?.operation) throw new Error('Finish the original Training command before reviewing another.');
      const key = this.ports.key(), intent = TrainingFinishIntentSchema.parse(await this.ports.prepare(input, key, guard)); guard();
      if (intent.idempotencyKey !== key || intent.baseId !== input.baseId) throw new Error('The Training review changed its original target.');
      // Unsupported receipt routes fail closed before saving or paying.
      const proof = matchTrainingFinishProof(await this.ports.get(trainingFinishReceiptPath({ baseId: intent.baseId, idempotencyKey: intent.idempotencyKey }), guard), this.store.identity.wallet, intent); guard();
      await this.write(old => ({ ...old, operation: { intent, attempted: false, proof: proof.status === 'accepted' ? proof : null, refusal: null } }), guard);
      if (proof.status === 'accepted') return;
      await this.reviewOriginal(guard);
    });
  }
  private async reviewOriginal(guard: Guard): Promise<void> {
    this.clearReview(); if ((await this.recover(guard)).status === 'accepted') return;
    if (this.state.journal!.operation!.refusal) throw new Error('This original command was refused. Archive its record before reviewing again.');
    const intent = this.intent(); await this.ports.validate(intent, guard); guard();
    this.approval = { intent, guard }; this.publish({ review: intent });
  }
  reviewCommand(): Promise<void> { return this.action(this.state.journal?.operation?.intent.baseId, guard => this.reviewOriginal(guard)); }
  confirm(): Promise<void> {
    return this.action(this.state.journal?.operation?.intent.baseId, async guard => {
      const approval = this.approval;
      const approved = () => { guard(); if (!approval || approval !== this.approval || !same(approval.intent, this.intent())) throw new Error('Review the original Training command before confirming.'); approval.guard(); };
      approved(); if ((await this.recover(approved)).status === 'accepted') { this.clearReview(); return; }
      if (this.state.journal!.operation!.refusal) throw new Error('This original Training command was refused.');
      const intent = this.intent(); await this.ports.validate(intent, approved); approved();
      const firstAttempt = !this.state.journal!.operation!.attempted;
      await this.write(old => ({ ...old, operation: { ...old.operation!, attempted: true } }), approved); approved();
      const attemptRevision = this.state.journal!.revision;
      // Evidence belongs to the original dispatch even if an account/navigation
      // change makes its response unpresentable. Transport invokes this before
      // lifecycle rejection; normal catch remains a fallback for direct ports.
      let refusedJournal: TrainingFinishJournal | null = null;
      const observeResponseError = async (error: unknown) => {
        if (!firstAttempt || refusedJournal) return;
        const refusal = this.ports.definitiveRefusal(error, intent);
        if (refusal) refusedJournal = await this.store.compareAndSet(attemptRevision, old => ({ ...old, operation: { ...old.operation!, refusal: parseTrainingRefusal(refusal) } }));
      };
      // Do not clear approval until its guard reaches the actual fetch.
      try { await this.ports.post('/army/train/speedup', trainingFinishBody(intent), intent.expectedCurrency, approved, observeResponseError); }
      catch (error) {
        await observeResponseError(error);
        if (refusedJournal) { approved(); this.publish({ journal: refusedJournal }); }
        throw error;
      }
      approved(); await this.recover(approved); this.clearReview();
      if (!this.state.journal!.operation!.proof) throw new Error('The original Training payment is not yet proven. Check its receipt; do not pay again.');
    });
  }
  finish(): Promise<void> {
    return this.action(undefined, async guard => {
      const op = this.state.journal?.operation; if (!op) throw new Error('There is no original Training command.');
      if (!op.proof && !op.refusal) throw new Error('An uncertain Training command must remain saved.');
      await this.recover(guard);
      await this.write(old => ({ ...old, operation: null, archives: [...old.archives, { operation: old.operation!, reason: old.operation!.proof ? 'accepted' : 'refused', evidence: null }] }), guard);
      this.clearReview();
    });
  }
  abandon(): Promise<void> {
    return this.action(undefined, async guard => {
      const op = this.state.journal?.operation; if (!op || op.attempted || op.proof || op.refusal) throw new Error('Only a never-attempted Training draft can be abandoned.');
      const evidence = await this.recover(guard);
      if (evidence.status !== 'unknown') throw new Error('This Training command was accepted; keep its receipt.');
      await this.write(old => ({ ...old, operation: null, archives: [...old.archives, { operation: old.operation!, reason: 'unattempted', evidence }] }), guard); this.clearReview();
    });
  }
}
