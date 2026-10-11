import { assertGemsConsent, gemsConsent, gemsCommand, gemsReceiptPath, parseGemsIntent, parseGemsOverview, parseGemsReceipt,
  type GemsInput, type GemsIntent, type GemsOverview, type GemsReceipt } from './contracts';
import { GemsJournalStore, gemsRefusalDefinitive, type GemsIdentity, type GemsJournal } from './journal';
import { ApiError } from '../api';

export interface GemsPorts {
  get(path: string, guard: () => void): Promise<unknown>;
  /** Must use exact-body api.postRaw with isCurrent guarded inside cookie admission. */
  post(path: string, body: Record<string, unknown>, guard: () => void, observeResponseError?: (error: unknown) => Promise<void>): Promise<unknown>;
  lock<T>(name: string, action: () => Promise<T>): Promise<T>;
  /** Bind API origin, cluster, authenticated account and generation; new actions also bind the selected base. */
  capture(identity: GemsIdentity, newAction: boolean): () => void;
  key(): string;
  validateScope(intent: GemsIntent, guard: () => void): Promise<void>;
  /** Read the account/domain snapshot and publish only while guard remains current. */
  hydrate(intent: GemsIntent, receipt: GemsReceipt, guard: () => void): Promise<void>;
}
export type GemsState = { loaded: boolean; enabled: boolean; busy: boolean; journal: GemsJournal | null;
  overview: GemsOverview | null; review: GemsIntent | null; error: string | null };
export async function gemsBrowserLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate Gems recovery across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is checking the saved Gems operation.');
    return action();
  });
}
/** Start-up/recovery are GET-only. Unknown, authentication failures and outages
 * preserve exact consent. No POST response, balance delta or task flag proves
 * success. A receipt is committed before hydration; hydration precedes success. */
