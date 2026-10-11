import { ClanCommandReceiptSchema, ClanCommandStatusSchema, type ClanCommandReceipt } from '@shardkeep/shared/clanCommands';
import { ClanJournalStore, parseClanIntent, sameClanConsent, type ClanHydration, type ClanIntent, type ClanJournal } from './journal';

export type ClanReview = { kind: 'leave' | 'kick'; clanId: string; target?: string };
export interface ClanPorts {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown, guard: () => void): Promise<unknown>;
  lock<T>(name: string, action: () => Promise<T>): Promise<T>;
  capture(newAction: boolean): () => void;
  unsupported(error: unknown): boolean;
  key(): string;
  consent(input: ClanReview, key: string, guard: () => void): Promise<ClanIntent>;
  validate(intent: ClanIntent, guard: () => void, retry: boolean): Promise<void>;
  hydrate(receipt: ClanCommandReceipt, guard: () => void): Promise<ClanHydration>;
}
export type ClanState = {
  loaded: boolean; supported: boolean; busy: boolean; journal: ClanJournal | null;
  review: ClanIntent | null; error: string | null;
};
export async function clanBrowserLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate clan recovery across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another tab is checking this clan command. Try again when it finishes.');
    return action();
  });
}
/** Every automatic entry path is GET-only. Exact stored consent is the only
 * source for an explicit retry; current roster or balance cannot prove success. */
