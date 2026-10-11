/** Payment and NFT completion are separate authoritative facts. */
import type { EntryPhase, LandReservation } from '../../auth/useEntry';

export type LandStage = 'pick' | 'reserve' | 'pay' | 'confirmed' | 'minting' | 'deed';

/** Compact labels; the reserved price appears on the parcel and payment action. */
export const LAND_STAGES: ReadonlyArray<{ id: LandStage; label: string }> = [
  { id: 'pick', label: 'PICK' },
  { id: 'reserve', label: 'RESERVE / FUND' },
  { id: 'pay', label: 'APPROVE PAYMENT' },
  { id: 'confirmed', label: 'PAYMENT CONFIRMED' },
  { id: 'minting', label: 'DEED MINTING' },
  { id: 'deed', label: 'DEED READY' },
];

export function landStage(x: {
  phase: EntryPhase;
  reservation: LandReservation | null;
  /** `landPurchase.earthCell` from the globe's CHOOSE THIS LAND, not yet reserved. */
  drafted: boolean;
  paymentCredited: boolean;
  deedReady?: boolean;
}): LandStage {
  if (x.deedReady) return 'deed';
  if (x.paymentCredited || x.phase === 'credited') return 'minting';
  if (x.reservation || x.phase === 'paying' || x.phase === 'confirming' || x.phase === 'failed') return 'pay';
  if (x.drafted || x.phase === 'reserving') return 'reserve';
  return 'pick';
}

export type LandFlowEvent = 'land_expired' | 'land_failed';

/**
 * The two outcomes usePayEntry reports only by shape: after CONFIRMING, an
 * expired intent goes back to idle with the reservation cleared and an error
 * set, while a payment the server saw but could not grant lands on `failed`
 * (D-009: money moved is money honoured — by hand, with the support address).
 * A credit moves to credited and KEEPS the reservation, so it is not read
 * as an expiry here; `onDone` reports that one.
 */
export function landFlowEvent(
  prev: EntryPhase,
  next: { phase: EntryPhase; reservation: LandReservation | null; error: string | null },
): LandFlowEvent | null {
  if (prev !== 'confirming') return null;
  if (next.phase === 'failed') return 'land_failed';
  if (next.phase === 'idle' && next.reservation === null && next.error !== null) return 'land_expired';
  return null;
}
