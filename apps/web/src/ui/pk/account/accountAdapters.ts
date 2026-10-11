/** Pure snapshot-to-presentation adapters. Existing hooks/controllers retain custody. */
import type { usePayEntry, LandReservation } from '../../../auth/useEntry';
import type { BasesDto, WalletBaseDto } from '../../../lib/api';
import type { FreeBasePurchaseState } from '../../../lib/freeBasePurchase/controller';
import type { FreeBasePurchaseSnapshot } from '../../../lib/freeBasePurchase/snapshot';
import type { FreeBasePurchaseAdmissionReason } from '@shardkeep/shared/freeBasePurchaseApi';
import type { PriceUi } from '../types';
import type { AccountAction, AccountRow, AccountSheetProps, KingdomSummary } from './AccountSheets';

type SolPrice = PriceUi & { currency: 'SOL' };
export interface LandAdapterInput {
  entry: Pick<ReturnType<typeof usePayEntry>, 'phase' | 'reservation' | 'error' | 'paymentSignature'>;
  kind: LandReservation['kind'];
  walletLinked: boolean;
  entryPaid: boolean | null;
  actionsEnabled: boolean;
  serverOffReason: string | null;
  /** Current authoritative land quote; never a locally chosen fee. */
  quotedPrice: SolPrice;
  /** Existing host SOL formatter. Receives the reservation's exact safe-integer lamports. */
  formatReservedLamports: (raw: number) => string;
}
export interface AccountAdapterModel {
  rows: AccountRow[];
  primary: AccountAction | null;
  load: NonNullable<AccountSheetProps['load']>;
  note: string | null;
}

export function accountLandModel(input: LandAdapterInput): AccountAdapterModel {
  const { entry } = input;
  const unknownPrice: SolPrice = { currency: 'SOL', amount: null, status: 'UNAVAILABLE' };
  const reservation = entry.reservation;
  const reservationValid = !!reservation && reservation.kind === input.kind
    && Number.isSafeInteger(reservation.amountLamports) && reservation.amountLamports > 0;
  const price: SolPrice = entry.phase === 'ready'
    ? reservationValid ? { currency: 'SOL', amount: input.formatReservedLamports(reservation!.amountLamports), status: 'OK' } : unknownPrice
    : input.quotedPrice;
  const model: AccountAdapterModel = {
    rows: [{ id: 'land.price', title: 'LAND PRICE', price }],
    primary: { id: 'land.choose', label: 'CHOOSE REALM', state: 'ENABLED', kind: 'navigate', price },
    load: 'READY', note: entry.error,
  };
  // Recovery and confirmed payment are independent of new-action capability.
  if (entry.phase === 'failed') return { ...model, primary: { id: 'land.history', label: 'PAYMENT HISTORY', state: 'ENABLED', kind: 'navigate' },
    note: entry.error ?? 'Your payment needs to be checked. Keep its original receipt.' };
  if (entry.phase === 'credited') return { ...model, primary: { id: 'account.profile.kingdoms', label: 'VIEW YOUR KINGDOMS', state: 'ENABLED', kind: 'navigate' },
    note: 'Payment confirmed. Check your kingdom for the deed status.' };
  if (entry.phase === 'restoring' || entry.phase === 'reserving' || entry.phase === 'paying' || entry.phase === 'confirming') {
    const label = entry.phase === 'paying' ? 'CHECK WALLET' : entry.phase === 'reserving' ? 'RESERVING LAND' : 'CHECKING PAYMENT';
    return { ...model, primary: { id: 'land.pending', label, state: 'BUSY', kind: 'review' },
      note: entry.error ?? (entry.phase === 'reserving' ? 'The server is reserving your land.' : 'We are checking your payment. Keep the original request.') };
  }
  if (input.serverOffReason || !input.actionsEnabled) return { ...model, primary: { ...model.primary!, state: 'LOCKED', reason: input.serverOffReason ?? 'Land purchases are not open here.' } };
  if (input.entryPaid === null) return { ...model, primary: { ...model.primary!, state: 'DISABLED', reason: 'Checking land ownership.' } };
  if (!input.walletLinked) return { ...model, primary: { id: 'wallet.connect', label: 'CONNECT WALLET', state: 'ENABLED', kind: 'navigate' } };
  if (input.entryPaid && input.kind === 'entry') return { ...model, primary: { id: 'account.profile.kingdoms', label: 'VIEW YOUR KINGDOMS', state: 'ENABLED', kind: 'navigate' } };
  if (entry.phase === 'ready') return { ...model, primary: { id: 'land.payment.review', label: 'REVIEW LAND PAYMENT', state: reservationValid ? 'ENABLED' : 'DISABLED',
    kind: 'review', price, ...(reservationValid ? {} : { reason: 'The original land reservation is unavailable.' }) } };
  return model;
}