export class ClanController {
  private state: ClanState = { loaded: false, supported: false, busy: false, journal: null, review: null, error: null };
  private approval: { intent: ClanIntent; guard: () => void; epoch: number } | null = null;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readonly store: ClanJournalStore, private readonly ports: ClanPorts) {}
  snapshot = (): ClanState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ClanState>): void { this.state = { ...this.state, ...update }; this.listeners.forEach((listener) => listener()); }
  dismiss(): void { this.epoch++; this.approval = null; this.publish({ review: null }); }
  private async write(update: (old: ClanJournal) => ClanJournal, guard: () => void): Promise<void> {
    guard(); const old = this.state.journal;
    if (!old) throw new Error('Read the saved clan command first.');
    const next = await this.store.compareAndSet(old.revision, update); guard(); this.publish({ journal: next });
  }
  private async action(newAction: boolean, operation: (guard: () => void) => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null });
    try {
      const epoch = this.epoch; const accountGuard = this.ports.capture(newAction);
      const guard = (): void => {
        accountGuard(); if (epoch !== this.epoch) throw new Error('The clan view changed. Read the original saved command.');
      };
      await this.ports.lock(`pkw-clans-v1:${this.store.key}`, async () => {
        guard(); const journal = await this.store.read(); guard(); this.publish({ journal, loaded: true });
        await operation(guard);
      });
    } catch (error) {
      this.dismiss(); this.publish({ error: error instanceof Error ? error.message : 'The original clan command still needs recovery.' });
    } finally { this.publish({ busy: false }); }
  }
  private async accept(raw: unknown, guard: () => void): Promise<void> {
    guard(); const receipt = ClanCommandReceiptSchema.parse(raw); const journal = this.state.journal!;
    if (!journal.intent || !sameClanConsent(journal.intent, receipt, this.store.identity.wallet)) throw new Error('The receipt does not match the original clan command.');
    if (journal.receipt && JSON.stringify(journal.receipt) !== JSON.stringify(receipt)) throw new Error('The immutable clan receipt changed.');
    if (!journal.receipt) await this.write((old) => ({ ...old, receipt }), guard);
  }
  private async status(key: string, guard: () => void): Promise<void> {
    this.publish({ supported: false }); let raw: unknown;
    try { raw = await this.ports.get(`/clans/v1/commands/${encodeURIComponent(key)}`); }
    catch (error) { guard(); if (this.ports.unsupported(error)) return; throw error; }
    guard(); const observed = ClanCommandStatusSchema.parse(raw);
    if (observed.wallet !== this.store.identity.wallet || observed.idempotencyKey !== key) throw new Error('The clan receipt belongs to another account or key.');
    if (observed.receipt) await this.accept(observed.receipt, guard);
    else if (this.state.journal?.receipt && this.state.journal.intent?.request.idempotencyKey === key) throw new Error('The original clan receipt is temporarily unavailable.');
    this.publish({ supported: true });
  }
  private async hydrate(guard: () => void): Promise<void> {
    const journal = this.state.journal!;
    if (!journal.receipt || journal.hydrated) return;
    const hydrated = await this.ports.hydrate(journal.receipt, guard); guard();
    await this.write((old) => ({ ...old, hydrated }), guard);
  }
  open(): Promise<void> {
    return this.action(false, async (guard) => {
      const journal = this.state.journal!;
      await this.status(journal.intent?.request.idempotencyKey ?? this.ports.key(), guard);
      if (this.state.supported) await this.hydrate(guard);
    });
  }
  private requireNew(): void {
    if (!this.state.supported) throw new Error('This server has not enabled saved clan management.');
    if (this.state.journal?.intent && !this.state.journal.finished) throw new Error('Finish the original clan command before reviewing another.');
  }
  review(input: ClanReview): Promise<void> {
    const epoch = this.epoch;
    return this.action(true, async (guard) => {
      const previous = this.state.journal!.intent;
      await this.status(previous?.request.idempotencyKey ?? this.ports.key(), guard); this.requireNew();
      const intent = parseClanIntent(await this.ports.consent(input, this.ports.key(), guard)); guard();
      if (epoch !== this.epoch) throw new Error('The clan review was closed.');
      this.approval = { intent, guard, epoch }; this.publish({ review: intent });
    });
  }
  confirm(): Promise<void> {
    const approval = this.approval;
    return this.action(true, async (guard) => {
      if (!approval || approval !== this.approval) throw new Error('Review this clan command first.');
      const approved = (): void => {
        guard(); approval.guard(); if (approval.epoch !== this.epoch) throw new Error('The clan review was closed.');
      };
      const previous = this.state.journal!.intent;
      await this.status(previous?.request.idempotencyKey ?? approval.intent.request.idempotencyKey, approved);
      this.requireNew(); await this.ports.validate(approval.intent, approved, false); approved();
      await this.write((old) => ({ ...old, intent: approval.intent, receipt: null, hydrated: null, finished: false }), approved);
      approved(); this.approval = null; this.publish({ review: null });
      await this.send(approved);
    });
  }
  private async send(guard: () => void): Promise<void> {
    guard(); const journal = this.state.journal!;
    if (!journal.intent || journal.receipt || journal.finished) throw new Error('Only an unresolved saved clan command may be submitted.');
    const intent = journal.intent;
    // HTTP errors remain uncertain. Only the exact authenticated terminal
    // receipt can retire this key, including a persisted no-effect refusal.
    const raw = await this.ports.post(`/clans/v1/${intent.kind}`, intent.request, guard); guard();
    await this.accept(raw, guard); await this.hydrate(guard);
  }
  retry(): Promise<void> {
    return this.action(true, async (guard) => {
      const journal = this.state.journal!;
      if (!journal.intent || journal.finished) throw new Error('There is no unresolved original clan command to retry.');
      await this.status(journal.intent.request.idempotencyKey, guard); guard();
      if (!this.state.supported) throw new Error('Keep the original command saved until this server supports its receipt.');
      if (this.state.journal!.receipt) await this.hydrate(guard);
      else { await this.ports.validate(journal.intent, guard, true); guard(); await this.send(guard); }
    });
  }
  finish(): Promise<void> {
    return this.action(true, async (guard) => {
      const journal = this.state.journal!;
      if (!journal.receipt || !journal.hydrated) throw new Error('Read the original receipt and refresh its destination first.');
      await this.write((old) => ({ ...old, finished: true }), guard); this.dismiss();
    });
  }
}
