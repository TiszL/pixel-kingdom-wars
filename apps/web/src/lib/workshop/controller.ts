import { WorkshopViewSchema, type WorkshopView } from '@shardkeep/shared/workshop';
import { ApiError } from '../api';
import { matchWorkshopProof, parseWorkshopCommand, same, workshopBase, workshopRefusalDefinitive, type WorkshopCommand, type WorkshopJournal, type WorkshopProof, type WorkshopStore } from './journal';

type Guard = () => void;
type Clock = { elapsed: number; wall: number };
export interface WorkshopPorts {
  /** GET/POST must call guard at the actual transport, including after any auth wait. */
  get(path: string, guard: Guard): Promise<unknown>;
  post(path: string, body: unknown, guard: Guard, observeResponseError?: (error: unknown) => Promise<void>): Promise<unknown>;
  /** A mutation guard binds current selected base/selection epoch in addition
   * to wallet/session/lifecycle. Receipt recovery has no selected-base dependency. */
  capture(baseId?: string): Guard;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  clock(): Clock;
  key(): string;
}
export type WorkshopReview = { command: WorkshopCommand; view: WorkshopView };
export type WorkshopState = { loaded: boolean; busy: boolean; journal: WorkshopJournal | null; review: WorkshopReview | null; error: string | null };
type Review = WorkshopReview & { guard: Guard; started: Clock };
const proofPath = (c: WorkshopCommand) => c.kind === 'start' ? `/workshop/jobs/by-key/${encodeURIComponent(c.request.idempotencyKey)}`
  : `/workshop/jobs/${encodeURIComponent(c.jobId)}/collect/by-key/${encodeURIComponent(c.request.idempotencyKey)}`;
function consent(view: WorkshopView, command: WorkshopCommand): unknown {
  if (view.inventory.baseId !== workshopBase(command)) throw new Error('Workshop authority is for another base.');
  if (command.kind === 'collect') {
    const job = view.jobs.find(j => j.jobId === command.jobId);
    if (!job || !job.ready || job.collectedAt !== null) throw new Error('The original job is not available to collect. Check its receipt.');
    return job;
  }
  if (!view.acceptingJobs || !view.level) throw new Error('New Workshop refining is unavailable. Paid receipts remain recoverable.');
  const r = command.request;
  if (r.recipeVersion !== view.recipeVersion || r.ingots > view.batch.size || r.ingots > view.allowance.daily.remaining || r.ingots > view.allowance.holding.remaining) throw new Error('The original recipe or refining allowance is unavailable.');
  return { level: view.level, recipeVersion: view.recipeVersion, shardsPerIngot: view.shardsPerIngot, batch: view.batch, secPerIngot: view.secPerIngot, allowance: view.allowance };
}
export async function workshopLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate Workshop commands across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is handling this Workshop command.');
    return run();
  });
}
/** Receipt state is historical evidence only. This controller never publishes a
 * receipt's quantity/held value as live base stock or changes global balances. */
