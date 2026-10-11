import { MiningContributionViewSchema, type MiningContributionRequest, type MiningContributionView } from '@shardkeep/shared/miningContributionApi';
import type { MiningContributionLine } from '@shardkeep/shared/miningContribution';
import { ApiError } from '../api';
import { matchMiningContributionProof, miningContributionRefusalDefinitive, parseMiningContributionCommand, same,
  type MiningContributionCommand, type MiningContributionJournal, type MiningContributionProof, type MiningContributionStore } from './journal';

type Guard = () => void;
export interface MiningContributionPorts {
  get(path: string, guard: Guard): Promise<unknown>;
  /** Original evidence is retained under response ownership before checking an obsolete view. */
  getProof(request: MiningContributionRequest, guard: Guard, retain: (raw: unknown) => Promise<void>): Promise<unknown>;
  post(request: MiningContributionRequest, guard: Guard, retain: (raw: unknown) => Promise<void>,
    observeResponseError: (error: unknown) => Promise<void>, firstAttempt: boolean): Promise<unknown>;
  /** Identity/lifecycle only for historical recovery; selected-base generation and
   * current authority additionally for review and the actual mutation enqueue. */
  capture(baseId?: string): Guard;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  key(): string;
}
export type MiningContributionReview = { command: MiningContributionCommand; view: MiningContributionView };
export type MiningContributionState = { loaded: boolean; busy: boolean; journal: MiningContributionJournal | null;
  review: MiningContributionReview | null; error: string | null };
