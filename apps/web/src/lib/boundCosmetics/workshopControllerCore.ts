import type { BoundCosmeticAppearance, BoundCosmeticEnvelope, BoundCosmeticRequest } from '@shardkeep/shared/boundCosmeticApi';
import { ApiError } from '../api';
import { matchWorkshopProof, parseWorkshopCommand, sameWorkshopValue, type WorkshopCommand, type WorkshopCommandMode,
  type WorkshopJournal, type WorkshopStore } from './workshopJournal';

export type WorkshopGuard = () => void;
export interface CosmeticWorkshopPorts {
  capture(kind: 'account' | 'base' | 'craft' | 'preference', baseId?: string): WorkshopGuard;
  view(baseId: string | null, guard: WorkshopGuard): Promise<unknown>;
  original(request: BoundCosmeticRequest, guard: WorkshopGuard, retain: (raw: unknown) => Promise<void>): Promise<unknown>;
  start(request: BoundCosmeticRequest, guard: WorkshopGuard, retain: (raw: unknown) => Promise<void>): Promise<unknown>;
  preview(appearance: BoundCosmeticAppearance, guard: WorkshopGuard): Promise<void>;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  key(): string;
}
export type CosmeticWorkshopReview<V> = { command: WorkshopCommand; view: V };
export type CosmeticWorkshopState<V> = { loaded: boolean; busy: boolean; journal: WorkshopJournal | null;
  view: V | null; review: CosmeticWorkshopReview<V> | null; error: string | null; notice: string | null };
function errorCopy(error: unknown): string {
  if (error instanceof ApiError) return 'The request could not be confirmed. Check the original receipt before trying again.';
  if (error instanceof Error && error.name === 'ZodError') return 'Workshop details could not be verified. Refresh and keep your original request.';
  return error instanceof Error ? error.message : 'The Workshop could not refresh. Your saved request remains available.';
}
/** Only the two closed appearance families share this durable action path.
 * Strict current views, facilities and preferences remain in their own adapters. */
