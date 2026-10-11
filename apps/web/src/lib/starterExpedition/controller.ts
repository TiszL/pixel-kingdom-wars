import { StarterExpeditionRouteSnapshotSchema, StarterExpeditionViewSchema, type StarterExpeditionRequest, type StarterExpeditionView } from '@shardkeep/shared/starterExpeditionApi';
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { PaidStarterExpeditionViewSchema, type PaidStarterExpeditionView } from '@shardkeep/shared/paidStarterExpeditionApi';
import { isPaidStarterCommand } from '../paidStarterExpeditions/command';
import { ApiError } from '../api';
import { matchStarterExpeditionProof, starterExpeditionRefusalDefinitive, parseStarterExpeditionCommand, same,
  type StarterExpeditionCommand, type StarterExpeditionJournal, type StarterExpeditionProof, type StarterExpeditionStore } from './journal';

type Guard = () => void;
export interface StarterExpeditionPorts {
  get(path: string, guard: Guard): Promise<unknown>;
  /** Original evidence is retained under response ownership before checking an obsolete view. */
  getProof(request: StarterExpeditionRequest, guard: Guard, retain: (raw: unknown) => Promise<void>): Promise<unknown>;
  post(request: StarterExpeditionRequest, guard: Guard, retain: (raw: unknown) => Promise<void>,
    observeResponseError: (error: unknown) => Promise<void>, firstAttempt: boolean, onCreated?: () => void): Promise<unknown>;
  /** Identity/lifecycle only for historical recovery; selected-base generation and
   * current authority additionally for review and the actual mutation enqueue. */
  capture(baseId?: string): Guard;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  key(): string;
}
export type StarterExpeditionReview = { command: StarterExpeditionCommand; view: StarterExpeditionView };
export type StarterExpeditionState = { loaded: boolean; busy: boolean; journal: StarterExpeditionJournal | null;
  review: StarterExpeditionReview | null; error: string | null };
