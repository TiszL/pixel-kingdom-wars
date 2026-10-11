/** Controlled, unmounted consent artifact. The original owner supplies identity,
 * quote, admission and callbacks; this module creates no request or recovery flow.
 *
 * Composition requires F2ab's Seal guard v1 and accepted Seal v2 (be028ffc),
 * with required, throw-safe canConfirm. Import from the lazy Gold Forge chunk.
 * The shared Seal currently cannot draw the SPEC §6 subject art/progress row or
 * blue GET GEMS action, or bypass arming for SERVER_ZERO. This bounded consumer
 * uses its text lines and holds SHORT / SERVER_ZERO. It claims no visual parity.
 * Original paid recovery remains a separate owner-controlled surface/callback.
 * Producer contract: issue a new armedAtMs on every consent/quote terms change,
 * including CHECKING to OK, and on every re-raise, also after review=null.
 * Keep this adapter mounted. The production owner must supply attemptCounter;
 * getSnapshot reads counter and stage from one live store. onConfirm advances
 * the counter and publishes non-FAILED atomically before returning/async work.
 * FAILED with counter N means attempt N has a result. Never return a consumed
 * identity to READY. Each confirm starts an attempt ending SENT/FAILED with an
 * advanced counter, or the owner rotates identity/requestId before re-offering.
 * Keep one adapter per owner, identity stable in flight and counters retained
 * through dismissal/refresh. This consumer never invents an attempt counter.
 * Every retry is a new consent: its armedAtMs is the owner's actual new raise
 * time, strictly later than the last issued normalized arm, and completes the
 * full shared arming delay. An already elapsed timestamp is not a fresh raise;
 * counter advancement or stage observation never waives this requirement.
 * cbe4a25b: use the Seal clock at each actual raise, outside a transition. The
 * visible delay starts at the later of that arm and its first layout commit.
 * Committed quote drift permanently taints that identity/arm; returning to an
 * older arm never restores admission. Discarded renders claim no raise custody.
 * 6f91e67a: an older committed arm interrupts the latest arm too. A committed
 * visible-to-null dismissal closes all earlier raise records. Only a strictly
 * newer arm can reopen consent; neither event releases attempts or counters.
 * 75420333 M-1: a committed identity switch or invalid-arm interlude also closes
 * earlier raises. Track the visible identity/normalized-arm key at layout,
 * including an invalid-arm sentinel, and advance the serial before recording
 * a changed raise. Same-arm stage updates never advance that serial.
 * Freeze timeLeft (shared fmtDur) and progress per raise, or issue a new raise.
 * Retried originals retain every issued quote term, including frozen timeLeft
 * and progress; a new retry arm does not permit a replacement financial quote.
 */
import { useLayoutEffect, useReducer, useRef } from 'react';
import { PkSeal, type PkSealProps } from '../Seal';
import { sealAccepts, UNKNOWN } from '../kitLogic';
import type { MoneyStage, PriceUi, SealUi } from '../types';
import { normalizeSpendArmedAt } from './GoldForgeInput';
import type { GemSpendUi } from './goldForgeModel';

export interface GoldForgeSpendIdentity {
  requestId: string;
  /** Identity binding only, never rendered as a wallet app name or destination. */
  wallet: string;
  baseId: string | null;
  epoch: number;
  generation: number;
}
export interface GoldForgeSpendReview {
  identity: GoldForgeSpendIdentity;
  /** Exact formatted values from the original owner, never local price math. */
  ui: GemSpendUi;
}
export interface GoldForgeSpendSnapshot {
  review: GoldForgeSpendReview | null;
  /** Current original request, session and controller identity, attested by owner. */
  current: boolean;
  actionsAllowed: boolean;
  /** Explicit fresh-action admission, including the current Gems hold. */
  freshActionsAllowed: boolean;
  /** Original owner explicitly admits retry of this same refused request. */
  retryAllowed: boolean;
  /** Original owner's safe, nonnegative monotonic attempt counter. Incremented
   * by that owner on an attempt, not by local taps. Once observed for an identity,
   * missing/backtracking counters hold. A counter-bound retry requires a value
   * greater than the last issued value; stage-only fallback cannot release it.
   * Optional for the held artifact's legacy path; mandatory before production
   * binding under 6f91e67a, with coherent stage/counter publication. */
  attemptCounter?: number;
}
export interface GoldForgeSpendSealProps extends Pick<PkSealProps, 'clock' | 'onExitFinished'> {
  review: GoldForgeSpendReview | null;
  /** Pure, cheap live getter, not a captured React/controller state. Re-render on
   * every eligibility/stage change; a missed render can only leave consent closed. */
  getSnapshot: () => GoldForgeSpendSnapshot | null;
  /** Reuses this original identity and its original idempotency key. No begin call. */
  onConfirm: (original: GoldForgeSpendIdentity) => void;
  /** Always available. The original owner clears its prompt on cancellation. */
  onCancel: () => void;
}

