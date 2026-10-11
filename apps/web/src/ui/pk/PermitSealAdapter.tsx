/**
 * Producer contract:
 * - Issue a new armedAtMs on EVERY terms change, including CHECKING to OK, and every re-raise.
 * - Keep the adapter mounted; dismiss it with review={null}.
 * - onConfirm synchronously commits a non-FAILED stage before any async work.
 * - P-M1: getSnapshot reads stage and attemptCounter from ONE live store;
 *   onConfirm advances the counter and publishes non-FAILED atomically before
 *   returning. FAILED(counter N) means attempt N has a result. Keep the identity
 *   five-tuple stable in flight, with one adapter per owner.
 * - P-M2: every onConfirm starts an attempt ending SENT or FAILED with an advanced
 *   counter, or rotates to a new identity AND requestId before re-offering. Never
 *   return a consumed identity to READY. The real producer MUST supply and retain
 *   attemptCounter through dismissal and refresh.
 * armedAtMs uses the Seal clock at the raise; never raise inside a transition.
 * Keep this adapter above the map screen's lifetime: map navigation generations
 * are not permit attempt identities. Never change requestId in flight; existing
 * server idempotency remains the backstop across navigation or owner recreation.
 *
 * The original owner supplies identity, idempotency and callbacks. This adapter
 * only gates consent; it discovers, dispatches and persists nothing. Publish a
 * monotonic attemptCounter for every owner attempt (including immediate failure)
 * and re-render on snapshot changes. It survives review dismissal/quote refresh
 * for the same identity. This counter lets FAILED retry without requiring React
 * to paint the intermediate sending stage; it is not a transaction identifier.
 */
import { useLayoutEffect, useReducer, useRef } from 'react';
import { PkSeal, type PkSealProps } from './Seal';
import { permitSealCanArm } from './map/MapLogic';
import { sealAccepts } from './kitLogic';
import type { MoneyStage, PriceUi, SealUi } from './types';

export interface PermitSealReviewIdentity {
  requestId: string;
  wallet: string;
  baseId: string | null;
  epoch: number;
  generation: number;
}
export interface PermitSealReview {
  identity: PermitSealReviewIdentity;
  ui: SealUi;
}
export interface PermitSealOwnerSnapshot {
  review: PermitSealReview | null;
  /** Only the original owner can attest that this exact review is current. */
  current: boolean;
  stage: MoneyStage;
  /** Non-negative safe integer, increased synchronously when each attempt starts,
   * then retained through its result. Supply consistently for an identity. When
   * absent, legacy snapshots need an observed non-FAILED commit for each retry. */
  attemptCounter?: number;
}
export interface PermitSealAdapterProps extends Pick<PkSealProps, 'onConfirm' | 'onCancel' | 'clock' | 'onExitFinished'> {
  review: PermitSealReview | null;
  /** Read the live original owner, never a captured controller state. */
  getSnapshot: () => PermitSealOwnerSnapshot | null;
}

const identityKey = (identity: PermitSealReviewIdentity): string => JSON.stringify([
  identity.requestId, identity.wallet, identity.baseId, identity.epoch, identity.generation,
]);
const priceTerms = (price: PriceUi | null | undefined) => price == null ? null
  : [price.currency, price.amount, price.status, price.icon ?? null, price.description ?? null];
const terms = (ui: SealUi): string => JSON.stringify([ui.title, ui.lines, priceTerms(ui.price),
  priceTerms(ui.gets), ui.confirmLabel, ui.backLabel ?? 'BACK', ui.armedAtMs]);
const validCounter = (counter: number): boolean => Number.isSafeInteger(counter) && counter >= 0;
interface AttemptLatch { consumedCounter: number | undefined; observedNonFailed: boolean }
interface RaiseRecord { terms: string; firstCommitAt: number; tainted: boolean }

