/**
 * Read-only projections of the existing claim owners. These helpers do not fetch, verify,
 * prepare, sign, submit, retry, create a journal, or establish permission to spend.
 *
 * The owner must establish scopeMatches before supplying its snapshot to this view. A
 * same-owner old observation remains useful evidence; an unproven owner scope exposes
 * neither its figures nor its original keys. observationCurrent is a separate witness.
 * Raw status/reason fields are metadata; render displayMessage rather than raw errors.
 */
import type { MiningClaimState } from '../../../lib/miningClaims/controller';
import type { MiningTaxClaimState } from '../../../lib/miningTaxClaims/controller';
import type { ForgeClaimState } from '../../../lib/forgeClaims/controller';
import { exactAmount, UNKNOWN } from '../kitLogic';
import type { MoneyStage } from '../types';
import type { MoneyFailure } from './goldForgeModel';

export interface ClaimAdmission {
  /** Existing owner has matched account, cluster and source scope. Default false. */
  scopeMatches?: boolean;
  /** Existing owner vouches for the current observation, not merely loaded storage. */
  observationCurrent?: boolean;
  actionsAllowed?: boolean;
  /** A real existing owner screen/recovery handoff is bound. Default false. */
  ownerHandoffReady?: boolean;
  /** The web hold permits fresh entry. It never controls original-request recovery. */
  freshEntryAllowed?: boolean;
  /** A retained observation after this error is historical, not fresh readiness. */
  refreshError?: string | null;
}
export interface MiningTaxClaimAdmission extends ClaimAdmission {
  /** Exact existing hook/store held decision; absent means held. Do not reconstruct it. */
  ownerHeld?: boolean;
}
export interface ForgeClaimAdmission extends ClaimAdmission {
  /** Existing Forge owner explicitly vouches that a fresh review is ready. Default false. */
  ownerReady?: boolean;
}
export interface ClaimRecoveryProjection {
  available: boolean;
  requestKey: string | null;
  continuationRequestKey: string | null;
  held: boolean;
  /** Navigation to the existing owner's recovery only; never a signing/retry permission. */
  canOpen: boolean;
}
interface OwnerReadState { loaded: boolean; busy: boolean; error: string | null }
interface ProjectionCommon {
  current: boolean;
  stage: MoneyStage;
  failure: MoneyFailure | null;
  displayMessage: string;
  /** Only navigation to an existing owner; that owner rechecks its own action gates. */
  canOpenNewFlow: boolean;
  recovery: ClaimRecoveryProjection;
  /** Historical receipt observation never retriggers a reward animation. */
  celebration: false;
}
type MiningStatus = NonNullable<MiningClaimState['status']>;
export interface MiningClaimProjection extends ProjectionCommon {
  amountBaseUnits: string | null;
  amountLabel: string;
  paidBaseUnits: string | null;
  paidLabel: string;
  status: MiningStatus['state'] | null;
  reason: MiningStatus['reason'];
  observedAt: string | null;
}
export interface MiningTaxClaimProjection extends ProjectionCommon {
  /** The original preparation's intended amount, not a payout or current saved balance. */
  intendedBaseUnits: string | null;
  paidBaseUnits: string | null;
  /** Existing owner openHistory key, separate from the active original/continuation. */
  historicalRequestKey: string | null;
  /** Scoped history exists; the owner separately gates navigation. Never retry permission. */
  historyAvailable: boolean;
  status: 'unknown' | 'saved' | 'prepared' | 'checking' | 'setup' | 'settled';
  reason: null;
}
export interface ForgeClaimProjection extends ProjectionCommon {
  /** Exact historical ledger result only. Never use it as current saved KEEP. */
  historicalKeep: string | null;
  historicalKeepLabel: string;
  status: 'unknown' | 'unavailable' | 'paused' | 'available' | 'saved' | 'recorded' | 'finished';
  reason: null;
}