interface Attempt {
  quote: string;
  armedAtMs: number;
  issuedStage: MoneyStage;
  observedNonFailed: boolean;
  counter: number | null;
}
interface CommittedRaise {
  quote: string;
  firstCommitAt: number;
  dismissalSerial: number;
  tainted: boolean;
}
const validIdentity = (id: GoldForgeSpendIdentity): boolean =>
  typeof id.requestId === 'string' && id.requestId.trim() !== ''
  && typeof id.wallet === 'string' && id.wallet.trim() !== ''
  && (id.baseId === null || (typeof id.baseId === 'string' && id.baseId.trim() !== ''))
  && Number.isSafeInteger(id.epoch) && id.epoch >= 0
  && Number.isSafeInteger(id.generation) && id.generation >= 0;
const identityKey = (id: GoldForgeSpendIdentity): string => JSON.stringify([
  id.requestId, id.wallet, id.baseId, id.epoch, id.generation,
]);
/** Include all quote/subject fields even where the bounded shared Seal has no
 * visual slot yet. Serialize values at paint, not mutable object references. */
const originalQuoteTerms = (ui: GemSpendUi): string => JSON.stringify([
  ui.kind, ui.title, ui.subjectArt, ui.subjectName, ui.subjectLine,
  // JSON otherwise conflates malformed NaN/Infinity with the unknown null value.
  ui.progress === null || Number.isFinite(ui.progress) ? ui.progress : String(ui.progress),
  ui.timeLeft, ui.price.currency, ui.price.amount, ui.price.status,
  ui.price.icon ?? null, ui.price.description ?? null, ui.have, ui.after, ui.short,
  ui.quotedAtMs, ui.unavailableReason ?? null,
]);
const quoteTerms = (ui: GemSpendUi): string => JSON.stringify([
  originalQuoteTerms(ui), ui.armedAtMs ?? ui.quotedAtMs, normalizeSpendArmedAt(ui),
]);
const displayedTerms = (ui: GemSpendUi): string => JSON.stringify([
  quoteTerms(ui), ui.stage, ui.failure ?? null, ui.unavailableReason ?? null,
]);
const known = (value: string | null): string => value == null || value.trim() === '' ? UNKNOWN : value;
/** Validate formatted exactAmount-style text without parsing an economy amount
 * through Number. Only SERVER_ZERO may describe free; this artifact holds it. */
const positiveQuote = (value: string | null): boolean => value != null
  && /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);
const validProgress = (value: number | null): boolean => value === null
  || (Number.isFinite(value) && value >= 0 && value <= 1);
const validCounter = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

function displayedPrice(price: PriceUi): PriceUi {
  if (price.currency !== 'GEMS' || ((price.status === 'OK' || price.status === 'SHORT') && !positiveQuote(price.amount))) {
    // Invalid cost text cannot introduce a zero/negative/malformed price, even
    // on a disabled action. Drop stale icon/accessibility overrides with it.
    return { currency: 'GEMS', amount: null, status: 'CHECKING' };
  }
  return { ...price };
}

function sealUi(ui: GemSpendUi, effectiveArm: number): SealUi {
  const short = ui.short !== null || ui.price.status === 'SHORT';
  const refusedRetry = ui.stage === 'FAILED' && ui.failure === 'REFUSED';
  const lines = [known(ui.subjectName), known(ui.subjectLine), `${known(ui.timeLeft)} saved`,
    short ? `You have ${known(ui.have)} Gems. Need ${known(ui.short)} more.`
      : `You have ${known(ui.have)} Gems${ui.after === null ? '' : ` · ${known(ui.after)} after`}`];
  if (short) lines.push('Not enough Gems');
  if (short || ui.price.status !== 'OK' || ui.price.currency !== 'GEMS' || !positiveQuote(ui.price.amount)
    || normalizeSpendArmedAt(ui) === null || (ui.stage !== 'READY' && !refusedRetry)) lines.push('Return to the original review');
  return {
    title: known(ui.title), lines, price: displayedPrice(ui.price),
    confirmLabel: short ? 'NOT ENOUGH' : refusedRetry ? 'RETRY' : ui.kind,
    // Effective presentation time may only delay the original arm. Infinity is
    // a never-armed sentinel until a valid layout commit, not a normalized quote
    // timestamp; it never enters quoteArmStart or changes the original identity.
    armedAtMs: effectiveArm,
  };
}

