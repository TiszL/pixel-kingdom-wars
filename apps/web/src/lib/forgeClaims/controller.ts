import { ForgeClaimReceiptSchema, ForgeClaimStatusSchema, type ForgeClaimReceipt } from '@shardkeep/shared/forgeClaims';
import { ForgeClaimJournalStore, parseForgeClaimIntent, sameForgeClaimConsent, type ForgeClaimHydration, type ForgeClaimIntent, type ForgeClaimJournal } from './journal';

export type ForgeClaimReview = { baseId: string | null; day: string | null };
export interface ForgeClaimPorts {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown, guard: () => void): Promise<unknown>;
  lock<T>(name: string, action: () => Promise<T>): Promise<T>;
  capture(newAction: boolean): () => void;
  unsupported(error: unknown): boolean;
  key(): string;
  consent(input: ForgeClaimReview, key: string, guard: () => void): Promise<ForgeClaimIntent>;
  validate(intent: ForgeClaimIntent, guard: () => void, retry: boolean): Promise<void>;
  hydrate(receipt: ForgeClaimReceipt, guard: () => void): Promise<ForgeClaimHydration>;
  confirmed(): void;
}
export type ForgeClaimState = {
  loaded: boolean; supported: boolean; enabled: boolean; busy: boolean; journal: ForgeClaimJournal | null;
  review: ForgeClaimIntent | null; error: string | null;
};
export async function forgeClaimBrowserLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate Forge claim recovery across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another tab is checking this Forge claim command. Try again when it finishes.');
    return action();
  });
}
/** Every automatic entry path is GET-only. Exact stored consent is the only
 * source for an explicit retry; current allocation or balance cannot prove success. */
export class ForgeClaimController {
  private state: ForgeClaimState = { loaded: false, supported: false, enabled: false, busy: false, journal: null, review: null, error: null };
  private approval: { intent: ForgeClaimIntent; guard: () => void; epoch: number } | null = null;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readonly store: ForgeClaimJournalStore, private readonly ports: ForgeClaimPorts) {}
  snapshot = (): ForgeClaimState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ForgeClaimState>): void { this.state = { ...this.state, ...update }; this.listeners.forEach((listener) => listener()); }
  dismiss(): void { this.epoch++; this.approval = null; this.publish({ review: null }); }
  private async write(update: (old: ForgeClaimJournal) => ForgeClaimJournal, guard: () => void): Promise<void> {
    guard(); const old = this.state.journal;
    if (!old) throw new Error('Read the saved Forge claim command first.');
    const next = await this.store.compareAndSet(old.revision, update); guard(); this.publish({ journal: next });
  }
  private async action(newAction: boolean, operation: (guard: () => void) => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null });
    try {
      const epoch = this.epoch; const accountGuard = this.ports.capture(newAction);
      const guard = (): void => {
        accountGuard(); if (epoch !== this.epoch) throw new Error('The Forge claim view changed. Read the original saved command.');
      };
      await this.ports.lock(`pkw-forge-claims-v1:${this.store.key}`, async () => {
        guard(); const journal = await this.store.read(); guard(); this.publish({ journal, loaded: true });
        await operation(guard);
      });
    } catch (error) {
      this.dismiss(); this.publish({ error: error instanceof Error ? error.message : 'The original Forge claim command still needs recovery.' });
    } finally { this.publish({ busy: false }); }
  }
  private async accept(raw: unknown, guard: () => void): Promise<void> {
    guard(); const receipt = ForgeClaimReceiptSchema.parse(raw); const journal = this.state.journal!;
    if (!journal.intent || !sameForgeClaimConsent(journal.intent, receipt, this.store.identity.wallet)) throw new Error('The receipt does not match the original Forge claim command.');
    if (journal.receipt && JSON.stringify(journal.receipt) !== JSON.stringify(receipt)) throw new Error('The immutable Forge claim receipt changed.');
    if (!journal.receipt) await this.write((old) => ({ ...old, receipt }), guard);
  }
  private async status(key: string, guard: () => void): Promise<void> {
    this.publish({ supported: false, enabled: false }); let raw: unknown;
    try { raw = await this.ports.get(`/forge/claims/v1/${encodeURIComponent(key)}`); }
    catch (error) { guard(); if (this.ports.unsupported(error)) return; throw error; }
    guard(); const observed = ForgeClaimStatusSchema.parse(raw);
    if (observed.wallet !== this.store.identity.wallet || observed.idempotencyKey !== key) throw new Error('The Forge claim receipt belongs to another account or key.');
    if (observed.receipt) await this.accept(observed.receipt, guard);
    else if (this.state.journal?.receipt && this.state.journal.intent?.request.idempotencyKey === key) throw new Error('The original Forge claim receipt is temporarily unavailable.');
    this.publish({ supported: true, enabled: observed.enabled });
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
    if (!this.state.supported || !this.state.enabled) throw new Error('This server has not enabled saved Forge claims.');
    if (this.state.journal?.intent && !this.state.journal.finished) throw new Error('Finish the original Forge claim command before reviewing another.');
  }
  review(input: ForgeClaimReview): Promise<void> {
    const epoch = this.epoch;
    return this.action(true, async (guard) => {
      const previous = this.state.journal!.intent;
      await this.status(previous?.request.idempotencyKey ?? this.ports.key(), guard); this.requireNew();
      const intent = parseForgeClaimIntent(await this.ports.consent(input, this.ports.key(), guard)); guard();
      if (epoch !== this.epoch) throw new Error('The Forge claim review was closed.');
      this.approval = { intent, guard, epoch }; this.publish({ review: intent });
    });
  }
  confirm(): Promise<void> {
    const approval = this.approval;
    return this.action(true, async (guard) => {
      if (!approval || approval !== this.approval) throw new Error('Review this Forge claim command first.');
      const approved = (): void => {
        guard(); approval.guard(); if (approval.epoch !== this.epoch) throw new Error('The Forge claim review was closed.');
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
    if (!journal.intent || journal.receipt || journal.finished) throw new Error('Only an unresolved saved Forge claim command may be submitted.');
    const intent = journal.intent;
    // HTTP errors remain uncertain. Only the exact authenticated terminal
    // receipt can finish this key, including a completed zero-payout claim.
    const raw = await this.ports.post('/forge/claims/v1', intent.request, guard); guard();
    await this.accept(raw, guard); guard(); this.ports.confirmed(); await this.hydrate(guard);
  }
  retry(): Promise<void> {
    return this.action(true, async (guard) => {
      const journal = this.state.journal!;
      if (!journal.intent || journal.finished) throw new Error('There is no unresolved original Forge claim command to retry.');
      await this.status(journal.intent.request.idempotencyKey, guard); guard();
      if (!this.state.supported) throw new Error('Keep the original command saved until this server supports its receipt.');
      if (this.state.journal!.receipt) await this.hydrate(guard);
      else {
        if (!this.state.enabled) throw new Error('Forge claims are paused. Keep the original request saved.');
        await this.ports.validate(journal.intent, guard, true); guard(); await this.send(guard);
      }
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
