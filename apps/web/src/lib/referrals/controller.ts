import { ReferralCodeSchema, ReferralStatusV1Schema, ReferralUseV1ResponseSchema } from '@shardkeep/shared/referrals';
import { ReferralJournalStore, sameRelationship, type ReferralJournal } from './journal';

export interface ReferralPorts {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  lock<T>(name: string, action: () => Promise<T>): Promise<T>;
  capture(newAction: boolean): () => void;
  unsupported(error: unknown): boolean;
  firstRefusal(error: unknown): boolean;
}
export type ReferralState = { loaded: boolean; supported: boolean; busy: boolean; journal: ReferralJournal | null; review: string | null; error: string | null };
export const referralLockName = (store: ReferralJournalStore): string => `pkw-referrals-v1:${store.key}`;
export async function referralBrowserLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate referral recovery across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another game tab is checking this referral. Try again when it finishes.');
    return action();
  });
}
/** Foreground and reload read only. A null observation never disproves a lost
 * submission; only explicit retry may reuse the exact normalized saved code. */
export class ReferralController {
  private state: ReferralState = { loaded: false, supported: false, busy: false, journal: null, review: null, error: null };
  private approval: { code: string; guard: () => void; epoch: number } | null = null;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readonly store: ReferralJournalStore, private readonly ports: ReferralPorts) {}
  snapshot = (): ReferralState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ReferralState>): void { this.state = { ...this.state, ...update }; this.listeners.forEach((listener) => listener()); }
  dismiss(): void { this.epoch += 1; this.approval = null; this.publish({ review: null }); }
  private async write(update: (old: ReferralJournal) => ReferralJournal, guard: () => void): Promise<void> {
    guard(); const journal = this.state.journal;
    if (!journal) throw new Error('Check saved referral status first.');
    const next = await this.store.compareAndSet(journal.revision, update); guard(); this.publish({ journal: next });
  }
  private async action(newAction: boolean, operation: (guard: () => void) => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null });
    try {
      const guard = this.ports.capture(newAction);
      await this.ports.lock(referralLockName(this.store), async () => {
        guard(); const journal = await this.store.read(); guard(); this.publish({ journal, loaded: true });
        await operation(guard);
      });
    } catch (error) {
      this.dismiss(); this.publish({ error: error instanceof Error ? error.message : 'Referral recovery did not complete.' });
    } finally { this.publish({ busy: false }); }
  }
  private async status(guard: () => void): Promise<void> {
    this.publish({ supported: false });
    let raw: unknown;
    try { raw = await this.ports.get('/referrals/v1/status'); }
    catch (error) { guard(); if (this.ports.unsupported(error)) return; throw error; }
    guard(); const status = ReferralStatusV1Schema.parse(raw);
    if (status.wallet !== this.store.identity.wallet) throw new Error('Referral status belongs to another wallet.');
    const old = this.state.journal!;
    if (old.relationship && (!status.relationship || !sameRelationship(old.relationship, status.relationship))) throw new Error('The original referral relationship changed. Check again before continuing.');
    if (status.relationship && !old.relationship) await this.write((r) => ({ ...r, activated: true, relationship: status.relationship, outcome: 'observed' }), guard);
    this.publish({ supported: true });
  }
  open(): Promise<void> { return this.action(false, (guard) => this.status(guard)); }
  review(input: string): Promise<void> {
    const epoch = this.epoch;
    return this.action(true, async (guard) => {
      const code = ReferralCodeSchema.parse(input); await this.status(guard); guard();
      if (epoch !== this.epoch) throw new Error('The referral review was closed.');
      this.requireNew(); this.approval = { code, guard, epoch }; this.publish({ review: code });
    });
  }
  private requireNew(): void {
    if (!this.state.supported) throw new Error('This server has not enabled saved referral recovery.');
    if (this.state.journal?.code || this.state.journal?.relationship || this.state.journal?.legacy) throw new Error('Check the original saved referral before entering another code.');
  }
  confirm(): Promise<void> {
    const approval = this.approval;
    return this.action(true, async (guard) => {
      if (!approval || approval !== this.approval) throw new Error('Review the referral code first.');
      const approved = (): void => { guard(); approval.guard(); if (approval.epoch !== this.epoch) throw new Error('The referral review was closed.'); };
      approved(); await this.status(approved); approved(); this.requireNew();
      await this.write((old) => ({ ...old, activated: true, code: approval.code }), approved);
      approved(); this.approval = null; this.publish({ review: null });
      await this.send(approval.code, true, this.ports.capture(false));
    });
  }
  retry(): Promise<void> {
    const epoch = this.epoch;
    return this.action(true, async (guard) => {
      if (this.state.journal?.legacy) throw new Error('Retry the saved original legacy route and code.');
      const code = this.state.journal?.code;
      if (!code || this.state.journal?.relationship) throw new Error('No unresolved referral needs a retry.');
      await this.status(guard); guard();
      if (epoch !== this.epoch) throw new Error('The referral review was closed.');
      if (this.state.journal?.relationship) return;
      if (!this.state.supported) throw new Error('This server has not enabled saved referral recovery.');
      await this.send(code, false, this.ports.capture(false));
    });
  }
  private async send(code: string, first: boolean, guard: () => void): Promise<void> {
    guard(); let raw: unknown;
    try { raw = await this.ports.post('/referrals/v1/use', { code }); }
    catch (error) {
      guard();
      if (first && this.ports.firstRefusal(error)) {
        const journal = this.state.journal!;
        const next = await this.store.firstRefused(journal.revision, code); guard(); this.publish({ journal: next });
      }
      throw error;
    }
    guard(); const result = ReferralUseV1ResponseSchema.parse(raw);
    if (result.wallet !== this.store.identity.wallet || result.submittedCode !== code) throw new Error('The referral response does not match the original code and wallet.');
    await this.write((old) => {
      if (old.code !== code) throw new Error('The original referral code changed.');
      return { ...old, relationship: result.relationship, outcome: result.outcome };
    }, guard);
  }
  finish(): Promise<void> {
    return this.action(false, async (guard) => {
      const saved = this.state.journal!;
      if (saved.legacy?.route === '/alpha/referral' && !saved.legacy.result) throw new Error('Referral attribution is not proof of alpha admission.');
      if (!saved.relationship && !saved.legacy?.result) throw new Error('A positive relationship or original legacy result is required before finishing.');
      await this.write((old) => ({ ...old, code: null, outcome: old.relationship ? 'observed' : null }), guard);
    });
  }
}