type Review = MiningContributionReview & { guard: Guard };
/** Display arithmetic uses only this server view's unit values. */
export function contributionTotal(view: MiningContributionView, lines: readonly MiningContributionLine[]): bigint {
  return lines.reduce((sum, line) => {
    const row = view.resources.find(row => row.resourceId === line.resourceId);
    if (!row) throw new Error('This resource is no longer available for mining.');
    return sum + BigInt(line.quantity) * BigInt(row.unitValue);
  }, 0n);
}
function admit(view: MiningContributionView, command: MiningContributionCommand, wallet: string): void {
  if (view.wallet !== wallet || view.baseId !== command.request.baseId) throw new Error('Mining authority is for another wallet or kingdom.');
  if (!view.acceptingContributions) throw new Error('New contributions are paused. Original receipts remain recoverable.');
  if (!view.developmentReady) throw new Error('Complete the minimum mining buildings before contributing resources.');
  if (view.day !== command.request.expectedDay || view.policyVersion !== command.request.policyVersion)
    throw new Error('The mining day or policy changed. Keep the original request for recovery.');
  for (const input of command.request.lines) {
    const stock = view.resources.find(row => row.resourceId === input.resourceId);
    if (!stock || BigInt(stock.available) < BigInt(input.quantity)) throw new Error('There is not enough available stock for this basket.');
  }
  if (view.remainingValue !== null && contributionTotal(view, command.request.lines) > BigInt(view.remainingValue))
    throw new Error('This basket exceeds your remaining daily mining allowance.');
}
export async function miningContributionLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate mining contribution commands across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is handling this mining contribution command.');
    return run();
  });
}
/** Historical evidence never grants resources or publishes live inventory. */
export class MiningContributionController {
  private state: MiningContributionState = { loaded: false, busy: false, journal: null, review: null, error: null };
  private review: Review | null = null; private publicationGuard: Guard | null = null; private running = false; private epoch = 0; private readonly listeners = new Set<() => void>();
  constructor(readonly store: MiningContributionStore, private readonly ports: MiningContributionPorts) {}
  snapshot = (): MiningContributionState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(value: Partial<MiningContributionState>): void { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
  private clearReview(): void { this.review = null; this.publish({ review: null }); }
  dismiss(): void { this.epoch++; this.clearReview(); }
  private command(): MiningContributionCommand {
    const c = this.state.journal?.operation?.command; if (!c) throw new Error('There is no original mining contribution command.'); return c;
  }
  private async action(run: (guard: Guard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; this.publicationGuard = null; let guard: Guard | null = null;
    try {
      const captured = this.ports.capture(), epoch = this.epoch;
      guard = () => { captured(); if (epoch !== this.epoch) throw new Error('The mining contribution view changed.'); };
      guard(); this.publicationGuard = guard; this.publish({ busy: true, error: null }); const current = guard;
      await this.ports.lock(`pkw-mining-contribution-v1:${this.store.key}`, async () => {
        await this.read(current); await run(current);
      });
    } catch (error) {
      this.review = null;
      try { this.publicationGuard?.(); if (this.publicationGuard) this.publish({ review: null, error: error instanceof Error ? error.message : 'Mining contribution recovery is incomplete.' }); } catch { /* obsolete session cannot publish */ }
    } finally { this.running = false; try { this.publicationGuard?.(); if (this.publicationGuard) this.publish({ busy: false }); } catch { /* obsolete view */ } this.publicationGuard = null; }
  }
  private async read(guard: Guard): Promise<void> {
    guard(); this.publicationGuard?.(); const journal = await this.store.read(); guard(); this.publicationGuard?.(); this.publish({ loaded: true, journal });
  }
  private async write(update: (old: MiningContributionJournal) => MiningContributionJournal, guard: Guard): Promise<void> {
    guard(); if (!this.state.journal) throw new Error('Read the original mining contribution journal first.');
    const journal = await this.store.compareAndSet(this.state.journal.revision, update); guard(); this.publish({ journal });
  }
  /** This callback deliberately has no view guard. Complete owned evidence must
   * survive dismissal/logout; the caller only publishes after its own guard. */
  private async retain(command: MiningContributionCommand, raw: unknown): Promise<void> {
    const proof = matchMiningContributionProof(raw, this.store.identity, command), journal = await this.store.read();
    const key = command.request.idempotencyKey;
    const active = journal.operation?.command.request.idempotencyKey === key;
    const index = journal.archives.findIndex(row => row.operation.command.request.idempotencyKey === key);
    const operation = active ? journal.operation : journal.archives[index]?.operation;
    if (!operation || !same(operation.command, command)) throw new Error('The original mining contribution command changed during recovery.');
    if (proof.status === 'unknown') {
      if (operation.proof) throw new Error('The original accepted mining contribution receipt is missing.');
      return;
    }
    if (same(operation.proof, proof)) return;
    await this.store.compareAndSet(journal.revision, old => active
      ? { ...old, operation: { ...old.operation!, proof } }
      : { ...old, archives: old.archives.map((row, i) => i === index ? { ...row, operation: { ...row.operation, proof } } : row) });
  }
  private async recover(command: MiningContributionCommand, guard: Guard): Promise<MiningContributionProof> {
    guard(); const retain = (raw: unknown) => this.retain(command, raw);
    const raw = await this.ports.getProof(command.request, guard, retain);
    // Idempotent when the transport already retained under response ownership.
    await retain(raw); guard(); await this.read(guard);
    return matchMiningContributionProof(raw, this.store.identity, command);
  }
  private async view(baseId: string, guard: Guard): Promise<MiningContributionView> {
    guard(); const raw = await this.ports.get(`/mining/contributions?baseId=${encodeURIComponent(baseId)}&catalogueVersion=3`, guard); guard();
    const view = MiningContributionViewSchema.parse(raw);
    if (view.wallet !== this.store.identity.wallet || view.baseId !== baseId) throw new Error('Mining authority is for another wallet or kingdom.');
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
    const current = this.baseGuard(command.request.baseId, guard), view = await this.view(command.request.baseId, current);
    admit(view, command, this.store.identity.wallet); current();
    this.review = { command, view, guard: current }; this.publish({ review: { command, view } });
  }
  /** Foreground is GET-only, including unfinished accepted archive observations. */
  open(): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal?.operation) await this.recover(this.command(), guard);
    const archives = this.state.journal!.archives.filter(row => row.operation.proof?.settlement === null);
    for (const row of archives) await this.recover(row.operation.command, guard);
  }); }
  begin(baseId: string, lines: MiningContributionLine[]): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal!.operation) throw new Error('Recover the saved contribution before starting another.');
    const current = this.baseGuard(baseId, guard), view = await this.view(baseId, current);
    const command = parseMiningContributionCommand({ request: { idempotencyKey: this.ports.key(), baseId,
      expectedDay: view.day, policyVersion: view.policyVersion, lines } });
    admit(view, command, this.store.identity.wallet);
    await this.write(old => ({ ...old, operation: { command, attemptRevision: null, proof: null, refusal: null } }), current);
    await this.reviewOriginal(guard);
  }); }
  reviewCommand(): Promise<void> { return this.action(guard => this.reviewOriginal(guard)); }
  private assertReview(review: Review, guard: Guard): void {
    guard(); review.guard(); if (!same(review.command, this.command())) throw new Error('Review the original mining contribution command again.');
  }
  /** The sole POST path; original GET recovery precedes every live admission check. */
  confirm(): Promise<void> { return this.action(async guard => {
    const review = this.review, command = this.command();
    if ((await this.recover(command, guard)).status === 'accepted') { this.clearReview(); return; }
    if (!review) throw new Error('Review the original mining contribution command before confirming.');
    if (this.state.journal!.operation!.refusal) throw new Error('A declined original command cannot be resubmitted.');
    this.assertReview(review, guard);
    const current = this.baseGuard(command.request.baseId, guard), view = await this.view(command.request.baseId, current);
    admit(view, command, this.store.identity.wallet); this.assertReview(review, current);
    if (view.pool !== review.view.pool || view.developmentReady !== review.view.developmentReady
      || !same(view.consistency, review.view.consistency) || view.dailyCapValue !== review.view.dailyCapValue)
      throw new Error('Mining qualification or allowance changed. Review the same basket again.');
    const firstAttempt = this.state.journal!.operation!.attemptRevision === null;
    await this.write(old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }), current);
    const attemptRevision = this.state.journal!.revision, retain = (raw: unknown) => this.retain(command, raw);
    const observeResponseError = async (error: unknown) => {
      if (!firstAttempt || !(error instanceof ApiError) || !error.code || !miningContributionRefusalDefinitive(error.status, error.code)) return;
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
    if (!row) throw new Error('Choose an original mining contribution record.');
    await this.recover(row.operation.command, guard);
  }); }
  finish(): Promise<void> { return this.action(async guard => {
    this.clearReview(); if ((await this.recover(this.command(), guard)).status !== 'accepted') throw new Error('Keep the original command until acceptance is recovered.');
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