export function PermitSealAdapter({ review, getSnapshot, onConfirm, onCancel, clock, onExitFinished }: PermitSealAdapterProps): React.JSX.Element {
  const attempts = useRef(new Map<string, AttemptLatch>());
  const firstPaint = useRef(new Map<string, RaiseRecord>());
  const latestRaise = useRef(new Map<string, string>());
  const cancelledRaises = useRef(new Set<string>());
  const counters = useRef(new Map<string, number>());
  const readClock = clock ?? Date.now;
  // A failed clock must refuse consent without removing the safe BACK action.
  // Use the same guarded read for Seal paint/taps and our commit/final tap checks.
  const now = (): number => { try { return readClock(); } catch { return Number.NaN; } };
  const [, repaint] = useReducer((revision: number) => revision + 1, 0);
  // Render takes value snapshots only. A suspended/discarded render must never
  // claim the first terms for this raise or advance any owner's attempt state.
  const painted = review ? { identity: identityKey(review.identity), terms: terms(review.ui),
    raise: JSON.stringify([identityKey(review.identity), review.ui.armedAtMs]) } : null;
  const readOwner = (): PermitSealOwnerSnapshot | null => {
    try { return getSnapshot(); } catch { return null; }
  };
  const currentOriginal = (): PermitSealOwnerSnapshot | null => {
    if (!painted) return null;
    try {
      const live = readOwner(), original = live?.review;
      return live?.current === true && original != null
        && painted.identity === identityKey(original.identity) && painted.terms === terms(original.ui) ? live : null;
    } catch { return null; }
  };
  useLayoutEffect(() => {
    let changed = false;
    if (painted) {
      const record = firstPaint.current.get(painted.raise);
      if (!record) {
        firstPaint.current.set(painted.raise, { terms: painted.terms, firstCommitAt: now(), tainted: false });
        latestRaise.current.set(painted.identity, painted.raise); changed = true;
      } else if (!record.tainted && record.terms !== painted.terms) {
        // Committed drift cannot be undone by echoing the original quote. A
        // discarded render still writes nothing, and older raises stay retired.
        record.tainted = true; changed = true;
      }
    }
    // Observation belongs to the original identity, even while the review is
    // dismissed, current is false, or temporary status text differs. Admission
    // below still requires current + exact first-painted terms + FAILED.
    const live = readOwner();
    if (live?.review) {
      const key = identityKey(live.review.identity), latch = attempts.current.get(key);
      if (latch && !latch.observedNonFailed && live.stage !== 'FAILED') {
        latch.observedNonFailed = true; changed = true;
      }
      const counter = live.attemptCounter, previous = counters.current.get(key);
      if (counter !== undefined && validCounter(counter) && (previous === undefined || counter > previous)) {
        counters.current.set(key, counter); changed = true;
      }
    }
    // Commit the first record before enabling the primary; do not wait for an
    // unrelated parent render, and do not mutate refs in canConfirm.
    if (changed) repaint();
  });
  const admits = (live: PermitSealOwnerSnapshot | null): boolean => {
    const record = painted ? firstPaint.current.get(painted.raise) : undefined;
    if (!painted || !live?.review || !record || record.tainted || record.terms !== painted.terms
      || latestRaise.current.get(painted.identity) !== painted.raise
      || cancelledRaises.current.has(painted.raise)
      || !permitSealCanArm(live.review.ui.price.status, live.stage)) return false;
    const counter = live.attemptCounter, previous = counters.current.get(painted.identity);
    // Once published, a counter may neither disappear nor run backwards.
    if (counter === undefined ? previous !== undefined
      : !validCounter(counter) || previous !== undefined && counter < previous) return false;
    const latch = attempts.current.get(painted.identity);
    if (!latch) return true;
    if (live.stage !== 'FAILED') return false;
    // A supplied counter is preferred over stage observation. Repeated FAILED
    // with the same counter is one consumed result, even across READY/re-raises.
    return latch.consumedCounter !== undefined
      ? counter !== undefined && counter > latch.consumedCounter
      : latch.observedNonFailed;
  };
  const committed = painted ? firstPaint.current.get(painted.raise) : undefined;
  const armFrom = review && committed ? Math.max(review.ui.armedAtMs, committed.firstCommitAt) : null;
  const canConfirm = (): boolean => admits(currentOriginal());
  const confirm = (): void => {
    const live = currentOriginal();
    if (!painted || !live || !admits(live) || armFrom === null || !sealAccepts(now(), armFrom)) return;
    // Five-tuple ONLY: neither new terms nor a new armedAtMs creates another
    // attempt slot. Consume synchronously before entering the owner's callback.
    attempts.current.set(painted.identity, { consumedCounter: live.attemptCounter, observedNonFailed: false });
    if (live.attemptCounter !== undefined) counters.current.set(painted.identity, live.attemptCounter);
    repaint(); onConfirm();
  };
  const cancel = (): void => {
    if (painted) cancelledRaises.current.add(painted.raise);
    repaint();
    // Cancellation is ungated. The original callback must clear its prompt.
    onCancel();
  };
  // The shared Seal paints the same commit-based arming interval that the final
  // adapter callback checks. Original owner terms/armedAtMs remain untouched.
  const sealUi = review && armFrom !== null ? { ...review.ui, armedAtMs: armFrom } : review?.ui ?? null;
  return <PkSeal ui={sealUi} canConfirm={canConfirm}
    onConfirm={confirm} onCancel={cancel} clock={now}
    {...(onExitFinished ? { onExitFinished } : {})} />;
}