export interface KingdomsAdapterInput {
  wallet: string | null;
  entryPaid: boolean | null;
  directory: BasesDto | null;
  selectedBaseId: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  /** Existing baseLocationLabel/fantasy-directory host mapping, never a guessed realm. */
  realmLabel: (base: WalletBaseDto) => string;
  freePurchase: {
    state: FreeBasePurchaseState;
    snapshot: FreeBasePurchaseSnapshot | null;
    actionsAllowed: boolean;
    refreshError: string | null;
  };
}
export interface KingdomsAdapterModel extends AccountAdapterModel { summary?: KingdomSummary }
const PURCHASE_REASON: Record<FreeBasePurchaseAdmissionReason, string> = {
  ready: '', disabled: 'Second free camps are not open here.', 'stable-bases-required': 'Wait for stable kingdom ownership.',
  'already-purchased': 'This second free camp has already been purchased.', 'source-required': 'Choose the original free camp.',
  'source-unavailable': 'The original kingdom is unavailable.', 'source-not-free': 'Choose a free camp as the source.',
  'source-reserved': 'This kingdom has a saved purchase request.', 'full-roster': 'Your active kingdom slots are full.',
  'development-required': 'Develop the source kingdom to the server requirements.', 'insufficient-shards': 'Not enough SHARDS.',
  'being-raided': 'Wait until this kingdom is no longer being raided.',
};
/** Copy only: definitive classification remains in the existing journal/controller. */
const PURCHASE_REFUSAL_COPY: Readonly<Record<string, string>> = {
 BASE_NOT_OWNED: 'The original kingdom is no longer yours.',
 BASE_ID_REQUIRED: 'Choose the original kingdom before reviewing this purchase.',
 DEED_OWNERSHIP_CHANGED: 'Kingdom deed ownership changed. Refresh your kingdoms.',
 BASE_BEING_RAIDED: 'The original kingdom is being raided. Wait before reviewing another purchase.',
 DEED_AUTHORITY_UNAVAILABLE: 'Deed ownership could not be verified. Check again later.',
 PHASE_E_DISABLED: 'Second free camp purchases are not open here.',
 FREE_BASE_SOURCE_REQUIRED: 'Choose a free camp as the original source.',
 FREE_BASE_SOURCE_RESERVED: 'The original kingdom has a saved purchase request.',
 BASE_SLOTS_FULL: 'Your active kingdom slots are full.',
 FREE_BASE_DEVELOPMENT_REQUIRED: 'Develop the source kingdom to the server requirements.',
 INSUFFICIENT_SHARDS: 'Not enough SHARDS.',
};