type Review = StarterExpeditionReview & { guard: Guard };
function admit(view: StarterExpeditionView, command: StarterExpeditionCommand, wallet: string, paid?: PaidStarterExpeditionView): void {
  if (view.wallet !== wallet || view.baseId !== command.request.baseId) throw new Error('Starter departure authority is for another wallet or base.');
  if (!view.acceptingDepartures || !view.home || !view.lodgeCompletedAt || view.flight || !view.installation)
    throw new Error('New departure requires available server admission, a home, completed Lodge and an idle installed starter. Original receipts remain recoverable.');
  if (isPaidStarterCommand(command.route) && (!paid || paid.wallet !== wallet || paid.baseId !== command.request.baseId
    || paid.realm !== REALM_IDS.indexOf(command.route.realmId) || !paid.acceptingDepartures || paid.coverage.status !== 'covered'))
    throw new Error('Current paid destination coverage is unavailable. Saved receipts remain recoverable.');
  const route = paid ? paid.route : view.routes.find(row => row.routeId === command.request.routeId);
  if (!route || !same(paid ? route : StarterExpeditionRouteSnapshotSchema.parse(route), command.route) || !same(view.installation, command.installation))
    throw new Error('The reviewed route or original installation changed.');
}
export async function starterExpeditionLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate starter departure commands across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is handling this starter departure command.');
    return run();
  });
}
/** Historical evidence never grants resources or publishes live inventory. */
export class StarterExpeditionController {
  private state: StarterExpeditionState = { loaded: false, busy: false, journal: null, review: null, error: null };
  private journeyRefresh = false;
  consumeJourneyRefresh(): boolean { const fresh = this.journeyRefresh; this.journeyRefresh = false; return fresh; }
  private review: Review | null = null; private publicationGuard: Guard | null = null; private running = false; private epoch = 0; private readonly listeners = new Set<() => void>();
  constructor(readonly store: StarterExpeditionStore, private readonly ports: StarterExpeditionPorts) {}
  snapshot = (): StarterExpeditionState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(value: Partial<StarterExpeditionState>): void { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
  private clearReview(): void { this.review = null; this.publish({ review: null }); }
  dismiss(): void { this.epoch++; this.clearReview(); }
  private command(): StarterExpeditionCommand {
    const c = this.state.journal?.operation?.command; if (!c) throw new Error('There is no original starter departure command.'); return c;
  }
  private async action(run: (guard: Guard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; this.journeyRefresh = false; this.publicationGuard = null; let guard: Guard | null = null;
    try {
      const captured = this.ports.capture(), epoch = this.epoch;
      guard = () => { captured(); if (epoch !== this.epoch) throw new Error('The starter departure view changed.'); };
      guard(); this.publicationGuard = guard; this.publish({ busy: true, error: null }); const current = guard;
      await this.ports.lock(`pkw-starter-expeditions-v1:${this.store.key}`, async () => {
        await this.read(current); await run(current);
      });
    } catch (error) {
      this.review = null;
      try { this.publicationGuard?.(); if (this.publicationGuard) this.publish({ review: null, error: error instanceof Error ? error.message : 'Starter departure recovery is incomplete.' }); } catch { /* obsolete session cannot publish */ }
    } finally { this.running = false; try { this.publicationGuard?.(); if (this.publicationGuard) this.publish({ busy: false }); } catch { /* obsolete view */ } this.publicationGuard = null; }
  }
  private async read(guard: Guard): Promise<void> {
    guard(); this.publicationGuard?.(); const journal = await this.store.read(); guard(); this.publicationGuard?.(); this.publish({ loaded: true, journal });
  }
  private async write(update: (old: StarterExpeditionJournal) => StarterExpeditionJournal, guard: Guard): Promise<void> {
    guard(); if (!this.state.journal) throw new Error('Read the original starter departure journal first.');
    const journal = await this.store.compareAndSet(this.state.journal.revision, update); guard(); this.publish({ journal });
  }
  /** This callback deliberately has no view guard. Complete owned evidence must
   * survive dismissal/logout; the caller only publishes after its own guard. */
  private async retain(command: StarterExpeditionCommand, raw: unknown): Promise<void> {
    const proof = matchStarterExpeditionProof(raw, this.store.identity, command), journal = await this.store.read();
    const key = command.request.idempotencyKey;
    const active = journal.operation?.command.request.idempotencyKey === key;
    const index = journal.archives.findIndex(row => row.operation.command.request.idempotencyKey === key);
    const operation = active ? journal.operation : journal.archives[index]?.operation;
    if (!operation || !same(operation.command, command)) throw new Error('The original starter departure command changed during recovery.');
    if (proof.status === 'unknown') {
      if (operation.proof) throw new Error('The original accepted starter departure receipt is missing.');
      return;
    }
    if (same(operation.proof, proof)) return;
    await this.store.compareAndSet(journal.revision, old => active
      ? { ...old, operation: { ...old.operation!, proof } }
      : { ...old, archives: old.archives.map((row, i) => i === index ? { ...row, operation: { ...row.operation, proof } } : row) });
  }
  private async recover(command: StarterExpeditionCommand, guard: Guard): Promise<StarterExpeditionProof> {
    guard(); const retain = (raw: unknown) => this.retain(command, raw);
    const raw = await this.ports.getProof(command.request, guard, retain);
    // Idempotent when the transport already retained under response ownership.
    await retain(raw); guard(); await this.read(guard);
    return matchStarterExpeditionProof(raw, this.store.identity, command);
  }
  private async view(baseId: string, guard: Guard): Promise<StarterExpeditionView> {
    guard(); const raw = await this.ports.get(`/starter-expeditions?baseId=${encodeURIComponent(baseId)}`, guard); guard();
    const view = StarterExpeditionViewSchema.parse(raw);
    if (view.wallet !== this.store.identity.wallet || view.baseId !== baseId) throw new Error('Starter departure authority is for another wallet or base.');
    if (view.installation && Date.parse(view.installation.installedAt) > Date.parse(view.serverNow)
      || view.flight && (Date.parse(view.flight.departedAt) > Date.parse(view.serverNow)
        || Date.parse(view.flight.departedAt) < Date.parse(view.installation!.installedAt))) throw new Error('Current expedition chronology is inconsistent.');
    return view;
  }
  private async paidView(baseId: string, realm: number, guard: Guard): Promise<PaidStarterExpeditionView> {
    guard(); const raw = await this.ports.get(`/starter-expeditions/paid-route?baseId=${encodeURIComponent(baseId)}&realm=${realm}`, guard); guard();
    const view = PaidStarterExpeditionViewSchema.parse(raw);
    if (view.wallet !== this.store.identity.wallet || view.baseId !== baseId || view.realm !== realm)
      throw new Error('Paid destination review belongs to another account, kingdom or realm.');
    return view;
  }
  private async admission(view: StarterExpeditionView, command: StarterExpeditionCommand, guard: Guard): Promise<void> {
    const paid = isPaidStarterCommand(command.route) ? await this.paidView(command.request.baseId, REALM_IDS.indexOf(command.route.realmId), guard) : undefined;
    admit(view, command, this.store.identity.wallet, paid);
  }
  private holdPaidAttempt(): void {
    if (isPaidStarterCommand(this.command().route) && this.state.journal!.operation!.attemptRevision !== null)
      throw new Error('This paid departure was already attempted. Check its original receipt; it cannot be sent again.');
  }
  private baseGuard(baseId: string, guard: Guard): Guard {
    const base = this.ports.capture(baseId), current = () => { guard(); base(); };
    this.publicationGuard = current; return current;
  }
  private async reviewOriginal(guard: Guard): Promise<void> {
    this.clearReview(); const command = this.command();
    if ((await this.recover(command, guard)).status === 'accepted') return;
    if (this.state.journal!.operation!.refusal) throw new Error('The original request was declined. Explicitly archive its refusal before starting another.');
    this.holdPaidAttempt();
    const current = this.baseGuard(command.request.baseId, guard), view = await this.view(command.request.baseId, current);
    await this.admission(view, command, current); current();
    this.review = { command, view, guard: current }; this.publish({ review: { command, view } });
  }
  /** Foreground recovers original acceptance and unfinished accepted returns by
   * GET alone. Neither a local deadline nor current stock proves a return. */
  open(): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal?.operation) await this.recover(this.command(), guard);
    const archives = this.state.journal!.archives.filter(row => row.operation.proof?.return === null);
    for (const row of archives) await this.recover(row.operation.command, guard);
  }); }
  beginDeparture(baseId: string, routeId: string): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal!.operation) throw new Error('Recover the original departure command before starting another.');
    const current = this.baseGuard(baseId, guard), view = await this.view(baseId, current);
    const route = view.routes.find(row => row.routeId === routeId); if (!route || !view.installation) throw new Error('Choose a server route and an installed starter.');
    const command = parseStarterExpeditionCommand({ request: { idempotencyKey: this.ports.key(), baseId, installationId: view.installation.installationId,
      routeId, routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion }, route, installation: view.installation });
    admit(view, command, this.store.identity.wallet);
    await this.write(old => ({ ...old, operation: { command, attemptRevision: null, proof: null, refusal: null } }), current);
    await this.reviewOriginal(guard);
  }); }
  beginPaidDeparture(baseId: string, realm: number): Promise<void> { return this.action(async guard => {
    this.clearReview(); if (this.state.journal!.operation) throw new Error('Recover the original departure command before starting another.');
    if (!Number.isSafeInteger(realm) || realm < 0 || realm >= REALM_IDS.length) throw new Error('Choose an explicit paid destination.');
    const current = this.baseGuard(baseId, guard), view = await this.view(baseId, current), selected = await this.paidView(baseId, realm, current);
    if (!view.installation) throw new Error('Choose a server route and an installed starter.');
    const route = selected.route, command = parseStarterExpeditionCommand({ request: { idempotencyKey: this.ports.key(), baseId, installationId: view.installation.installationId,
      routeId: route.routeId, routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion }, route, installation: view.installation });
    admit(view, command, this.store.identity.wallet, selected);
    await this.write(old => ({ ...old, operation: { command, attemptRevision: null, proof: null, refusal: null } }), current);
    await this.reviewOriginal(guard);
  }); }
  reviewCommand(): Promise<void> { return this.action(guard => this.reviewOriginal(guard)); }
  private assertReview(review: Review, guard: Guard): void {
    guard(); review.guard(); if (!same(review.command, this.command())) throw new Error('Review the original starter departure command again.');
  }
  /** The sole POST path; original GET recovery precedes every live admission check. */
  confirm(): Promise<void> { return this.action(async guard => {
    const review = this.review, command = this.command();
    if ((await this.recover(command, guard)).status === 'accepted') { this.clearReview(); return; }
    this.holdPaidAttempt();
    if (!review) throw new Error('Review the original starter departure command before confirming.');
    if (this.state.journal!.operation!.refusal) throw new Error('A declined original command cannot be resubmitted.');
    this.assertReview(review, guard);
    const current = this.baseGuard(command.request.baseId, guard), view = await this.view(command.request.baseId, current);
    await this.admission(view, command, current); this.assertReview(review, current);
    const firstAttempt = this.state.journal!.operation!.attemptRevision === null;
    await this.write(old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }), current);
    const attemptRevision = this.state.journal!.revision, retain = (raw: unknown) => this.retain(command, raw);
    const observeResponseError = async (error: unknown) => {
      if (!firstAttempt || !(error instanceof ApiError) || !error.code || !starterExpeditionRefusalDefinitive(error.status, error.code)) return;
      const journal = await this.store.read();
      if (journal.revision !== attemptRevision || journal.operation?.attemptRevision !== attemptRevision || journal.operation.proof
        || !same(journal.operation.command, command)) return;
      await this.store.compareAndSet(attemptRevision, old => ({ ...old, operation: { ...old.operation!, refusal: { phase: 'first_post', status: error.status, code: error.code! } } }));
    };
    const sendGuard = () => this.assertReview(review, current); this.clearReview(); sendGuard();
    try {
      let created = false;
      const raw = await this.ports.post(command.request, sendGuard, retain, observeResponseError, firstAttempt, () => { created = true; });
      await retain(raw); sendGuard(); await this.read(sendGuard); this.journeyRefresh = created;
    } catch (error) {
      await observeResponseError(error); sendGuard(); await this.read(sendGuard); throw error;
    }
  }); }
  checkArchived(key: string): Promise<void> { return this.action(async guard => {
    this.clearReview(); const row = this.state.journal!.archives.find(row => row.operation.command.request.idempotencyKey === key);
    if (!row) throw new Error('Choose an original starter departure record.');
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
