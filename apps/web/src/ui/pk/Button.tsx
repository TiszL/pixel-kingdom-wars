/**
 * Buttons (AND:K/ui/kit/GameButton.kt, DESIGN-SYSTEM §6): every button is a chunky face (ink M shell padded 3/3/6 ->
 * stepped S face: 3 px hi band, face to 55%, mid below, 5 px lo lip). Press drops the face 3 px in 60 ms linear and
 * releases in 90 ms `pop`; the bottom edge never moves. Colour = verb.
 *
 *   PkPrimaryButton   full width x 60 (the surface's ONE primary); states ENABLED / DISABLED / BUSY / SHORT / LOCKED
 *   PkSecondaryButton 52 tall verb button (stone; red = DangerButton; blue = GO TO; green = UPGRADE)
 *   PkQuietButton     the underlined "Report" / "History" link, 48 px target, no face
 *   PkCloseSquare     48 x 48 red close;   PkIconSquare 48 x 48 any verb
 *   PkGoButton        blue GO with an optional 32 px destination icon
 *   PkMoneyButton     gold label -> stone "Check wallet" -> stone dots "Sending" -> moss SENT, or red RETRY
 *   PkBusyDots, PkBadge (corner badge at -6/-6), PkTag (LIVE / OUTBID / LV n)
 *
 * Tap contract (KIT "Buttons"): PrimaryButton calls back in DISABLED, LOCKED and SHORT too (the caller shows the reason
 * or Need-more; route with kitLogic.commandRoute) but NEVER in BUSY (nothing can be sent twice). MoneyButton calls back
 * only in READY and FAILED. A secondary / icon square with `enabled={false}` does not call back.
 * Targets are >= 48 px on every viewport class (>= the 44 px touch floor, LANE §10.2). Hover (desktop only) is the
 * first 1 px of press travel; keyboard focus always shows a solid ring.
 */
import type { ReactNode } from 'react';
import { PkIcon } from './Icon';
import { moneyLook, priceDescription } from './kitLogic';
import { PkPriceChip } from './PriceChip';
import type { BadgeUi, CommandState, MoneyStage, PriceUi, Verb } from './types';
import './Button.css';

/** The ramp a button state draws with (GameButton.kt stateRamp). */
export function stateVerb(verb: Verb, state: CommandState): Verb {
  switch (state) {
    case 'ENABLED':
    case 'SHORT': return verb;
    case 'DISABLED': return 'OFF';
    case 'BUSY': return 'STONE';
    case 'LOCKED': return 'CHARCOAL';
  }
}

export type ChunkySize = 'primary' | 'secondary' | 'square' | 'go';

export interface ChunkyProps {
  verb: Verb;
  size: ChunkySize;
  /** Accessible name (KIT merges label, price, sub and reason into one). */
  label: string;
  onClick: () => void;
  /** Real `disabled`: no callback, not focusable by click (BUSY, a disabled secondary, a money stage that refuses). */
  inert?: boolean;
  /** `aria-disabled`: looks and announces disabled but still calls back (DISABLED / LOCKED explain themselves). */
  explains?: boolean;
  state?: CommandState;
  badge?: BadgeUi | null;
  className?: string;
  /** Painted inside the button, outside the clipped shell (the Seal's arming bar). */
  overlay?: ReactNode;
  children: ReactNode;
}

/** The shared chunky button (GameButton.kt ChunkyBox). Exported for kit pieces (Seal); screens use the named buttons. */
export function Chunky({ verb, size, label, onClick, inert = false, explains = false, state, badge, className, overlay, children }: ChunkyProps): React.JSX.Element {
  const cls = ['pk-btn', `pk-btn--${size}`, `pk-verb--${verb.toLowerCase()}`, 'interactive', 'pk-focusable', className]
    .filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} aria-label={label} disabled={inert} aria-disabled={explains || undefined}
      data-state={state?.toLowerCase()} onClick={inert ? undefined : onClick}>
      <span className="pk-btn__shell" aria-hidden="true">
        <span className="pk-btn__face"><span className="pk-btn__content">{children}</span></span>
      </span>
      {overlay}
      {badge ? <PkBadge ui={badge} className="pk-btn__badge" /> : null}
    </button>
  );
}

/** The three busy dots. */
export function PkBusyDots(): React.JSX.Element {
  return <span className="pk-dots" aria-hidden="true"><i /><i /><i /></span>;
}

export interface PkPrimaryButtonProps {
  label: string;
  onClick: () => void;
  /** Default GOLD; any other verb gives a non-gold face (green "confirm", red ATTACK). */
  verb?: Verb;
  /** VT sub-line inside the face. */
  sub?: string | null;
  /** Default ENABLED. Pass kitLogic.commandDrawState for a CommandUi (a CHECKING price stays ENABLED). */
  state?: CommandState;
  /** Shown under the button for DISABLED / LOCKED. */
  reason?: string | null;
  badge?: BadgeUi | null;
  icon?: string | null;
  /** Reason colour: danger on a dark plate, ink-text-2 on parchment (default). */
  reasonOnDark?: boolean;
  /** A cost pill centred on the top edge (-20 px). */
  price?: PriceUi | null;
  /** Makes the pill its own 48 px door (a SHORT pill opens Need-more). */
  onPrice?: (() => void) | null;
}

