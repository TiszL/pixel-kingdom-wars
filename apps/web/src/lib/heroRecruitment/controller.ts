import type { GameCurrency } from '../gameCurrency';
import { HeroRecruitmentReceiptSchema, HeroRecruitmentStatusSchema } from '@shardkeep/shared/heroRecruitment';
import { HeroRecruitmentJournalStore, parseHeroRecruitmentIntent, sameHeroRecruitmentConsent, parseLegacyHeroAcceptance, type HeroRecruitmentHydration, type HeroRecruitmentIntent, type HeroRecruitmentJournal } from './journal';

export type HeroRecruitmentReview = { baseId: string | null; type: 'heroaltar' | 'siegestool'; tx: number; ty: number };
export interface HeroRecruitmentPorts {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown, guard: () => void, expectedCurrency?: GameCurrency, observeResponseError?: (error: unknown) => Promise<void>): Promise<unknown>;
  lock<T>(name: string, action: () => Promise<T>): Promise<T>;
  capture(newAction: boolean): () => void;
  unsupported(error: unknown): boolean;
  key(): string;
  consent(input: HeroRecruitmentReview, key: string, mechanism: 'v1' | 'legacy', guard: () => void): Promise<HeroRecruitmentIntent>;
  validate(intent: HeroRecruitmentIntent, guard: () => void, retry: boolean): Promise<void>;
  hydrate(intent: HeroRecruitmentIntent, guard: () => void): Promise<HeroRecruitmentHydration>;
  refreshUnknownLegacy(intent: HeroRecruitmentIntent, guard: () => void): Promise<void>;
  currencyRefused?(error: unknown, currency: GameCurrency): boolean;
  confirmed(): void;
}
export type HeroRecruitmentState = {
  loaded: boolean; supported: boolean; enabled: boolean; busy: boolean; journal: HeroRecruitmentJournal | null;
  review: HeroRecruitmentIntent | null; error: string | null;
};
export async function heroRecruitmentBrowserLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to coordinate Hero recruitment recovery across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another tab is checking this Hero recruitment command. Try again when it finishes.');
    return action();
  });
}
/** Every automatic entry path is GET-only. Exact stored consent is the only
 * source for an explicit retry; current altar or balance cannot prove success. */
