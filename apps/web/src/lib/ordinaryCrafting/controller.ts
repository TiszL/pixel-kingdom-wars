import { OrdinaryCraftingViewSchema, type OrdinaryCraftingRequest, type OrdinaryCraftingView } from '@shardkeep/shared/ordinaryCraftingApi';
import { OrdinaryCraftingRecipeSnapshotSchema, type OrdinaryCraftingRecipeSnapshot } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { ApiError } from '../api';
import { matchOrdinaryCraftingProof, ordinaryCraftingRefusalDefinitive, parseOrdinaryCraftingCommand, same,
  type OrdinaryCraftingCommand, type OrdinaryCraftingJournal, type OrdinaryCraftingProof, type OrdinaryCraftingStore } from './journal';

type Guard = () => void;
export interface OrdinaryCraftingPorts {
  get(path: string, guard: Guard): Promise<unknown>;
  /** Original evidence is retained under response ownership before checking an obsolete view. */
  getProof(request: OrdinaryCraftingRequest, guard: Guard, retain: (raw: unknown) => Promise<void>): Promise<unknown>;
  post(request: OrdinaryCraftingRequest, guard: Guard, retain: (raw: unknown) => Promise<void>,
    observeResponseError: (error: unknown) => Promise<void>, firstAttempt: boolean): Promise<unknown>;
  /** Identity/lifecycle only for historical recovery; selected-base generation and
   * current authority additionally for review and the actual mutation enqueue. */
  capture(baseId?: string): Guard;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  key(): string;
}
export type OrdinaryCraftingReview = { command: OrdinaryCraftingCommand; view: OrdinaryCraftingView };
export type OrdinaryCraftingState = { loaded: boolean; busy: boolean; journal: OrdinaryCraftingJournal | null;
  review: OrdinaryCraftingReview | null; error: string | null };