export function PkPrimaryButton({
  label, onClick, verb = 'GOLD', sub = null, state = 'ENABLED', reason = null, badge = null, icon = null,
  reasonOnDark = false, price = null, onPrice = null,
}: PkPrimaryButtonProps): React.JSX.Element {
  const explaining = state === 'DISABLED' || state === 'LOCKED';
  const spoken = [label, price ? priceDescription(price) : null, sub, explaining ? reason : null].filter(Boolean).join('. ');
  return (
    <div className={['pk-primary', price ? 'pk-primary--priced' : null].filter(Boolean).join(' ')}>
      <div className="pk-primary__slot">
        <Chunky verb={stateVerb(verb, state)} size="primary" label={spoken} onClick={onClick} inert={state === 'BUSY'}
          explains={explaining} state={state} badge={badge}>
          {state === 'BUSY' ? <PkBusyDots />
            : state === 'LOCKED' ? <PkIcon name="shape:lock" size={24} tint="gold" />
              : icon ? <PkIcon name={icon} size={32} /> : null}
          <span className="pk-btn__labels">
            {state === 'BUSY'
              ? <span className="pk-t-body pk-btn__sentence">{label}</span>
              : <span className={`pk-t-primary pk-ol2 pk-btn__label${state === 'DISABLED' ? ' pk-btn__label--off' : ''}`}>{label}</span>}
            {sub ? <span className="pk-t-small pk-btn__sub">{sub}</span> : null}
          </span>
        </Chunky>
        {price ? <PkPriceChip ui={price} onClick={onPrice ?? undefined} className="pk-primary__price" /> : null}
      </div>
      {explaining && reason ? (
        <span className={`pk-t-small pk-t-wrap pk-primary__reason${reasonOnDark ? ' pk-primary__reason--dark' : ''}`}>{reason}</span>
      ) : null}
    </div>
  );
}

export interface PkSecondaryButtonProps {
  label: string;
  onClick: () => void;
  /** Default STONE; RED = DangerButton. */
  verb?: Verb;
  icon?: string | null;
  enabled?: boolean;
  contentDescription?: string;
}

export function PkSecondaryButton({ label, onClick, verb = 'STONE', icon = null, enabled = true, contentDescription }: PkSecondaryButtonProps): React.JSX.Element {
  return (
    <Chunky verb={enabled ? verb : 'OFF'} size="secondary" label={contentDescription ?? label} onClick={onClick} inert={!enabled}>
      {icon ? <PkIcon name={icon} size={24} /> : null}
      <span className="pk-t-label pk-ol1 pk-btn__label">{label}</span>
    </Chunky>
  );
}

export interface PkQuietButtonProps { label: string; onClick: () => void; onParchment?: boolean; contentDescription?: string }

export function PkQuietButton({ label, onClick, onParchment = false, contentDescription }: PkQuietButtonProps): React.JSX.Element {
  return (
    <button type="button" className={`pk-quiet interactive pk-focusable${onParchment ? ' pk-quiet--parch' : ''}`}
      aria-label={contentDescription ?? label} onClick={onClick}>
      <span className="pk-t-small">{label}</span>
    </button>
  );
}

export interface PkIconSquareProps { icon: string; verb: Verb; onClick: () => void; contentDescription: string; enabled?: boolean }

export function PkIconSquare({ icon, verb, onClick, contentDescription, enabled = true }: PkIconSquareProps): React.JSX.Element {
  return (
    <Chunky verb={enabled ? verb : 'OFF'} size="square" label={contentDescription} onClick={onClick} inert={!enabled}>
      <PkIcon name={icon} size={24} tint="k-label" />
    </Chunky>
  );
}

export function PkCloseSquare({ onClick, contentDescription = 'Close' }: { onClick: () => void; contentDescription?: string }): React.JSX.Element {
  return <PkIconSquare icon="shape:close" verb="RED" onClick={onClick} contentDescription={contentDescription} />;
}

export interface PkGoButtonProps { onClick: () => void; contentDescription: string; label?: string; icon?: string | null }

export function PkGoButton({ onClick, contentDescription, label = 'GO', icon = null }: PkGoButtonProps): React.JSX.Element {
  return (
    <Chunky verb="BLUE" size="go" label={contentDescription} onClick={onClick}>
      {icon ? <PkIcon name={icon} size={32} /> : null}
      <span className="pk-t-caption pk-ol1 pk-btn__label">{label}</span>
    </Chunky>
  );
}

export interface PkMoneyButtonProps { stage: MoneyStage; label: string; onClick: () => void; retryLabel?: string }

export function PkMoneyButton({ stage, label, onClick, retryLabel = 'RETRY' }: PkMoneyButtonProps): React.JSX.Element {
  const look = moneyLook(stage, label, retryLabel);
  return (
    <Chunky verb={look.verb} size="primary" label={look.text} onClick={onClick} inert={!look.accepts}
      className="pk-btn--money" state={look.accepts ? 'ENABLED' : 'BUSY'}>
      {look.dots ? <PkBusyDots /> : null}
      {look.sentence
        ? <span className="pk-t-body pk-btn__sentence">{look.text}</span>
        : <span className="pk-t-primary pk-ol2 pk-btn__label">{look.text}</span>}
    </Chunky>
  );
}

/** A corner badge (one grammar: red count, gold reward / NEW, green "!" ready, blue info). Pops in over badgePop. */
export function PkBadge({ ui, className }: { ui: BadgeUi; className?: string }): React.JSX.Element {
  return (
    <span className={['pk-badge', `pk-badge--${ui.tone.toLowerCase()}`, className].filter(Boolean).join(' ')}
      role="img" aria-label={ui.description}>
      <i className="pk-t-caption">{ui.text}</i>
    </span>
  );
}

/** A state tag (LIVE / OUTBID / YOU LEAD / KING / TEST DATA / LV n) on the verb's face. */
export function PkTag({ text, verb }: { text: string; verb: Verb }): React.JSX.Element {
  return (
    <span className={`pk-tag pk-verb--${verb.toLowerCase()}`}>
      <i className="pk-t-caption pk-ol1">{text}</i>
    </span>
  );
}
