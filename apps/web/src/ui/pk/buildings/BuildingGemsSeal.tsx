import { useRef, useState } from 'react';
import { PkSeal } from '../Seal';
import type { SealUi } from '../types';
import { payablePrice } from './buildingsLogic';

export interface BuildingGemsSealProps {
  ui: SealUi | null;
  /** Stable original-controller request + target identity; never an array position. */
  reviewKey: string;
  /** Live original-controller admission. Must be a pure read, including busy/uncertain-order guards. */
  canConfirm: () => boolean;
  /** Receives the displayed request identity; the controller still owns execution and validation. */
  onConfirm: (reviewKey: string) => void;
  onCancel: () => void;
  clock?: () => number;
}

const intent = (ui: SealUi): string => JSON.stringify([
  ui.title, ui.lines, ui.price, ui.gets ?? null, ui.confirmLabel, ui.backLabel ?? 'BACK',
]);

function capture(ui: SealUi, reviewKey: string) {
  return {
    reviewKey, signature: intent(ui), closed: false,
    ui: { ...ui, lines: [...ui.lines], price: { ...ui.price }, gets: ui.gets ? { ...ui.gets } : null },
  };
}

/** Props-only Gems consent through the shared kit; it never submits an order.
 * The owner supplies an immutable SealUi and a reviewKey covering request + target identity.
 * Any changed displayed intent/key, dismissal, confirmation or cancellation consumes that review.
 * To review again, supply a strictly later armedAtMs or remount with a freshly raised SealUi.
 * This never restamps consent itself; PkSeal alone owns the full arming interval and exit picture.
 */
export default function BuildingGemsSeal({
  ui, reviewKey, canConfirm, onConfirm, onCancel, clock,
}: BuildingGemsSealProps): React.JSX.Element {
  const [review, setReview] = useState(() => ui ? capture(ui, reviewKey) : null);
  const consumedAt = useRef<number | null>(null);
  const signature = ui ? intent(ui) : null;

  // Render-derived state closes stale consent before it can be painted with new terms.
  if (ui && (!review || ui.armedAtMs > review.ui.armedAtMs)) {
    setReview(capture(ui, reviewKey));
  } else if (review && !review.closed && (!ui || reviewKey !== review.reviewKey
    || ui.armedAtMs !== review.ui.armedAtMs || signature !== review.signature)) {
    setReview({ ...review, closed: true });
  }

  const active = review != null && !review.closed && ui != null
    && reviewKey === review.reviewKey && signature === review.signature
    && ui.armedAtMs === review.ui.armedAtMs;
  const admits = () => {
    if (!review || !active || consumedAt.current === review.ui.armedAtMs
      || review.reviewKey.trim() === '' || !Number.isFinite(review.ui.armedAtMs)
      || review.ui.price.currency !== 'GEMS' || !payablePrice(review.ui.price)) return false;
    // A temporarily unavailable controller is closed admission, including when the composed kit reads during render.
    try { return canConfirm() === true; } catch { return false; }
  };
  const close = () => {
    if (!review) return;
    consumedAt.current = review.ui.armedAtMs;
    setReview({ ...review, closed: true });
  };
  const confirm = () => {
    // Recheck here as well: the pinned baseline kit predates its canConfirm prop.
    if (!review || !admits()) return;
    close();
    onConfirm(review.reviewKey);
  };
  const cancel = () => {
    if (!active || !review || consumedAt.current === review.ui.armedAtMs) return;
    close();
    onCancel();
  };
  // Structural spread works against both baseline and composed F2ab kit signatures.
  const sealProps = { ui: active && review ? review.ui : null, canConfirm: admits, onConfirm: confirm, onCancel: cancel,
    ...(clock !== undefined ? { clock } : {}) };
  return <PkSeal {...sealProps} />;
}
