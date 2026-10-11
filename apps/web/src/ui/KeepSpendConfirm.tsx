/**
 * KEEP spend confirmation — ONE dialog in front of every KEEP spend.
 *
 * Player report 2026-08-29: "I accidentally spent KEEP to instantly finish a
 * building because there was no confirmation warning before the purchase …
 * the KEEP icon and amount [should be] more noticeable so players do not
 * confuse it with normal resources."
 *
 * SCOPE: hard currency only. Shard/resource spends (train, research start,
 * repair, building upgrade) keep their one-tap flow — the reporter explicitly
 * contrasts the two, and confirming a 40-shard train would be pure friction.
 * The five speed-ups were the first callers; owner 2026-08-29 added the HERO
 * UPGRADE, which is not a speed-up at all but the largest single-tap KEEP
 * purchase in the game (~532k at the top of the curve).
 *
 * The quoted price is the value the tapped button was ALREADY showing, never a
 * second derivation: for the builder/train/research finishes that is the shared
 * speedupCostKeep the server charges with, for hero recovery the server's own
 * recoveryFinishNow.costKeep, and for a hero level the server's next.costKeep.
 * It is frozen at tap time on purpose — every speed-up price is a function of
 * REMAINING time, which only shrinks, so the server can charge less than the
 * quote but never more. A hero level is priced off the level alone, so there
 * the quote and the charge are the same number.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { keepConfirmOn, setKeepConfirm } from '../lib/keepConfirm';
import { Btn, COLORS as C, fmtN, Icon, ModalWrap, Phead, Sp, Switch } from './primitives';

export interface KeepSpendIntent {
  /** EXACTLY what the button that opened this dialog quoted. */
  costKeep: number | string;
  /** What the KEEP buys, in the game's voice: "FINISH THIS UPGRADE". */
  what: string;
  /** A speed-up buys TIME, so its question ends "… IMMEDIATELY?". Pass false
   *  for a spend that hurries nothing — a hero level is BOUGHT, and telling a
   *  player they are paying to have it "immediately" implies a slower free
   *  route that does not exist. Defaults true: every speed-up caller predates
   *  this flag and must keep its wording. */
  immediate?: boolean;
  /** A plain-voice line shown ABOVE the question when the spend is easy to
   *  misread — the duplicate hero contract (tester report 2026-09-16: a player
   *  who already recruited Vex bought the contract again and read the bag copy
   *  as "no item delivered"). Rendered in the danger colour so it is the first
   *  thing read. */
  warning?: string;
  /** True forces the dialog even for a player who opted out of KEEP
   *  confirmations: a `warning` explains WHAT is bought, not merely that KEEP
   *  is spent, and the opt-out was only ever consent to skip the latter. */
  always?: boolean;
  /** Runs on CONFIRM — and immediately, without a dialog, once opted out. */
  onConfirm: () => void;
}

export function KeepSpendConfirmDialog({ intent, onCancel, onConfirm }: {
  intent: KeepSpendIntent;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  /** "DON'T ASK AGAIN" is applied on CONFIRM only: a player who cancels never
   *  reached the "again", and silently disarming the guard on the way out of a
   *  refused purchase is exactly the surprise this dialog exists to prevent. */
  const [optOut, setOptOut] = useState(false);
  const amount = fmtN(intent.costKeep);

  // Portalled to <body> like ConnectSheet: ModalWrap is position:absolute and
  // every call site sits inside a bottom sheet or a scrolling tray, so rendered
  // in place the dialog would be pinned to that box instead of the viewport.
  return createPortal(
    <ModalWrap onBackdrop={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-label="Confirm KEEP spend"
        style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 14 }}>
        <Phead title="SPEND KEEP?" color={C.goldHi} center />

        {/* Currency and amount each get their own line. The old single row
            clipped exact prices when the icon and KEEP label competed with the
            number; this keeps the quote intact and respects text scaling. */}
        <div role="group" aria-label={`${amount} KEEP`} style={{
          margin: '0 14px', padding: '10px 12px', background: C.ink,
          border: `2px solid ${C.gold}`, display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 8, minWidth: 0,
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.gold, fontSize: 18, letterSpacing: '2px' }}>
            <Icon name="keep" size={34} />KEEP
          </span>
          <span data-keep-spend-amount style={{ color: C.goldHi, fontSize: 22, lineHeight: 1.2,
            fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{amount}</span>
        </div>

        {intent.warning && (
          <p data-keep-spend-warning role="alert" style={{ margin: '0 14px', color: C.danger, fontSize: 16, lineHeight: 1.3, textAlign: 'center' }}>
            {intent.warning}
          </p>
        )}
        <p style={{ margin: '0 14px', color: C.text, fontSize: 19, lineHeight: 1.3, textAlign: 'center' }}>
          SPEND {amount} KEEP TO {intent.what}{intent.immediate === false ? '' : ' IMMEDIATELY'}?
        </p>
        <div style={{ margin: '0 14px', color: C.textFaint, fontSize: 13, letterSpacing: '1px', textAlign: 'center' }}>
          KEEP IS THE HARD CURRENCY — NOT SHARDS.
        </div>

        <div style={{ margin: '0 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: C.textDim, fontSize: 15 }}>DON&apos;T ASK AGAIN</span>
          <Sp />
          <Switch on={optOut} onClick={() => setOptOut(!optOut)} />
        </div>

        {/* CONFIRM sits ABOVE CANCEL, and CANCEL is the taller full-width
            target. Every FINISH/RECOVER button that opens this dialog lives low
            on the screen (bottom sheet / tray footer) while the dialog centres
            itself, so the second tap of an impatient double-tap lands at or
            below the dialog's bottom edge — that region must be the safe one.
            Both rows clear the 48px touch minimum. */}
        <div style={{ margin: '0 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Btn fontSize={19} style={{ width: '100%', minHeight: 48, whiteSpace: 'normal', flexWrap: 'wrap', gap: 6 }}
            onClick={() => { if (optOut) setKeepConfirm(false); onConfirm(); }}>
            <Icon name="keep" size={20} />CONFIRM · <span style={{ whiteSpace: 'nowrap' }}>{amount} KEEP</span>
          </Btn>
          <Btn variant="sec" fontSize={19} style={{ width: '100%', minHeight: 52 }} onClick={onCancel}>
            CANCEL
          </Btn>
        </div>
      </div>
    </ModalWrap>,
    document.body,
  );
}

/**
 * Wraps a KEEP spend in the confirmation. Call `confirmKeepSpend` from the
 * button's onClick and render `keepSpendDialog` in the same tree; the spend
 * itself stays in `intent.onConfirm`, so CANCEL posts nothing at all rather
 * than posting and unwinding.
 */
export function useKeepSpendConfirm(): {
  confirmKeepSpend: (intent: KeepSpendIntent) => void;
  keepSpendDialog: React.JSX.Element | null;
} {
  const [pending, setPending] = useState<KeepSpendIntent | null>(null);
  return {
    confirmKeepSpend: (intent) => {
      if (!intent.always && !keepConfirmOn()) { intent.onConfirm(); return; }
      setPending(intent);
    },
    keepSpendDialog: pending
      ? (
        <KeepSpendConfirmDialog
          intent={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => { setPending(null); pending.onConfirm(); }} />
      )
      : null,
  };
}
