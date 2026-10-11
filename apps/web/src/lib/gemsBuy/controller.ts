import { assertGemsBuyAdmissionFresh, parseGemsBuyAdmission, parseGemsBuyDeposit, parseGemsBuyRecovery, parseGemsBuyRequest,
  sameGemsBuyQuote, type GemsBuyAdmission, type GemsBuyBinding, type GemsBuyReceipt, type GemsBuyRecovery } from './contracts';
import { GemsBuyJournalStore, hasGemsBuyPaymentEvidence, parseGemsBuyBinding, type GemsBuyJournal, type GemsBuyPurchase } from './journal';
import type { PreparedGemsBuyPayment } from './payment';

type Guard = () => void;
type Policy = { destinationAta: string; minConvertKeep: number; maxConvertKeepPerTx: number };
export interface GemsBuyPorts {
  get(path: string, guard: Guard): Promise<unknown>;
  post(path: string, body: unknown, guard: Guard): Promise<unknown>;
  capture(newAction: boolean): Guard;
  lock<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** Require enabled wallet-keep capability and the original configured mint/decimals. */
  policy(binding: GemsBuyBinding, guard: Guard): Promise<Policy>;
  prepare(admission: GemsBuyAdmission, guard: Guard): Promise<PreparedGemsBuyPayment>;
  sign(prepared: PreparedGemsBuyPayment): Promise<{ wire: Uint8Array; signature: string }>;
  live(prepared: PreparedGemsBuyPayment, guard: Guard): Promise<void>;
  broadcast(wire: Uint8Array, signature: string, guard: Guard): Promise<void>;
  hydrate(receipt: GemsBuyReceipt, guard: Guard): Promise<void>;
  clock(): { elapsed: number; wall: number };
  key(): string;
}
export async function gemsBuyLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('Update your browser to safely coordinate wallet purchases across tabs.');
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another tab is handling this purchase. Check its original receipt.');
    return run();
  });
}
export type GemsBuyState = { loaded: boolean; busy: boolean; journal: GemsBuyJournal | null; error: string | null; networkFee: number | null; reviewed: boolean };
type Review = { admission: GemsBuyAdmission; prepared: PreparedGemsBuyPayment; guard: Guard };
const path = (p: GemsBuyPurchase) => `/gems/buy/by-key/${encodeURIComponent(p.request.idempotencyKey)}`;
function assertFundingRecovery(proof: GemsBuyRecovery): void {
  if (proof.expiredPaymentRecovery !== 1) throw new Error('This server cannot safely recover late wallet payments. New purchases are unavailable.');
}
export class GemsBuyController {
  private state: GemsBuyState = { loaded: false, busy: false, journal: null, error: null, networkFee: null, reviewed: false };
  private review: Review | null = null; private running = false; private epoch = 0; private readonly listeners = new Set<() => void>();
  constructor(readonly store: GemsBuyJournalStore, private readonly ports: GemsBuyPorts) {}
  snapshot = (): GemsBuyState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(value: Partial<GemsBuyState>): void { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
  private clearReview(): void { this.review = null; this.publish({ networkFee: null, reviewed: false }); }
  dismiss(): void { this.epoch++; this.clearReview(); }
  private purchase(): GemsBuyPurchase { const p = this.state.journal?.purchase; if (!p) throw new Error('There is no saved Gems purchase.'); return p; }
  private async action(newAction: boolean, run: (guard: Guard) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true; let guard: Guard | null = null;
    try {
      const sessionGuard = this.ports.capture(newAction), epoch = this.epoch;
      guard = () => { sessionGuard(); if (this.epoch !== epoch) throw new Error('The purchase view changed.'); };
      guard(); this.publish({ busy: true, error: null });
      const current = guard;
      await this.ports.lock(`pkw-gems-buy-v1:${this.store.key}`, async () => {
        current(); const journal = await this.store.read(); current(); this.publish({ journal, loaded: true }); await run(current);
      });
    } catch (error) {
      this.review = null;
      try { guard?.(); if (guard) this.publish({ error: error instanceof Error ? error.message : 'Original purchase recovery is incomplete.', networkFee: null, reviewed: false }); } catch { /* old session cannot publish */ }
    } finally { this.running = false; try { guard?.(); if (guard) this.publish({ busy: false }); } catch { /* obsolete view */ } }
  }
  private async write(update: (old: GemsBuyJournal) => GemsBuyJournal, guard: Guard): Promise<void> {
    guard(); if (!this.state.journal) throw new Error('Read the original purchase first.');
    const next = await this.store.compareAndSet(this.state.journal.revision, update); guard(); this.publish({ journal: next });
  }
  private async readRecovery(guard: Guard): Promise<GemsBuyRecovery> {
    const p = this.purchase(); guard(); const raw = await this.ports.get(path(p), guard); guard();
    const proof = parseGemsBuyRecovery(raw, p.request, p.binding, p.quote ?? undefined);
    if (proof.status === 'known') {
      const { originalIntent, ...deposit } = proof.deposit;
      await this.write(old => ({ ...old, purchase: { ...old.purchase!, quote: originalIntent, deposit } }), guard);
    }
    return proof;
  }
  private async policy(guard: Guard): Promise<Policy> {
    const p = this.purchase(); guard(); const current = await this.ports.policy(p.binding, guard); guard();
    if (p.quote && (current.destinationAta !== p.quote.destination || p.request.keepIn < current.minConvertKeep || p.request.keepIn > current.maxConvertKeepPerTx)) throw new Error('The original purchase terms are no longer available.');
    return current;
  }
  private unattempted(): GemsBuyPurchase {
    const p = this.purchase();
    if (p.prepared || p.signature || p.broadcastStarted || hasGemsBuyPaymentEvidence(p.deposit) || p.deposit && p.deposit.status !== 'pending') throw new Error('Check the original payment. It must not be signed again.');
    return p;
  }
  /** Opening/foreground reads never create, sign, relay or verify a payment. */
  open(): Promise<void> { return this.action(false, async guard => { this.clearReview(); if (this.state.journal?.purchase) await this.readRecovery(guard); }); }
  begin(keepIn: number, binding: GemsBuyBinding): Promise<void> {
    return this.action(true, async guard => {
      this.clearReview(); if (this.state.journal?.purchase) throw new Error('Finish the original purchase before starting another.');
      const request = parseGemsBuyRequest({ kind: 'gems_buy', keepIn, idempotencyKey: this.ports.key() });
      const originalBinding = parseGemsBuyBinding(binding, this.store.identity.wallet);
      const p: GemsBuyPurchase = { request, binding: originalBinding, quote: null, prepared: null, signature: null, broadcastStarted: false, deposit: null, hydrated: false };
      // Probe support without creating anything. An old server/404 cannot leave
      // an unqueryable command, and is never permission to use the old flow.
      guard(); const raw = await this.ports.get(path(p), guard); guard();
      const probe = parseGemsBuyRecovery(raw, request, originalBinding);
      assertFundingRecovery(probe);
      await this.write(old => ({ ...old, purchase: p }), guard);
      if (probe.status === 'known') { await this.readRecovery(guard); return; }
      await this.createAdmission(guard);
    });
  }
  private async createAdmission(guard: Guard): Promise<GemsBuyAdmission> {
    const p = this.unattempted(), policy = await this.policy(guard); guard(); const start = this.ports.clock();
    const raw = await this.ports.post('/deposits', p.request, guard); guard();
    const admission = parseGemsBuyAdmission(raw, p.request, p.binding, policy, {
      requestStartedAt: start.elapsed, requestStartedWall: start.wall,
      now: () => this.ports.clock().elapsed, wall: () => this.ports.clock().wall,
    });
    if (p.quote && !sameGemsBuyQuote(p.quote, admission.quote)) throw new Error('The server changed the original purchase quote.');
    await this.write(old => ({ ...old, purchase: { ...old.purchase!, quote: admission.quote } }), guard);
    return admission;
  }
  /** Explicit review can repeat only the saved creation key/body, never a wallet attempt. */
  reviewPayment(): Promise<void> {
    return this.action(true, async guard => {
      this.clearReview(); this.unattempted(); const proof = await this.readRecovery(guard); assertFundingRecovery(proof); this.unattempted();
      if (proof.status === 'unknown' && this.purchase().quote) throw new Error('The server cannot find the original quote. Keep its recovery record.');
      const admission = await this.createAdmission(guard); guard();
      const prepared = await this.ports.prepare(admission, guard); guard(); assertGemsBuyAdmissionFresh(admission);
      this.review = { admission, prepared, guard }; this.publish({ networkFee: prepared.networkFee, reviewed: true });
    });
  }
  private assertReview(review: Review, guard: Guard): void {
    guard(); review.guard(); assertGemsBuyAdmissionFresh(review.admission);
    const p = this.purchase(); if (!p.quote || !sameGemsBuyQuote(p.quote, review.admission.quote)) throw new Error('Review the original purchase again.');
  }
  pay(): Promise<void> {
    return this.action(true, async guard => {
      const review = this.review; if (!review) throw new Error('Review the original quote and network fee first.');
      this.unattempted(); await this.policy(guard); const before = await this.readRecovery(guard);
      assertFundingRecovery(before);
      if (before.status !== 'known') throw new Error('The original payment quote is missing.');
      this.unattempted(); this.assertReview(review, guard); await this.ports.live(review.prepared, guard); this.assertReview(review, guard);
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(review.prepared.message))))
        .map(v => v.toString(16).padStart(2, '0')).join('');
      this.assertReview(review, guard);
      await this.write(old => ({ ...old, purchase: { ...old.purchase!, prepared: { blockhash: review.prepared.transaction.recentBlockhash!,
        lastValidBlockHeight: review.prepared.lastValidBlockHeight, messageFingerprint: fingerprint } } }), guard);
      this.assertReview(review, guard);
      const signingRevision = this.state.journal!.revision;
      // Any throw/rejection/timeout is uncertain after this durable marker.
      const signed = await this.ports.sign(review.prepared);
      // Deliberately no session check: retain the public signature in its
      // ORIGINAL wallet journal before checking logout, page or time changes.
      const saved = await this.store.compareAndSet(signingRevision, old => ({ ...old, purchase: { ...old.purchase!, signature: signed.signature } }));
      guard(); review.guard(); this.publish({ journal: saved });
      const after = await this.readRecovery(guard);
      assertFundingRecovery(after);
      if (after.status !== 'known' || hasGemsBuyPaymentEvidence(this.purchase().deposit) || this.purchase().deposit?.status !== 'pending') throw new Error('Check the original payment evidence before continuing.');
      await this.policy(guard); this.assertReview(review, guard); await this.ports.live(review.prepared, guard); this.assertReview(review, guard);
      await this.write(old => ({ ...old, purchase: { ...old.purchase!, broadcastStarted: true } }), guard);
      this.assertReview(review, guard); await this.ports.broadcast(signed.wire, signed.signature, guard); guard();
      this.clearReview(); await this.reconcile(guard);
    });
  }
  private async reconcile(guard: Guard): Promise<void> {
    await this.readRecovery(guard); let p = this.purchase();
    if (!p.deposit?.receipt && p.quote) {
      if (p.signature) {
        try { guard(); await this.ports.post(`/deposits/${p.quote.id}/paid`, { signature: p.signature }, guard); }
        catch { guard(); /* reference verification can still recover the actual payment */ }
      }
      guard(); const raw = await this.ports.post(`/deposits/${p.quote.id}/verify`, {}, guard); guard();
      const deposit = parseGemsBuyDeposit(raw, p.quote);
      await this.write(old => ({ ...old, purchase: { ...old.purchase!, deposit } }), guard);
    }
    p = this.purchase();
    if (p.deposit?.receipt && !p.hydrated) {
      guard(); await this.ports.hydrate(p.deposit.receipt, guard); guard();
      await this.write(old => ({ ...old, purchase: { ...old.purchase!, hydrated: true } }), guard);
    }
  }
  recoverPayment(): Promise<void> { return this.action(false, async guard => { this.clearReview(); await this.reconcile(guard); }); }
  abandonDraft(): Promise<void> {
    return this.action(false, async guard => {
      const p = this.purchase(); if (p.prepared || p.signature || p.broadcastStarted || hasGemsBuyPaymentEvidence(p.deposit)) throw new Error('An attempted payment cannot be abandoned.');
      const evidence = await this.readRecovery(guard);
      await this.write(old => ({ ...old, purchase: null, archives: [...old.archives, { purchase: old.purchase!, reason: 'unattempted', evidence }] }), guard);
      this.clearReview();
    });
  }
  finish(): Promise<void> {
    return this.action(false, async guard => {
      await this.reconcile(guard);
      if (!this.purchase().hydrated) throw new Error('The original credited receipt is still required.');
      await this.write(old => ({ ...old, purchase: null, archives: [...old.archives, { purchase: old.purchase!, reason: 'credited', evidence: null }] }), guard);
      this.clearReview();
    });
  }
}
