/**
 * <PkToastHost> / <PkToast>: feedback toasts (AND:K/ui/kit/Feedback.kt ToastHost/Toast, DESIGN-SYSTEM §6 Toast).
 * A 58 px CHARCOAL plate (BLOOD for errors): 32 px icon (errors: the close glyph), one VT sentence (2 lines max), an
 * optional blue GO (the toast's `go` FeatureId) and, for errors, the "Report" link. Max 3; the same key merges.
 *
 * The queue rules are kitLogic.ToastQueue (post / expire / nextExpiry), owned by the OverlayHost with ONE timer at
 * `nextExpiry`; this component only draws what it is given (pure). Motion from tokens: slide 12 px + fade in over
 * --pk-dur-toast-in, fade out over the last --pk-dur-toast-in of --pk-dur-toast-hold; a merge (new `revision`) remounts
 * the toast so its hold restarts.
 *
 * Copy rule (KIT rule 7): the message is the mapper's. Only an AUTHORITATIVE refusal may say "Nothing was spent"
 * (kitLogic.outcomeLine(action, authoritative)); an uncertain money result says it is being checked.
 *
 * Zones (LANE §4 Toasts): `deck` = bottom-centre above the Home deck (default); `tall-sheet` = the top-left zone while a
 * TALL sheet covers the bottom. Pointer rule: the host column is layout only (`pointer-events: none`); each toast
 * plate is `.interactive`, so the gaps between toasts reach the kingdom. No scrim.
 */
import { PkGoButton, PkQuietButton } from './Button';
import { PkIcon } from './Icon';
import { PkPlate } from './Plate';
import { PK_KIT } from './kitLogic';
import type { ToastUi } from './types';
import './ToastQueue.css';

export type ToastZone = 'deck' | 'tall-sheet';

export interface PkToastProps {
  ui: ToastUi;
  onGo: (toast: ToastUi) => void;
  onReport: (toast: ToastUi) => void;
}

export function PkToast({ ui, onGo, onReport }: PkToastProps): React.JSX.Element {
  const error = ui.kind === 'ERROR';
  return (
    <div className={`pk-toast${error ? ' pk-toast--error' : ''}`} role={error ? 'alert' : 'status'}>
      <PkPlate kind="CHARCOAL" tint={error ? 'blood' : null} className="pk-toast__plate">
        <span className="pk-toast__row">
          {error ? <PkIcon name="shape:close" size={24} tint="text" />
            : ui.icon ? <PkIcon name={ui.icon} size={32} /> : null}
          <span className="pk-t-body pk-t-wrap pk-toast__msg">{ui.message}</span>
          {ui.report ? <PkQuietButton label="Report" onClick={() => onReport(ui)} /> : null}
          {ui.go != null ? <PkGoButton onClick={() => onGo(ui)} contentDescription={ui.goLabel ?? 'Go'} label={ui.goLabel ?? 'GO'} /> : null}
        </span>
      </PkPlate>
    </div>
  );
}

export interface PkToastHostProps {
  toasts: readonly ToastUi[];
  onGo: (toast: ToastUi) => void;
  onReport: (toast: ToastUi) => void;
  /** Default 'deck'. */
  zone?: ToastZone;
}

export function PkToastHost({ toasts, onGo, onReport, zone = 'deck' }: PkToastHostProps): React.JSX.Element {
  const visible = toasts.slice(-PK_KIT.MAX_TOASTS);
  return (
    <div className={`pk-toast-host pk-toast-host--${zone}`} aria-live="polite">
      {visible.map((t) => <PkToast key={`${t.key}:${t.revision ?? 0}`} ui={t} onGo={onGo} onReport={onReport} />)}
    </div>
  );
}