export function accountKingdomsModel(input: KingdomsAdapterInput): KingdomsAdapterModel {
  const { directory, freePurchase } = input;
  const { state, snapshot } = freePurchase;
  const readable = directory?.enabled === true && directory.capabilities.baseScopedReads;
  const fresh = readable && !input.loading && !input.busy && input.error === null;
  const active = directory?.bases.filter(base => base.status === 'active' && base.slot !== null) ?? [];
  const rows: AccountRow[] = (directory?.bases ?? []).map((base): AccountRow => {
    const selected = base.id === input.selectedBaseId;
    const isActive = base.status === 'active' && base.slot !== null;
    return { id: base.id, title: `KEEP ${base.keepLevel}`, sub: input.realmLabel(base),
      value: base.deedAssetId ? 'Kingdom Deed' : base.landPaidAt ? 'Land paid · deed pending' : 'Free camp · no deed',
      tag: selected ? 'CURRENT' : isActive ? 'ACTIVE' : 'INACTIVE',
      action: { id: `${isActive ? 'kingdom.switch' : 'kingdom.manage'}:${base.id}`, label: selected && isActive ? 'CURRENT KINGDOM' : isActive ? 'SWITCH' : 'MANAGE DEED',
        state: fresh && (!selected || !isActive) ? 'ENABLED' : 'DISABLED', kind: 'navigate' },
    };
  });
  if (directory) rows.push({ id: 'account.land', title: directory.nextLandPurchaseKind === 'entry' ? 'CLAIM YOUR LAND' : 'ADD LAND DEED',
    sub: 'Land deeds and free camps use separate purchase terms.',
    action: { id: `land.${directory.nextLandPurchaseKind}`, label: 'CHOOSE LAND', kind: 'navigate',
      state: fresh && directory.capabilities.cellReservations ? 'ENABLED' : 'DISABLED' } });
  const model: KingdomsAdapterModel = {
    rows, primary: null, load: input.loading ? 'LOADING' : input.error ? 'ERROR' : 'READY',
    note: input.error ?? freePurchase.refreshError ?? state.error,
    ...(directory && input.entryPaid !== null ? { summary: { landless: !input.entryPaid, count: active.length, additionalLandPrice: null } } : {}),
  };
  const unknownPrice: PriceUi = { currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' };
  const journal = state.journal;
  if (journal && journal.identity.wallet !== input.wallet) return { ...model, primary: { id: 'kingdom.purchase.unavailable', label: 'PURCHASE UNAVAILABLE',
    state: 'DISABLED', kind: 'review', reason: 'Reconnect the original wallet before checking its saved purchase.', price: unknownPrice } };
  const operation = journal?.operation;
  // GET-only recovery remains available across selected-base or capability changes.
  if (operation) {
    const waiting = state.busy || !state.loaded;
    if (operation.proof?.status === 'accepted') return { ...model, primary: { id: 'kingdom.purchase.finish', label: 'REFRESH YOUR KINGDOMS', state: waiting ? 'BUSY' : 'ENABLED', kind: 'action' } };
    const recover = operation.attemptRevision !== null || operation.refusal !== null || !freePurchase.actionsAllowed
      || !fresh || operation.command.request.sourceBaseId !== input.selectedBaseId;
    // These are separate explicit confirmations, never automatic exits or replacements for GET recovery.
    // The existing controller rechecks original absence before either archival method can complete.
    if (operation.refusal !== null) rows.push({ id: 'kingdom.purchase.refusal', title: 'ORIGINAL PURCHASE REFUSED',
      sub: `Server reason: ${PURCHASE_REFUSAL_COPY[operation.refusal.code] ?? 'The server refused the original purchase.'} (${operation.refusal.code})`,
      action: { id: 'kingdom.purchase.archive', label: 'ARCHIVE REFUSAL', state: waiting ? 'BUSY' : 'ENABLED', kind: 'confirm' } });
    else if (operation.attemptRevision === null) rows.push({ id: 'kingdom.purchase.draft', title: 'UNSENT PURCHASE REQUEST',
      sub: 'This original request has not been sent. You can keep checking it or review discarding the draft.',
      action: { id: 'kingdom.purchase.abandon', label: 'DISCARD UNSENT REQUEST', state: waiting ? 'BUSY' : 'ENABLED', kind: 'confirm' } });
    return { ...model, primary: { id: recover ? 'kingdom.purchase.recover' : 'kingdom.purchase.review',
      label: recover ? 'CHECK SAVED REQUEST' : 'REVIEW ORIGINAL REQUEST', state: waiting ? 'BUSY' : 'ENABLED', kind: recover ? 'recover' : 'review' },
      note: model.note ?? 'Keep the original purchase request until its outcome is known.' };
  }
  const view = snapshot?.view;
  const sameScope = !!view && input.wallet !== null && view.wallet === input.wallet && input.selectedBaseId !== null
    && view.sourceBaseId === input.selectedBaseId && active.some(base => base.id === input.selectedBaseId);
  // Display grouping only: original canonical command/terms remain byte-for-byte unchanged.
  const price: PriceUi = sameScope ? { currency: 'SHARDS', amount: view!.terms.costShards.replace(/\B(?=(\d{3})+(?!\d))/g, ','), status: 'OK' } : unknownPrice;
  const busy = state.busy || !state.loaded || input.loading || input.busy;
  const allowed = fresh && sameScope && freePurchase.actionsAllowed && snapshot?.enabled === true
    && view?.enabled === true && view.admission.allowed && !freePurchase.refreshError && !busy;
  const reason = sameScope && view && !view.admission.allowed ? PURCHASE_REASON[view.admission.reason]
    : !freePurchase.actionsAllowed ? 'New purchases are not open here.' : 'Purchase availability must be checked for this kingdom.';
  return { ...model, primary: { id: 'kingdom.purchase.begin', label: 'ADD FREE CAMP', kind: 'review', price,
    state: busy ? 'BUSY' : allowed ? 'ENABLED' : sameScope && view && !view.admission.allowed ? 'LOCKED' : 'DISABLED',
    ...(allowed ? {} : { reason }) } };
}