export class HeroRecruitmentController {
  private state: HeroRecruitmentState = { loaded: false, supported: false, enabled: false, busy: false, journal: null, review: null, error: null };
  private approval: { intent: HeroRecruitmentIntent; guard: () => void; epoch: number } | null = null;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readonly store: HeroRecruitmentJournalStore, private readonly ports: HeroRecruitmentPorts) {}
  snapshot = (): HeroRecruitmentState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<HeroRecruitmentState>): void { this.state = { ...this.state, ...update }; this.listeners.forEach((listener) => listener()); }
  dismiss(): void { this.epoch++; this.approval = null; this.publish({ review: null }); }
  private async write(update: (old: HeroRecruitmentJournal) => HeroRecruitmentJournal, guard: () => void): Promise<void> {
    guard(); const old = this.state.journal;
    if (!old) throw new Error('Read the saved Hero recruitment command first.');
    const next = await this.store.compareAndSet(old.revision, update); guard(); this.publish({ journal: next });
  }
  private async action(newAction: boolean, operation: (guard: () => void) => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null });
    try {
      const epoch = this.epoch; const accountGuard = this.ports.capture(newAction);
      const guard = (): void => {
        accountGuard(); if (epoch !== this.epoch) throw new Error('The Hero recruitment view changed. Read the original saved command.');
      };
      await this.ports.lock(`pkw-hero-recruitment-v1:${this.store.key}`, async () => {
        guard(); const journal = await this.store.read(); guard(); this.publish({ journal, loaded: true });
        await operation(guard);
      });
    } catch (error) {
      this.dismiss(); this.publish({ error: error instanceof Error ? error.message : 'The original Hero recruitment command still needs recovery.' });
    } finally { this.publish({ busy: false }); }
  }
  private async accept(raw: unknown, guard: () => void): Promise<void> {
    guard(); const receipt = HeroRecruitmentReceiptSchema.parse(raw); const journal = this.state.journal!;
    if (!journal.intent || !sameHeroRecruitmentConsent(journal.intent, receipt, this.store.identity.wallet)) throw new Error('The receipt does not match the original Hero recruitment command.');
    if (journal.receipt && JSON.stringify(journal.receipt) !== JSON.stringify(receipt)) throw new Error('The immutable Hero recruitment receipt changed.');
    if (!journal.receipt) await this.write((old) => ({ ...old, receipt }), guard);
  }
  private async status(key: string, guard: () => void): Promise<void> {
    this.publish({ supported: false, enabled: false }); let raw: unknown;
    try { raw = await this.ports.get(`/heroes/recruit/v1/${encodeURIComponent(key)}`); }
    catch (error) { guard(); if (this.ports.unsupported(error)) return; throw error; }
    guard(); const observed = HeroRecruitmentStatusSchema.parse(raw);
    if (observed.wallet !== this.store.identity.wallet || observed.idempotencyKey !== key) throw new Error('The Hero recruitment receipt belongs to another account or key.');
    if (observed.receipt) await this.accept(observed.receipt, guard);
    else if (this.state.journal?.receipt && this.state.journal.intent?.request.idempotencyKey === key) throw new Error('The original Hero recruitment receipt is temporarily unavailable.');
    this.publish({ supported: true, enabled: observed.enabled });
  }
  private async hydrate(guard: () => void): Promise<void> {
    const journal = this.state.journal!;
    if ((!journal.receipt && !journal.legacyAcceptance) || journal.hydrated) return;
    const hydrated = await this.ports.hydrate(journal.intent!, guard); guard();
    await this.write((old) => ({ ...old, hydrated }), guard);
  }
  open(): Promise<void> {
    return this.action(false, async (guard) => {
      const journal = this.state.journal!;
      if (journal.intent?.mechanism === 'legacy') {
        if (journal.legacyAcceptance) await this.hydrate(guard);
        else await this.ports.refreshUnknownLegacy(journal.intent, guard);
      } else {
        await this.status(journal.intent?.request.idempotencyKey ?? this.ports.key(), guard);
        if (this.state.supported) await this.hydrate(guard);
      }
    });
  }
  private requireNew(): void {
    if (this.state.journal?.intent && !this.state.journal.finished) throw new Error('Finish the original Hero recruitment command before reviewing another.');
  }
  review(input: HeroRecruitmentReview): Promise<void> {
    const epoch = this.epoch;
    return this.action(true, async (guard) => {
      const previous = this.state.journal!.intent;
      this.requireNew();
      await this.status(previous?.mechanism === 'v1' ? previous.request.idempotencyKey : this.ports.key(), guard);
      const intent = parseHeroRecruitmentIntent(await this.ports.consent(input, this.ports.key(), this.state.supported && this.state.enabled ? 'v1' : 'legacy', guard)); guard();
      if (epoch !== this.epoch) throw new Error('The Hero recruitment review was closed.');
      this.approval = { intent, guard, epoch }; this.publish({ review: intent });
    });
  }
  confirm(): Promise<void> {
    const approval = this.approval;
    return this.action(true, async (guard) => {
      if (!approval || approval !== this.approval) throw new Error('Review this Hero recruitment command first.');
      const approved = (): void => {
        guard(); approval.guard(); if (approval.epoch !== this.epoch) throw new Error('The Hero recruitment review was closed.');
      };
      const previous = this.state.journal!.intent;
      await this.status(previous?.mechanism === 'v1' ? previous.request.idempotencyKey : approval.intent.request.idempotencyKey, approved);
      this.requireNew();
      const mechanism = this.state.supported && this.state.enabled ? 'v1' : 'legacy';
      if (mechanism !== approval.intent.mechanism) throw new Error('Hero recruitment support changed. Review the placement again.');
      await this.ports.validate(approval.intent, approved, false); approved();
      await this.write((old) => { const { refusal: _refusal, ...previous } = old; return { ...previous, intent: approval.intent, receipt: null, legacyAcceptance: null, hydrated: null, finished: false }; }, approved);
      approved(); this.approval = null; this.publish({ review: null });
      await this.send(approved, true);
    });
  }
  private async send(guard: () => void, firstAttempt = false): Promise<void> {
    guard(); const journal = this.state.journal!;
    if (!journal.intent || journal.receipt || journal.legacyAcceptance || journal.finished) throw new Error('Only an unresolved saved Hero recruitment command may be submitted.');
    const intent = journal.intent;
    // HTTP errors remain uncertain. A current positive response must be
    // durably recorded before feedback; a legacy response proves no funding.
    let raw: unknown;
    let refusedJournal: HeroRecruitmentJournal | null = null;
    const observeResponseError = async (error: unknown) => {
      if (refusedJournal || !firstAttempt || !intent.expectedCurrency || !this.ports.currencyRefused?.(error, intent.expectedCurrency)) return;
      refusedJournal = await this.store.compareAndSet(journal.revision, old => ({ ...old, refusal: 'CURRENCY_CONSENT_CHANGED', finished: true }));
    };
    try {
      const args = [intent.mechanism === 'v1' ? '/heroes/recruit/v1' : '/base/buildings',
        intent.mechanism === 'v1' ? intent.request : intent.legacyBody, guard] as const;
      raw = intent.expectedCurrency ? await this.ports.post(...args, intent.expectedCurrency, observeResponseError) : await this.ports.post(...args);
    } catch (error) {
      // Only this first dispatch can prove this new key never committed. Once
      // a response was ambiguous, a later refusal describes only that retry.
      await observeResponseError(error);
      if (refusedJournal) { guard(); this.publish({ journal: refusedJournal }); }
      throw error;
    }
    guard();
    if (intent.mechanism === 'v1') await this.accept(raw, guard);
    else {
      const b = (raw as { building?: Record<string, unknown> } | null)?.building;
      if (!b) throw new Error('The original legacy Hero placement is unconfirmed.');
      const legacyAcceptance = parseLegacyHeroAcceptance({ actor: b.playerWallet,
        building: { id: b.id, baseId: b.baseId, type: b.type, level: b.level, tx: b.tx, ty: b.ty } }, intent, this.store.identity.wallet);
      await this.write(old => ({ ...old, legacyAcceptance }), guard);
    }
    guard(); this.ports.confirmed(); await this.hydrate(guard);
  }
  retry(): Promise<void> {
    return this.action(true, async (guard) => {
      const journal = this.state.journal!;
      if (!journal.intent || journal.finished) throw new Error('There is no unresolved original Hero recruitment command to retry.');
      if (journal.intent.mechanism !== 'v1') throw new Error('Legacy Hero placement has no safe POST retry. Keep the original request and contact support.');
      await this.status(journal.intent.request.idempotencyKey, guard); guard();
      if (!this.state.supported) throw new Error('Keep the original command saved until this server supports its receipt.');
      if (this.state.journal!.receipt) await this.hydrate(guard);
      else {
        if (!this.state.enabled) throw new Error('Hero recruitments are paused. Keep the original request saved.');
        await this.ports.validate(journal.intent, guard, true); guard(); await this.send(guard);
      }
    });
  }
  finish(): Promise<void> {
    return this.action(false, async (guard) => {
      const journal = this.state.journal!;
      if ((!journal.receipt && !journal.legacyAcceptance) || !journal.hydrated) throw new Error('Read the original receipt and refresh its destination first.');
      await this.write((old) => ({ ...old, finished: true }), guard); this.dismiss();
    });
  }
}