function currentObservation(state: OwnerReadState, admission: ClaimAdmission): boolean {
  return admission.scopeMatches === true && admission.observationCurrent === true
    && state.loaded && !state.busy && state.error === null && admission.refreshError == null;
}
function freshEntry(current: boolean, admission: ClaimAdmission): boolean {
  return current && admission.actionsAllowed === true && admission.ownerHandoffReady === true
    && admission.freshEntryAllowed === true;
}
function recoveryProjection(
  state: OwnerReadState, admission: ClaimAdmission, journalKnown: boolean,
  requestKey: string | null, continuationRequestKey: string | null, held: boolean, pending: boolean,
): ClaimRecoveryProjection {
  const scoped = admission.scopeMatches === true;
  const available = scoped && (pending || !state.loaded || !journalKnown || state.error !== null || admission.refreshError != null);
  return {
    available,
    requestKey: scoped ? requestKey : null,
    continuationRequestKey: scoped ? continuationRequestKey : null,
    held: scoped && held,
    canOpen: available && admission.ownerHandoffReady === true && !state.busy,
  };
}
const positiveBaseUnits = (amount: string | null): boolean => amount !== null && /^\d+$/.test(amount) && /[1-9]/.test(amount);

/** Current claimable KEEP is exclusively status.claimableBaseUnits, never cumulative entitlement. */
export function projectMiningClaim(state: MiningClaimState, admission: ClaimAdmission = {}): MiningClaimProjection {
  const scoped = admission.scopeMatches === true;
  const observed = scoped ? state.status : null;
  const operation = scoped ? state.journal?.operation ?? null : null;
  const current = currentObservation(state, admission) && observed !== null;
  const amountBaseUnits = observed?.claimableBaseUnits ?? null;
  const paidBaseUnits = operation?.claim?.state === 'settled' ? operation.claim.settledBaseUnits : null;
  const paid = paidBaseUnits !== null;
  const refused = operation !== null && operation.prepareRefusal !== null && operation.refusalConfirmedAbsent
    && operation.preparation === null && operation.signed === null && operation.claim === null
    && !operation.signingStarted && !operation.submitAttempted && !operation.ordered?.held;
  // Durable attempt markers do not prove that a wallet is currently open or that anything was sent.
  const uncertain = operation !== null && !paid && !refused && (
    operation.prepareAttempted && operation.preparation === null || operation.signingStarted
    || operation.signed !== null || operation.submitAttempted || operation.claim?.state === 'retained'
    || operation.claim?.state === 'failed' || operation.ordered?.held === true
    || operation.ordered?.remainder.signingStarted === true || operation.ordered?.remainder.signed != null
    || operation.ordered?.remainder.submitAttempted === true || operation.ordered?.continuationAttempted === true
  );
  const stage: MoneyStage = paid ? 'SENT' : refused || uncertain ? 'FAILED' : 'READY';
  const recovery = recoveryProjection(state, admission, state.journal !== null,
    operation?.request.idempotencyKey ?? null, operation?.ordered?.continuationRequest?.idempotencyKey ?? null,
    operation?.ordered?.held ?? false, operation !== null);
  let displayMessage = 'Checking your coins…';
  if (scoped && recovery.available) displayMessage = paid ? 'Your saved collection is complete.'
    : refused ? 'The saved collection was declined.' : 'Check your saved collection.';
  else if (current && observed) {
    switch (observed.state) {
      case 'unavailable': displayMessage = 'Coins are not open yet.'; break;
      case 'no_allocation': displayMessage = 'No coins allocated yet.'; break;
      case 'ready': displayMessage = 'Coins are ready to collect.'; break;
      case 'delayed': displayMessage = 'These coins open later.'; break;
      case 'paused': displayMessage = 'New collections are paused.'; break;
      case 'revoked': displayMessage = 'This allocation is unavailable.'; break;
      case 'claimed': displayMessage = 'These coins were collected.'; break;
    }
  }
  return {
    amountBaseUnits,
    amountLabel: observed ? exactAmount(amountBaseUnits, observed.decimals) : UNKNOWN,
    paidBaseUnits,
    paidLabel: observed ? exactAmount(paidBaseUnits, observed.decimals) : UNKNOWN,
    status: observed?.state ?? null, reason: observed?.reason ?? null, observedAt: observed?.serverNow ?? null,
    current, stage, failure: refused ? 'REFUSED' : uncertain ? 'UNCERTAIN' : null, displayMessage,
    canOpenNewFlow: freshEntry(current, admission) && state.journal !== null && state.review === null
      && operation === null && observed?.state === 'ready' && observed.preparationAllowed && positiveBaseUnits(amountBaseUnits),
    recovery, celebration: false,
  };
}