export abstract class CosmeticWorkshopController<V> {
  protected state: CosmeticWorkshopState<V> = { loaded: false, busy: false, journal: null, view: null, review: null, error: null, notice: null };
  private reviewGuard: WorkshopGuard | null = null; protected viewGuard: WorkshopGuard | null = null; private epoch = 0; private running = false;
  private readonly listeners = new Set<() => void>();
  protected constructor(readonly store: WorkshopStore, protected readonly ports: CosmeticWorkshopPorts, private readonly mode: WorkshopCommandMode) {}
  protected abstract refreshView(baseId: string | null, guard: WorkshopGuard): Promise<V>;
  protected abstract recipe(view: V, recipeId: string): { recipe: WorkshopCommand['recipe']; appearance: BoundCosmeticAppearance } | undefined;
  protected abstract admitRecipe(view: V, row: { recipe: WorkshopCommand['recipe']; appearance: BoundCosmeticAppearance }): void;
  protected abstract admitOriginal(view: V, command: WorkshopCommand): void;
  snapshot = (): CosmeticWorkshopState<V> => this.state;
  currentView(): V | null { try { if (!this.viewGuard) return null; this.viewGuard(); return this.state.view; } catch { return null; } }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  protected publish(update: Partial<CosmeticWorkshopState<V>>): void { this.state = { ...this.state, ...update }; this.listeners.forEach(f => f()); }
  dismiss(): void { this.epoch++; this.reviewGuard = null; this.viewGuard = null; this.publish({ view: null, review: null, error: null, notice: null }); }
  invalidateBaseView(): void { this.reviewGuard = null; this.viewGuard = null; this.publish({ view: null, review: null }); }
  cancelReview(): void { this.reviewGuard = null; this.publish({ review: null }); }
  protected async action(run: (guard: WorkshopGuard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; const epoch = this.epoch; let guard: WorkshopGuard | null = null;
    try {
      const account = this.ports.capture('account');
      guard = () => { account(); if (epoch !== this.epoch) throw Error('The Workshop view changed.'); };
      guard(); this.publish({ busy: true, error: null, notice: null }); const current = guard;
      await this.ports.lock(`pkw-bound-cosmetics-v1:${this.store.key}`, async () => {
        const journal = await this.store.read(); current(); this.publish({ journal, loaded: true }); await run(current);
      });
    } catch (error) {
      try { guard?.(); if (epoch === this.epoch) { this.reviewGuard = null; this.publish({ review: null, error: errorCopy(error) }); } } catch { /* Obsolete views never publish. */ }
    } finally { this.running = false; if (epoch === this.epoch) this.publish({ busy: false }); }
  }
  protected async readJournal(guard: WorkshopGuard): Promise<WorkshopJournal> {
    const journal = await this.store.read(); guard(); this.publish({ journal, loaded: true }); return journal;
  }
  protected async retain(command: WorkshopCommand, raw: unknown): Promise<void> {
    const proof = matchWorkshopProof(raw, this.store.identity, command, this.mode); if (proof.status !== 'accepted') return;
    const journal = await this.store.read();
    const update = (op: NonNullable<WorkshopJournal['operation']>) => op.command.request.idempotencyKey === command.request.idempotencyKey
      ? { ...op, attempted: true, proof } : op;
    await this.store.compareAndSet(journal.revision, old => ({ ...old, operation: old.operation ? update(old.operation) : null, archives: old.archives.map(update) }));
  }
  protected async observeView(view: V, originals: BoundCosmeticEnvelope[], current: WorkshopGuard): Promise<V> {
    const journal = await this.store.read(); current();
    for (const op of [...journal.archives, ...(journal.operation ? [journal.operation] : [])]) {
      const proof = originals.find(p => p.idempotencyKey === op.command.request.idempotencyKey);
      if (proof) await this.retain(op.command, proof);
    }
    await this.readJournal(current); current(); this.viewGuard = current; this.publish({ view }); return view;
  }
  private async recover(guard: WorkshopGuard): Promise<void> {
    const command = this.state.journal?.operation?.command; if (!command) return;
    const raw = await this.ports.original(command.request, guard, proof => this.retain(command, proof));
    const proof = matchWorkshopProof(raw, this.store.identity, command, this.mode);
    await this.retain(command, proof); await this.readJournal(guard);
    if (proof.status === 'unknown') this.publish({ notice: 'No accepted receipt was found. Keep this request; a missing receipt does not prove it was declined.' });
  }
  open(baseId: string | null): Promise<void> { return this.action(async guard => {
    let failure: unknown;
    try { await this.refreshView(baseId, guard); } catch (error) { guard(); this.publish({ view: null }); failure = error; }
    try { await this.recover(guard); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }); }
  checkOriginal(): Promise<void> { return this.action(guard => this.recover(guard)); }
  checkReceipt(key: string): Promise<void> { return this.action(async guard => {
    const j = this.state.journal!, op = [...j.archives, ...(j.operation ? [j.operation] : [])].find(o => o.command.request.idempotencyKey === key);
    if (!op) throw Error('Refresh account history to read this receipt.');
    const raw = await this.ports.original(op.command.request, guard, value => this.retain(op.command, value));
    const proof = matchWorkshopProof(raw, this.store.identity, op.command, this.mode);
    if (op.proof && proof.status !== 'accepted') throw Error('Previously accepted receipt is unavailable. Saved acceptance remains unchanged.');
    await this.retain(op.command, proof); await this.readJournal(guard);
  }); }
  begin(baseId: string, recipeId: string): Promise<void> { return this.action(async guard => {
    if (this.state.journal?.operation) throw Error('Resolve or archive the saved request before choosing another recipe.');
    const mutation = this.ports.capture('craft', baseId), current = () => { guard(); mutation(); };
    const view = await this.refreshView(baseId, current), row = this.recipe(view, recipeId);
    if (!row) throw Error('This recipe is unavailable. Refresh the Workshop.');
    this.admitRecipe(view, row); await this.ports.preview(row.appearance, current); current();
    const command = parseWorkshopCommand({ request: { idempotencyKey: this.ports.key(), baseId,
      recipeId: row.recipe.recipeId, recipeVersion: row.recipe.recipeVersion, appearanceBindingSha256: row.appearance.bindingSha256 }, ...row }, this.mode);
    current(); const j = this.state.journal!;
    await this.store.compareAndSet(j.revision, old => ({ ...old, operation: { command, attempted: false, proof: null } }));
    await this.readJournal(current); this.reviewGuard = current; this.publish({ review: { command, view } });
  }); }
  reviewOriginal(): Promise<void> { return this.action(async guard => {
    await this.recover(guard); const op = this.state.journal?.operation;
    if (!op || op.proof) return;
    const command = op.command, mutation = this.ports.capture('craft', command.request.baseId), current = () => { guard(); mutation(); };
    const view = await this.refreshView(command.request.baseId, current);
    this.admitOriginal(view, command); await this.ports.preview(command.appearance, current); current(); this.reviewGuard = current; this.publish({ review: { command, view } });
  }); }
  confirm(): Promise<void> {
    const review = this.state.review, reviewed = this.reviewGuard;
    return this.action(async guard => {
      if (!review || !reviewed) throw Error('Review the original request before confirming.');
      const current = () => { guard(); reviewed(); }; current();
      const j = this.state.journal!, op = j.operation;
      if (!op || op.proof || !sameWorkshopValue(op.command, review.command)) throw Error('The saved request changed. Check its original receipt.');
      const view = await this.refreshView(op.command.request.baseId, current);
      if (this.state.journal?.operation?.proof) { this.cancelReview(); return; }
      this.admitOriginal(view, op.command); current();
      await this.ports.preview(op.command.appearance, current); current();
      const updated = await this.store.compareAndSet(this.state.journal!.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } }));
      current(); this.publish({ journal: updated, review: null }); this.reviewGuard = null;
      const raw = await this.ports.start(op.command.request, current, proof => this.retain(op.command, proof));
      const proof = matchWorkshopProof(raw, this.store.identity, op.command, this.mode);
      if (proof.status !== 'accepted') throw Error('The reply did not confirm acceptance. Check the original receipt.');
      await this.retain(op.command, proof); await this.readJournal(current);
      await this.refreshView(op.command.request.baseId, current);
    });
  }
  archive(): Promise<void> { return this.action(async guard => {
    await this.recover(guard); const j = this.state.journal!, op = j.operation;
    if (!op) return;
    if (op.attempted && !op.proof) throw Error('An unknown outcome must stay saved. Check or resend the same original request.');
    guard(); await this.store.compareAndSet(j.revision, old => ({ ...old, operation: null, archives: [...old.archives, old.operation!] }));
    await this.readJournal(guard); this.cancelReview();
  }); }
}
