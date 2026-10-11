/**
 * Cancellation confirmation — ONE dialog in front of cancelling a running
 * building upgrade or troop research.
 *
 * Tester request 2026-09-04: "if I accidentally start the wrong upgrade/
 * research … a cancel option could free the builder/research slot, refund …
 * [and] show a confirmation before cancelling to prevent mistakes." A cancel
 * is the opposite of the tap-tap-tap troop −1 (D-096): it throws away a
 * running timer that may be hours in, so it asks first. The refund quoted is
 * the SERVER's own `refundShards` on the job/research DTO — the exact debit
 * recorded at start — never a client re-derivation from cost tables.
 *
 * Portalled to <body> like KeepSpendConfirm: every caller sits inside a bottom
 * sheet or scrolling tray, so rendered in place the dialog would be pinned to
 * that box instead of the viewport.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Btn, COLORS as C, fmtN, Icon, ModalWrap, Phead } from './primitives';

export interface CancelJobIntent {
  /** 'UPGRADE' | 'RESEARCH' — names the thing being thrown away. */
  kind: 'UPGRADE' | 'RESEARCH';
  /** What is running, in the game's voice: "VAULT L3→L4", "GIANT L1→L2". */
  what: string;
  /** The server-quoted refund (job/research DTO `refundShards`). */
  refundShards: string | number;
  /** Runs on the confirming tap only; dismissing posts nothing. */
  onConfirm: () => void;
}

export function CancelJobConfirmDialog({ intent, onDismiss, onConfirm }: {
  intent: CancelJobIntent;
  onDismiss: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const amount = fmtN(intent.refundShards);
  // The research building is the ALCHEMY LAB to the player (BuildingInfo /
  // sheets names); `forge` is only its saved-base identity. Tester report
  // 2026-09-16: "FORGE" copy on troop research reads as the Gold Forge.
  const lane = intent.kind === 'UPGRADE' ? 'THE BUILDER IS FREED' : 'THE ALCHEMY LAB IS FREED';
  return createPortal(
    <ModalWrap onBackdrop={onDismiss}>
      <div role="alertdialog" aria-modal="true" aria-label={`Confirm cancelling this ${intent.kind.toLowerCase()}`}
        style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 14 }}>
        <Phead title={`CANCEL ${intent.kind}?`} color={C.danger} center />

        <p style={{ margin: '0 14px', color: C.text, fontSize: 19, lineHeight: 1.3, textAlign: 'center' }}>
          STOP {intent.what}? PROGRESS SO FAR IS LOST.
        </p>
        <div style={{
          margin: '0 14px', padding: '10px 12px', background: C.ink,
          border: `2px solid ${C.gold}`, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 10,
        }}>
          <span style={{ color: C.gold, fontSize: 18, letterSpacing: '2px' }}>REFUND</span>
          <Icon name="shard" size={26} />
          <span style={{ color: C.goldHi, fontSize: 30, lineHeight: 1 }}>+{amount}</span>
        </div>
        <div style={{ margin: '0 14px', color: C.textFaint, fontSize: 13, letterSpacing: '1px', textAlign: 'center' }}>
          {lane} · A PAID FINISH IS NOT REFUNDED
        </div>

        {/* The destructive choice sits ABOVE; the safe KEEP GOING is the taller
            full-width bottom target, so an impatient double-tap that lands
            below the dialog's centre keeps the timer instead of killing it. */}
        <div style={{ margin: '0 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Btn variant="sec" fontSize={19} style={{ width: '100%', minHeight: 48 }} onClick={onConfirm}>
            CANCEL {intent.kind} · +{amount}
          </Btn>
          <Btn fontSize={19} style={{ width: '100%', minHeight: 52 }} onClick={onDismiss}>
            KEEP GOING
          </Btn>
        </div>
      </div>
    </ModalWrap>,
    document.body,
  );
}

/**
 * Wraps a cancellation in the confirmation. Call `confirmCancel` from the
 * CANCEL button's onClick and render `cancelDialog` in the same tree; the
 * POST itself stays in `intent.onConfirm`, so KEEP GOING posts nothing.
 */
export function useCancelJobConfirm(): {
  confirmCancel: (intent: CancelJobIntent) => void;
  cancelDialog: React.JSX.Element | null;
} {
  const [pending, setPending] = useState<CancelJobIntent | null>(null);
  return {
    confirmCancel: (intent) => setPending(intent),
    cancelDialog: pending
      ? (
        <CancelJobConfirmDialog
          intent={pending}
          onDismiss={() => setPending(null)}
          onConfirm={() => { setPending(null); pending.onConfirm(); }} />
      )
      : null,
  };
}