export function GoldForgeSpendSeal({ review, getSnapshot, onConfirm, onCancel, clock,
  onExitFinished }: GoldForgeSpendSealProps): React.JSX.Element {
  // Preserve issued originals across requotes, dismissal and identity revisits.
  // Controller lifetime/idempotency remains the authority across remounts.
  const attempts = useRef(new Map<string, Attempt>());
  const firstTerms = useRef(new Map<string, CommittedRaise>());
  const latestArm = useRef(new Map<string, number>());
  const dismissalSerial = useRef(0);
  const lastCommittedArmKey = useRef<string | null>(null);
  const cancelled = useRef(new Set<string>());
  const counterHighWater = useRef(new Map<string, number>());
  const [, renderRecordedTerms] = useReducer((version: number) => version + 1, 0);
  const painted = review === null ? null : {
    identity: { ...review.identity }, key: identityKey(review.identity),
    validIdentity: validIdentity(review.identity),
    validProgress: validProgress(review.ui.progress),
    terms: displayedTerms(review.ui), quote: quoteTerms(review.ui), originalQuote: originalQuoteTerms(review.ui),
    armedAtMs: normalizeSpendArmedAt(review.ui),
    armKey: JSON.stringify([identityKey(review.identity), normalizeSpendArmedAt(review.ui)]),
  };
  const read = (): GoldForgeSpendSnapshot | null => {
    try { return getSnapshot(); } catch { return null; }
  };
  const readClock = (): number => {
    try {
      const now = (clock ?? Date.now)();
      return Number.isFinite(now) && now >= 0 ? now : Number.NEGATIVE_INFINITY;
    } catch { return Number.NEGATIVE_INFINITY; }
  };
  const observeAttempt = () => {
    const snapshot = read(), original = snapshot?.review;
    if (!snapshot || !original || !validIdentity(original.identity)) return;
    // Capture primitives immediately; never retain mutable owner references for
    // a later effect. This observation does not grant current/quote admission.
    const key = identityKey(original.identity), stage = original.ui.stage, counter = snapshot.attemptCounter;
    if (counter !== undefined) {
      if (!validCounter(counter)) return;
      const highest = counterHighWater.current.get(key);
      if (highest !== undefined && counter < highest) return;
      counterHighWater.current.set(key, counter);
    }
    const attempt = attempts.current.get(key);
    if (attempt && (stage === 'READY' || stage === 'CHECK_WALLET' || stage === 'SENDING' || stage === 'SENT')) {
      attempt.observedNonFailed = true;
    }
  };
  useLayoutEffect(() => {
    let changed = false;
    // armKey includes identity and normalized time, including a null-time
    // sentinel inside the string. A null key here means no visible picture.
    // Track invalid arms outside the valid-record branch. Advance BEFORE first
    // record creation so a fresh raise gets the current serial; old records are
    // never restamped. Discarded renders and repeated keys change nothing.
    const visibleArmKey = painted?.armKey ?? null;
    if (visibleArmKey !== lastCommittedArmKey.current) {
      dismissalSerial.current++;
      lastCommittedArmKey.current = visibleArmKey;
      changed = true;
    }
    if (painted?.validIdentity && painted.armedAtMs !== null) {
      const latest = latestArm.current.get(painted.key);
      if (latest !== undefined && painted.armedAtMs < latest) {
        const interrupted = firstTerms.current.get(JSON.stringify([painted.key, latest]));
        if (interrupted && !interrupted.tainted) {
          interrupted.tainted = true;
          changed = true;
        }
      }
      const recorded = firstTerms.current.get(painted.armKey);
      if (!recorded) {
        firstTerms.current.set(painted.armKey, { quote: painted.quote, firstCommitAt: readClock(),
          dismissalSerial: dismissalSerial.current, tainted: false });
        if (latest === undefined || painted.armedAtMs > latest) latestArm.current.set(painted.key, painted.armedAtMs);
        changed = true;
      } else if (!recorded.tainted && recorded.quote !== painted.quote) {
        recorded.tainted = true;
        changed = true;
      }
    }
    observeAttempt();
    // Only committed changes cause one bounded repaint. No record/custody writes
    // occur during render or a predicate, so abandoned renders cannot poison it.
    if (changed) renderRecordedTerms();
  });

  const recorded = painted === null ? undefined : firstTerms.current.get(painted.armKey);
  const effectiveArm = painted?.armedAtMs != null && recorded && Number.isFinite(recorded.firstCommitAt)
    ? Math.max(painted.armedAtMs, recorded.firstCommitAt) : Number.POSITIVE_INFINITY;
  const admitted = (): { original: GoldForgeSpendReview; counter: number | null } | null => {
    // Read current records at each tap, including before React repaints after a
    // layout write. Structural eligibility stays clock-free: PkSeal has no timer
    // that could re-enable a primary disabled solely for the arming interval.
    const committed = painted === null ? undefined : firstTerms.current.get(painted.armKey);
    if (!painted?.validIdentity || !painted.validProgress || painted.armedAtMs === null
      || !committed || committed.tainted || committed.quote !== painted.quote || !Number.isFinite(committed.firstCommitAt)
      || committed.dismissalSerial !== dismissalSerial.current
      || latestArm.current.get(painted.key) !== painted.armedAtMs || cancelled.current.has(painted.armKey)) return null;
    const live = read(), original = live?.review;
    if (live?.current !== true || live.actionsAllowed !== true || live.freshActionsAllowed !== true || !original
      || !validIdentity(original.identity)
      || identityKey(original.identity) !== painted.key || displayedTerms(original.ui) !== painted.terms
      || normalizeSpendArmedAt(original.ui) !== painted.armedAtMs) return null;
    const ui = original.ui;
    if (ui.price.currency !== 'GEMS' || ui.price.status !== 'OK' || !positiveQuote(ui.price.amount)
      || ui.short !== null || !validProgress(ui.progress)) return null;
    const suppliedCounter = live.attemptCounter, highest = counterHighWater.current.get(painted.key);
    if (suppliedCounter !== undefined && !validCounter(suppliedCounter)) return null;
    const counter = suppliedCounter ?? null;
    if (highest !== undefined && (counter === null || counter < highest)) return null;
    const attempt = attempts.current.get(painted.key);
    const result = { original, counter };
    if (ui.stage === 'READY') return attempt === undefined ? result : null;
    if (ui.stage !== 'FAILED' || ui.failure !== 'REFUSED' || live.retryAllowed !== true) return null;
    if (attempt) {
      // 1088ff5e: even a fast authoritative refusal needs a new consent window.
      // Do not let a counter/stage update or an older used arm reopen this one.
      if (painted.armedAtMs <= attempt.armedAtMs) return null;
      if (attempt.quote !== painted.originalQuote) return null;
      if (attempt.counter !== null) {
        if (counter === null || counter <= attempt.counter) return null;
      } else if (attempt.issuedStage === 'FAILED' && !attempt.observedNonFailed) return null;
    }
    return result;
  };
  const confirm = () => {
    // Shared Seal gates the displayed effective arm at tap. Repeat the clock
    // check before consuming anything, then recheck the live owner admission.
    if (!sealAccepts(readClock(), effectiveArm)) return;
    const allowed = admitted();
    if (!painted || painted.armedAtMs === null || !allowed) return;
    // Set BEFORE callback, including when it throws or schedules a later render.
    attempts.current.set(painted.key, { quote: painted.originalQuote, armedAtMs: painted.armedAtMs, issuedStage: allowed.original.ui.stage,
      observedNonFailed: false, counter: allowed.counter });
    if (allowed.counter !== null) counterHighWater.current.set(painted.key, allowed.counter);
    try { onConfirm({ ...painted.identity }); }
    finally {
      // The owner's required synchronous non-FAILED commit may never get its
      // own React paint before a fast failure. Observe it now as well as at commit.
      observeAttempt();
    }
  };
  const cancel = () => {
    // Close synchronously before even a throwing/asynchronous owner callback;
    // a second event in the same frame cannot confirm the cancelled review.
    if (painted) cancelled.current.add(painted.armKey);
    onCancel();
  };
  return <PkSeal ui={review === null ? null : sealUi(review.ui, effectiveArm)} canConfirm={() => admitted() !== null}
    onConfirm={confirm} onCancel={cancel} clock={readClock}
    {...(onExitFinished === undefined ? {} : { onExitFinished })} />;
}