export class WorkshopController {
  private state: WorkshopState = { loaded: false, busy: false, journal: null, review: null, error: null };
  private review: Review | null = null; private running = false; private epoch = 0; private readonly listeners = new Set<() => void>();
  constructor(readonly store: WorkshopStore, private readonly ports: WorkshopPorts) {}
  snapshot = (): WorkshopState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(value: Partial<WorkshopState>): void { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
  private clearReview(): void { this.review = null; this.publish({ review: null }); }
  dismiss(): void { this.epoch++; this.clearReview(); }
  private command(): WorkshopCommand { const c = this.state.journal?.operation?.command; if (!c) throw new Error('There is no original Workshop command.'); return c; }
  private async action(baseId: string | undefined, run: (guard: Guard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; let guard: Guard | null = null;
    try {
      const captured = this.ports.capture(baseId), epoch = this.epoch;
      guard = () => { captured(); if (epoch !== this.epoch) throw new Error('The Workshop view changed.'); };
      guard(); this.publish({ busy: true, error: null }); const current = guard;
      await this.ports.lock(`pkw-workshop-v1:${this.store.key}`, async () => {
        current(); const journal = await this.store.read(); current(); this.publish({ loaded: true, journal }); await run(current);
      });
    } catch (error) {
      this.review = null;
      try { guard?.(); if (guard) this.publish({ review: null, error: error instanceof Error ? error.message : 'Workshop recovery is incomplete.' }); } catch { /* obsolete session cannot publish */ }
    } finally { this.running = false; try { guard?.(); if (guard) this.publish({ busy: false }); } catch { /* obsolete view */ } }
  }
  private async write(update: (old: WorkshopJournal) => WorkshopJournal, guard: Guard): Promise<void> {
    guard(); if (!this.state.journal) throw new Error('Read the original Workshop journal first.');
    const journal = await this.store.compareAndSet(this.state.journal.revision, update); guard(); this.publish({ journal });
  }
  private async recover(guard: Guard): Promise<WorkshopProof> {
    const command = this.command(); guard(); const raw = await this.ports.get(proofPath(command), guard); guard();
    const proof = matchWorkshopProof(raw, this.store.identity, command), saved = this.state.journal!.operation!.proof;
    if (proof.status === 'accepted' && this.state.journal!.operation!.refusal) throw new Error('The server returned acceptance for a refused Workshop request. Keep the original record for review.');
    if (saved) {
      if (proof.status !== 'accepted' || !same(saved.receipt, proof.receipt)) throw new Error('The original accepted Workshop receipt changed or is missing.');
      return proof;
    }
    if (proof.status === 'accepted') await this.write(old => ({ ...old, operation: { ...old.operation!, proof } }), guard);
    return proof;
  }
  /** Foreground/reload performs GET recovery only, including while starts pause
   * or after the selected base/deed owner changes. */
  open(): Promise<void> { return this.action(undefined, async guard => { this.clearReview(); if (this.state.journal?.operation) await this.recover(guard); }); }
  beginStart(baseId: string, ingots: number, recipeVersion: number): Promise<void> {
    return this.begin({ kind: 'start', request: { baseId, ingots, recipeVersion, idempotencyKey: this.ports.key() } });
  }
  beginCollect(baseId: string, jobId: string): Promise<void> {
    return this.begin({ kind: 'collect', baseId, jobId, request: { idempotencyKey: this.ports.key() } });
  }
  private begin(raw: WorkshopCommand): Promise<void> {
    return this.action(workshopBase(raw), async guard => {
      this.clearReview(); if (this.state.journal?.operation) throw new Error('Recover the original Workshop command before starting another.');
      const command = parseWorkshopCommand(raw);
      // A missing/old by-key endpoint cannot be mistaken for proof of absence.
      guard(); const probe = matchWorkshopProof(await this.ports.get(proofPath(command), guard), this.store.identity, command); guard();
      await this.write(old => ({ ...old, operation: { command, attempted: false, proof: probe.status === 'accepted' ? probe : null } }), guard);
      if (probe.status === 'accepted') return;
      await this.reviewOriginal(guard);
    });
  }
  private async readView(command: WorkshopCommand, guard: Guard): Promise<WorkshopView> {
    guard(); const raw = await this.ports.get(`/workshop?baseId=${encodeURIComponent(workshopBase(command))}`, guard); guard();
    const view = WorkshopViewSchema.parse(raw); consent(view, command); return view;
  }
  private async reviewOriginal(guard: Guard): Promise<void> {
    if (this.state.journal!.operation?.refusal) throw new Error('The original request was declined. Check its proof and explicitly archive the refusal before reviewing a new request.');
    this.clearReview(); if ((await this.recover(guard)).status === 'accepted') return;
    const command = this.command(), started = this.ports.clock(), view = await this.readView(command, guard); guard();
    this.review = { command, view, guard, started }; this.assertFresh(this.review, guard); this.publish({ review: { command, view } });
  }
  reviewCommand(): Promise<void> {
    const baseId = this.state.journal?.operation ? workshopBase(this.command()) : undefined;
    return this.action(baseId, guard => this.reviewOriginal(guard));
  }
  private assertFresh(review: Review, guard: Guard): void {
    guard(); review.guard(); const clock = this.ports.clock(), elapsed = clock.elapsed - review.started.elapsed, wall = clock.wall - review.started.wall;
    if (![elapsed, wall].every(Number.isFinite) || elapsed < 0 || wall < 0) throw new Error('The clock changed. Review the original Workshop command again.');
    if (review.command.kind === 'start' && Date.parse(review.view.serverNow) + Math.max(elapsed, wall) >= Date.parse(review.view.allowance.resetsAt)) throw new Error('The UTC allowance day changed. Review the original Workshop command again.');
    if (!same(review.command, this.command())) throw new Error('Review the original Workshop command again.');
  }
  /** Explicit confirmation is the sole POST path. Unknown proof is required on
   * every attempt, and no timeout can allocate a replacement key. */
  confirm(): Promise<void> {
    const baseId = this.state.journal?.operation ? workshopBase(this.command()) : undefined;
    return this.action(baseId, async guard => {
      const review = this.review; if (!review) throw new Error('Review the original Workshop command before confirming.');
      if (this.state.journal!.operation?.refusal) throw new Error('A declined Workshop request cannot be resubmitted.');
      this.assertFresh(review, guard);
      if ((await this.recover(guard)).status === 'accepted') { this.clearReview(); return; }
      const view = await this.readView(review.command, guard); this.assertFresh(review, guard);
      if (!same(consent(review.view, review.command), consent(view, review.command))) throw new Error('Workshop terms or allowance changed. Review the original command again.');
      // Captured under the wallet lock before its durable marker. A later
      // retry's refusal cannot disprove an earlier ambiguous acceptance.
      const firstPost = !this.state.journal!.operation!.attempted;
      await this.write(old => ({ ...old, operation: { ...old.operation!, attempted: true } }), guard); this.assertFresh(review, guard);
      const command = this.command(), path = command.kind === 'start' ? '/workshop/jobs' : `/workshop/jobs/${encodeURIComponent(command.jobId)}/collect`;
      // The adapter invokes this guard again after authentication waits, at fetch.
      const sendGuard = () => this.assertFresh(review, guard);
      const attemptRevision = this.state.journal!.revision;
      let refusedJournal: WorkshopJournal | null = null;
      const observeResponseError = async (error: unknown) => {
        if (!firstPost || refusedJournal) return;
        if (error instanceof ApiError && error.code && workshopRefusalDefinitive(command.kind, error.status, error.code)) {
          refusedJournal = await this.store.compareAndSet(attemptRevision, old => ({ ...old, operation: { ...old.operation!, refusal: { phase: 'first_post', status: error.status, code: error.code! } } }));
        }
      };
      this.clearReview(); sendGuard();
      try { await this.ports.post(path, command.request, sendGuard, observeResponseError); }
      catch (error) {
        await observeResponseError(error);
        if (refusedJournal) { guard(); this.publish({ journal: refusedJournal }); }
        throw error;
      }
      guard();
      // The POST ack is not a by-key proof and is never current inventory.
      await this.recover(guard);
    });
  }
  finish(): Promise<void> {
    return this.action(undefined, async guard => {
      this.clearReview(); if ((await this.recover(guard)).status !== 'accepted') throw new Error('Keep the original command until its accepted receipt is recovered.');
      await this.write(old => ({ ...old, operation: null, archives: [...old.archives, { operation: old.operation!, reason: 'accepted', evidence: null }] }), guard);
    });
  }
  /** A declined first POST never clears itself. Preserve its exact refusal and
   * original key, and require another authenticated absence read to archive. */
  archiveRefusal(): Promise<void> {
    return this.action(undefined, async guard => {
      this.clearReview();
      if (!this.state.journal?.operation?.refusal) throw new Error('Only a definitive first-request refusal can be archived.');
      const evidence = await this.recover(guard);
      if (evidence.status !== 'unknown') throw new Error('Keep the original Workshop record until its outcome is reconciled.');
      await this.write(old => ({ ...old, operation: null, archives: [...old.archives, { operation: old.operation!, reason: 'refused', evidence }] }), guard);
    });
  }
  /** Explicit local abandonment only: never POST, and no base authority is
   * required to retain a wallet's unsent draft after a deed/selection change.
   * Fresh absence proof and CAS must agree with the original unsent record. */
  abandonDraft(): Promise<void> {
    return this.action(undefined, async guard => {
      this.clearReview(); this.command();
      if (this.state.journal!.operation!.attempted) throw new Error('An attempted Workshop command must stay in recovery.');
      const evidence = await this.recover(guard);
      if (evidence.status !== 'unknown') throw new Error('The original Workshop command was accepted. Keep its receipt.');
      await this.write(old => ({ ...old, operation: null, archives: [...old.archives, { operation: old.operation!, reason: 'unattempted', evidence }] }), guard);
    });
  }
}