/** Island tax claims are original claim recovery, not old Forge withdrawals or saved KEEP. */
export function projectMiningTaxClaim(state: MiningTaxClaimState, admission: MiningTaxClaimAdmission = {}): MiningTaxClaimProjection {
  const scoped = admission.scopeMatches === true;
  const operation = scoped ? state.journal?.operation ?? null : null;
  // An archive pointer is history, not an active claim or evidence of a payout.
  const historicalRequestKey = scoped ? state.journal?.lastArchivedKey ?? null : null;
  const settlement = operation?.settlement?.settlement ?? null;
  const paidBaseUnits = settlement?.claimFinalized === true && settlement.receipt.phase === 'settled'
    && operation?.settlement?.status === 'settled' ? settlement.receipt.paidKeepBaseUnits : null;
  const paid = paidBaseUnits !== null;
  const setup = operation?.setup?.settlement?.receipt.phase === 'setup';
  const attempted = operation !== null && (operation.prepareAttempted || operation.transactions.length > 0
    || operation.observed.length > 0 || operation.unattributedObserved || operation.failureObserved === true
    || operation.continuationObserved === true || operation.continuation?.attempted === true);
  const held = admission.ownerHeld !== false || state.settlementHeld;
  const recovery = recoveryProjection(state, admission, state.journal !== null,
    operation?.request.idempotencyKey ?? null, operation?.continuation?.request.idempotencyKey ?? null,
    held, operation !== null || scoped && state.settlementHeld);
  return {
    intendedBaseUnits: operation?.preparation?.intended.claimBaseUnits ?? null,
    paidBaseUnits,
    historicalRequestKey, historyAvailable: historicalRequestKey !== null,
    status: paid ? 'settled' : setup ? 'setup' : attempted ? 'checking' : operation?.preparation ? 'prepared' : operation ? 'saved' : 'unknown',
    reason: null,
    current: currentObservation(state, admission),
    stage: paid ? 'SENT' : attempted ? 'FAILED' : 'READY', failure: !paid && attempted ? 'UNCERTAIN' : null,
    displayMessage: paid ? 'Your saved collection is complete.' : recovery.available ? 'Check your saved collection.' : 'Checking your coins…',
    // This snapshot has no authoritative status for a new round/spot claim. Do not infer one from a saved quote.
    canOpenNewFlow: false,
    recovery, celebration: false,
  };
}

/** Forge receipts prove historical ledger activity; current saved KEEP and withdrawals need their own owner. */
export function projectForgeClaim(state: ForgeClaimState, admission: ForgeClaimAdmission = {}): ForgeClaimProjection {
  const scoped = admission.scopeMatches === true;
  const journal = scoped ? state.journal : null;
  const receipt = journal?.receipt ?? null;
  const pending = journal?.intent != null && !journal.finished;
  const current = currentObservation(state, admission);
  const historicalKeep = receipt?.result.totalKeep ?? null;
  const recovery = recoveryProjection(state, admission, state.journal !== null,
    journal?.intent?.request.idempotencyKey ?? null, null, false, pending);
  const status: ForgeClaimProjection['status'] = !scoped || !state.loaded ? 'unknown'
    : receipt ? journal?.finished ? 'finished' : 'recorded'
      : pending ? 'saved' : !state.supported ? 'unavailable' : !state.enabled ? 'paused' : 'available';
  return {
    historicalKeep, historicalKeepLabel: exactAmount(historicalKeep), status, reason: null, current,
    stage: receipt ? 'SENT' : pending ? 'FAILED' : 'READY', failure: !receipt && pending ? 'UNCERTAIN' : null,
    displayMessage: receipt ? 'The saved forge result is recorded.' : recovery.available ? 'Check the saved forge request.' : 'Checking the forge…',
    canOpenNewFlow: freshEntry(current, admission) && admission.ownerReady === true && state.supported && state.enabled
      && journal !== null && !pending && state.review === null,
    recovery, celebration: false,
  };
}