type Review = OrdinaryCraftingReview & { guard: Guard };
/** Exact display scaling of server per-unit terms. The server authorizes conversion. */
export function ordinaryCraftingBatch(recipe: OrdinaryCraftingRecipeSnapshot, quantity: number): OrdinaryCraftingRecipeSnapshot {
  if (recipe.quantity !== 1 || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Choose a positive whole refining quantity.');
  const scale = (value: string) => (BigInt(value) * BigInt(quantity)).toString();
  return OrdinaryCraftingRecipeSnapshotSchema.parse({ ...recipe, quantity, durationSec: recipe.durationSec * quantity,
    inputs: recipe.inputs.map(input => ({ ...input, quantity: scale(input.quantity) })), output: { ...recipe.output, quantity: scale(recipe.output.quantity) } });
}
function admit(view: OrdinaryCraftingView, command: OrdinaryCraftingCommand, wallet: string): void {
  if (view.wallet !== wallet || view.baseId !== command.request.baseId) throw new Error('Refining authority is for another wallet or base.');
  if (!view.acceptingJobs || view.pendingJobs.length) throw new Error('New refining is unavailable. Original receipts remain recoverable.');
  const unit = view.recipes.find(recipe => recipe.recipeId === command.request.recipeId);
  if (command.request.recipeVersion !== view.recipeVersion || command.request.quantity > view.maxBatch || !unit
    || !same(ordinaryCraftingBatch(unit, command.request.quantity), command.recipe)) throw new Error('The reviewed refining recipe changed.');
  for (const input of command.recipe.inputs) {
    const available = input.kind === 'shards' ? ('shardsAvailable' in view ? view.shardsAvailable : null)
      : (input.kind === 'raw' ? view.rawStock.find(row => row.resourceId === input.itemId) : view.craftingStock.find(row => row.itemId === input.itemId))?.available;
    if (available == null || BigInt(available) < BigInt(input.quantity)) throw new Error('The reviewed crafting ingredients are unavailable.');
  }
  const output = view.craftingStock.find(row => row.itemId === command.recipe.output.itemId)!;
  // Storage domain, not a game tuning value. Shared wire quantities are signed int64.
  if (BigInt(output.available) + BigInt(output.pendingOutput) + BigInt(command.recipe.output.quantity) > RAW_RESOURCE_STORAGE_MAX)
    throw new Error('There is no protected storage space for the reviewed output.');
}
export async function ordinaryCraftingLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate refining commands across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is handling this refining command.');
    return run();
  });
}
/** Historical evidence never grants resources or publishes live inventory. */
export class OrdinaryCraftingController {
  private state: OrdinaryCraftingState = { loaded: false, busy: false, journal: null, review: null, error: null };
  private review: Review | null = null; private publicationGuard: Guard | null = null; private running = false; private epoch = 0; private readonly listeners = new Set<() => void>();
  constructor(readonly store: OrdinaryCraftingStore, private readonly ports: OrdinaryCraftingPorts) {}
  snapshot = (): OrdinaryCraftingState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(value: Partial<OrdinaryCraftingState>): void { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
  private clearReview(): void { this.review = null; this.publish({ review: null }); }
  dismiss(): void { this.epoch++; this.clearReview(); }
  private command(): OrdinaryCraftingCommand {
    const c = this.state.journal?.operation?.command; if (!c) throw new Error('There is no original refining command.'); return c;
  }
  private async action(run: (guard: Guard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; this.publicationGuard = null; let guard: Guard | null = null;
    try {
      const captured = this.ports.capture(), epoch = this.epoch;
      guard = () => { captured(); if (epoch !== this.epoch) throw new Error('The refining view changed.'); };
      guard(); this.publicationGuard = guard; this.publish({ busy: true, error: null }); const current = guard;
      await this.ports.lock(`pkw-ordinary-crafting-v1:${this.store.key}`, async () => {
        await this.read(current); await run(current);
      });
    } catch (error) {
      this.review = null;
      try { this.publicationGuard?.(); if (this.publicationGuard) this.publish({ review: null, error: error instanceof Error ? error.message : 'Refining recovery is incomplete.' }); } catch { /* obsolete session cannot publish */ }
    } finally { this.running = false; try { this.publicationGuard?.(); if (this.publicationGuard) this.publish({ busy: false }); } catch { /* obsolete view */ } this.publicationGuard = null; }
  }
  private async read(guard: Guard): Promise<void> {
    guard(); this.publicationGuard?.(); const journal = await this.store.read(); guard(); this.publicationGuard?.(); this.publish({ loaded: true, journal });
  }
  private async write(update: (old: OrdinaryCraftingJournal) => OrdinaryCraftingJournal, guard: Guard): Promise<void> {
    guard(); if (!this.state.journal) throw new Error('Read the original refining journal first.');
    const journal = await this.store.compareAndSet(this.state.journal.revision, update); guard(); this.publish({ journal });
  }
  /** This callback deliberately has no view guard. Complete owned evidence must
   * survive dismissal/logout; the caller only publishes after its own guard. */
  private async retain(command: OrdinaryCraftingCommand, raw: unknown): Promise<void> {
    const proof = matchOrdinaryCraftingProof(raw, this.store.identity, command), journal = await this.store.read();
    const key = command.request.idempotencyKey;
    const active = journal.operation?.command.request.idempotencyKey === key;
    const index = journal.archives.findIndex(row => row.operation.command.request.idempotencyKey === key);
    const operation = active ? journal.operation : journal.archives[index]?.operation;
    if (!operation || !same(operation.command, command)) throw new Error('The original refining command changed during recovery.');
    if (proof.status === 'unknown') {
      if (operation.proof) throw new Error('The original accepted refining receipt is missing.');
      return;
    }
    if (same(operation.proof, proof)) return;
    await this.store.compareAndSet(journal.revision, old => active
      ? { ...old, operation: { ...old.operation!, proof } }
      : { ...old, archives: old.archives.map((row, i) => i === index ? { ...row, operation: { ...row.operation, proof } } : row) });
  }
  private async recover(command: OrdinaryCraftingCommand, guard: Guard): Promise<OrdinaryCraftingProof> {
    guard(); const retain = (raw: unknown) => this.retain(command, raw);
    const raw = await this.ports.getProof(command.request, guard, retain);
    // Idempotent when the transport already retained under response ownership.
    await retain(raw); guard(); await this.read(guard);
    return matchOrdinaryCraftingProof(raw, this.store.identity, command);
  }
  private async view(baseId: string, guard: Guard, catalogueVersion = 2): Promise<OrdinaryCraftingView> {
    guard(); const base = await this.ports.get(`/base?baseId=${encodeURIComponent(baseId)}`, guard); guard();
    const b = base as { baseId?: unknown; player?: { wallet?: unknown }; buildings?: unknown[] } | null;
    if (!b || b.baseId !== baseId || b.player?.wallet !== this.store.identity.wallet || !Array.isArray(b.buildings)
      || !b.buildings.some(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
        const building = raw as Record<string, unknown>;
        return building.type === 'workshop' && Number.isSafeInteger(building.level) && (building.level as number) > 0 && building.underConstruction === false;
      })) throw new Error('A completed Workshop on the current base is required for new refining.');
    const raw = await this.ports.get(`/ordinary-crafting?baseId=${encodeURIComponent(baseId)}${catalogueVersion === 2 ? '&catalogueVersion=2' : ''}`, guard); guard();
    const view = OrdinaryCraftingViewSchema.parse(raw);
    if (view.wallet !== this.store.identity.wallet || view.baseId !== baseId) throw new Error('Refining authority is for another wallet or base.');
    if (catalogueVersion === 2 ? !('catalogueVersion' in view) || view.catalogueVersion !== 2 : 'catalogueVersion' in view)
      throw new Error('The Workshop catalogue did not match the requested review.');
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
    const current = this.baseGuard(command.request.baseId, guard), view = await this.view(command.request.baseId, current, command.request.recipeVersion);
    admit(view, command, this.store.identity.wallet); current();
    this.review = { command, view, guard: current }; this.publish({ review: { command, view } });
  }
  /** Foreground is GET-only, including unfinished accepted archive observations. */
  open(): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal?.operation) await this.recover(this.command(), guard);
    const archives = this.state.journal!.archives.filter(row => row.operation.proof?.completion === null);
    for (const row of archives) await this.recover(row.operation.command, guard);
  }); }
  beginStart(baseId: string, recipeId: string, quantity: number): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal!.operation) throw new Error('Recover the original refining command before starting another.');
    const current = this.baseGuard(baseId, guard), view = await this.view(baseId, current);
    const unit = view.recipes.find(recipe => recipe.recipeId === recipeId); if (!unit) throw new Error('Choose an available server recipe.');
    const command = parseOrdinaryCraftingCommand({ request: { idempotencyKey: this.ports.key(), baseId, recipeId, recipeVersion: view.recipeVersion, quantity }, recipe: ordinaryCraftingBatch(unit, quantity) });
    admit(view, command, this.store.identity.wallet);
    await this.write(old => ({ ...old, operation: { command, attemptRevision: null, proof: null, refusal: null } }), current);
    await this.reviewOriginal(guard);
  }); }
  reviewCommand(): Promise<void> { return this.action(guard => this.reviewOriginal(guard)); }
  private assertReview(review: Review, guard: Guard): void {
    guard(); review.guard(); if (!same(review.command, this.command())) throw new Error('Review the original refining command again.');
  }
  /** The sole POST path; original GET recovery precedes every live admission check. */
  confirm(): Promise<void> { return this.action(async guard => {
    const review = this.review, command = this.command();
    if ((await this.recover(command, guard)).status === 'accepted') { this.clearReview(); return; }
    if (!review) throw new Error('Review the original refining command before confirming.');
    if (this.state.journal!.operation!.refusal) throw new Error('A declined original command cannot be resubmitted.');
    this.assertReview(review, guard);
    const current = this.baseGuard(command.request.baseId, guard), view = await this.view(command.request.baseId, current, command.request.recipeVersion);
    admit(view, command, this.store.identity.wallet); this.assertReview(review, current);
    const firstAttempt = this.state.journal!.operation!.attemptRevision === null;
    await this.write(old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }), current);
    const attemptRevision = this.state.journal!.revision, retain = (raw: unknown) => this.retain(command, raw);
    const observeResponseError = async (error: unknown) => {
      if (!firstAttempt || !(error instanceof ApiError) || !error.code || !ordinaryCraftingRefusalDefinitive(error.status, error.code)) return;
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
    if (!row) throw new Error('Choose an original refining record.');
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