export class GemsController {
  private state: GemsState = { loaded: false, enabled: false, busy: false, journal: null, overview: null, review: null, error: null };
  private epoch = 0;
  private approval: { intent: GemsIntent; guard: () => void } | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(readonly store: GemsJournalStore, private readonly ports: GemsPorts) {}
  snapshot = (): GemsState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<GemsState>): void { this.state = { ...this.state, ...update }; this.listeners.forEach(fn => fn()); }
  dismiss(): void { this.epoch++; this.approval = null; this.publish({ review: null }); }
  private async action(newAction: boolean, operation: (guard: () => void) => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null, enabled: false });
    try {
      const epoch = this.epoch, account = this.ports.capture(this.store.identity, newAction);
      const guard = (): void => { account(); if (epoch !== this.epoch) throw new Error('The Gems view changed. Check the saved operation.'); };
      await this.ports.lock(`pkw-gems-v1:${this.store.key}`, async () => {
        guard(); const journal = await this.store.read(); guard(); this.publish({ journal, loaded: true });
        await operation(guard);
      });
    } catch (error) {
      this.dismiss(); this.publish({ enabled: false, error: error instanceof Error ? error.message : 'The original Gems operation still needs recovery.' });
    } finally { this.publish({ busy: false }); }
  }
  private async write(update: (old: GemsJournal) => GemsJournal, guard: () => void): Promise<void> {
    guard(); const journal = this.state.journal;
    if (!journal) throw new Error('Read the saved Gems operation first.');
    const next = await this.store.compareAndSet(journal.revision, update); guard(); this.publish({ journal: next });
  }
  private async loadOverview(guard: () => void): Promise<GemsOverview> {
    const raw = await this.ports.get('/gems', guard); guard(); const overview = parseGemsOverview(raw);
    this.publish({ enabled: overview.exactConsent, overview }); return overview;
  }
  private async observe(guard: () => void): Promise<void> {
    const journal = this.state.journal!;
    if (!journal.intent || journal.finished) return;
    let raw = journal.receipt;
    if (!raw) {
      const observed = await this.ports.get(gemsReceiptPath(journal.intent), guard); guard();
      if (!parseGemsReceipt(observed, journal.intent, this.store.identity.wallet)) return;
      raw = observed as Record<string, unknown>;
      await this.write(old => ({ ...old, attempted: true, receipt: raw }), guard);
    }
    const receipt = parseGemsReceipt(raw, journal.intent, this.store.identity.wallet)!;
    await this.ports.hydrate(journal.intent, receipt, guard); guard();
    await this.write(old => ({ ...old, hydrated: true, finished: true }), guard);
  }
  open(): Promise<void> {
    return this.action(false, async guard => {
      // Historical proof is useful even if new Gems purchases are currently disabled.
      await this.observe(guard);
      await this.loadOverview(guard);
    });
  }
  private requireNew(): void {
    if (this.state.journal?.intent && !this.state.journal.finished) throw new Error('Check the original Gems operation before starting another.');
  }
  private validate(intent: GemsIntent, overview: GemsOverview): void {
    if (intent.kind === 'gems-from-keep') {
      if (!overview.sources.includes('ledger-keep')) throw new Error('The ledger KEEP source is unavailable.');
      if (BigInt(intent.keep) < BigInt(overview.minConvertKeep) || BigInt(intent.keep) > BigInt(overview.maxConvertKeepPerTx)) throw new Error('This amount is outside the server conversion bounds.');
    } else if (intent.kind === 'gems-to-shards') {
      if (BigInt(intent.gems) > BigInt(overview.gems)) throw new Error('Not enough Gems.');
    } else if (!overview.tasks.some(task => task.id === intent.taskId && !task.claimed)) throw new Error('This Gems task is unavailable or already claimed.');
  }
  review(input: GemsInput): Promise<void> {
    // Freeze caller-owned input before any asynchronous capability read.
    const intent = parseGemsIntent({ ...structuredClone(input), idempotencyKey: this.ports.key() });
    return this.action(true, async guard => {
      this.approval = null; this.publish({ review: null }); this.requireNew();
      const overview = await this.loadOverview(guard); this.validate(intent, overview); await this.ports.validateScope(intent, guard); guard();
      const reviewed = Object.freeze({ ...intent, consent: Object.freeze(gemsConsent(intent, overview)) });
      assertGemsConsent(reviewed, overview);
      this.approval = { intent: reviewed, guard }; this.publish({ review: reviewed });
    });
  }
  confirm(): Promise<void> {
    const approval = this.approval;
    return this.action(true, async guard => {
      if (!approval || approval !== this.approval) throw new Error('Review the Gems operation first.');
      const approved = (): void => { guard(); approval.guard(); };
      this.requireNew(); const overview = await this.loadOverview(approved); this.validate(approval.intent, overview); assertGemsConsent(approval.intent, overview); await this.ports.validateScope(approval.intent, approved); approved();
      await this.write(old => ({ ...old, intent: approval.intent, attempted: false, receipt: null, hydrated: false, finished: false, refusal: null }), approved);
      this.approval = null; this.publish({ review: null });
      await this.write(old => ({ ...old, attempted: true }), approved);
      const { path, body } = gemsCommand(approval.intent); approved();
      const attemptRevision = this.state.journal!.revision;
      let refusedJournal: GemsJournal | null = null;
      const observeResponseError = async (error: unknown) => {
        if (refusedJournal) return;
        if (error instanceof ApiError && error.code && gemsRefusalDefinitive(approval.intent.kind, error.status, error.code)) {
          refusedJournal = await this.store.compareAndSet(attemptRevision, old => ({ ...old, refusal: { status: error.status, code: error.code! }, finished: true }));
        }
      };
      // Only this first POST's own typed refusal can disprove its acceptance.
      // A later receipt GET or an explicit retry failure can never close it.
      try { await this.ports.post(path, body, approved, observeResponseError); }
      catch (error) {
        await observeResponseError(error);
        if (refusedJournal) { approved(); this.publish({ journal: refusedJournal }); }
        throw error;
      }
      approved(); await this.observe(approved); await this.loadOverview(approved);
    });
  }
  check(): Promise<void> { return this.action(false, async guard => { await this.observe(guard); await this.loadOverview(guard); }); }
  /** Explicit player choice only: first observe, then revalidate support and
   * resend the exact original idempotent body. An outage never mints a new key. */
  retry(): Promise<void> {
    return this.action(true, async guard => {
      const original = this.state.journal!;
      if (!original.intent || original.finished) throw new Error('There is no saved Gems operation to retry.');
      await this.observe(guard);
      if (this.state.journal!.receipt) { await this.loadOverview(guard); return; }
      const overview = await this.loadOverview(guard); this.validate(original.intent, overview); assertGemsConsent(original.intent, overview); await this.ports.validateScope(original.intent, guard); guard();
      if (!this.state.journal!.attempted) await this.write(old => ({ ...old, attempted: true }), guard);
      const { path, body } = gemsCommand(original.intent);
      await this.ports.post(path, body, guard); guard(); await this.observe(guard); await this.loadOverview(guard);
    });
  }
}
