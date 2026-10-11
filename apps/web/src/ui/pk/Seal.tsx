/**
 * <PkSeal>: the one money consent (AND:K/ui/kit/Seal.kt, DESIGN-SYSTEM §6 ConfirmDialog / Seal) for every Gems, SOL,
 * KEEP and SKR spend. A centred WOOD frame on PARCHMENT over the 55% seal scrim: title, pay → get with 48 px tokens,
 * VT lines, stone BACK (100) and the gold primary.
 *
 * Timings, all from the token bridge:
 *   entrance  scale 0.96 → 1 + fade over --pk-t-seal (160 ms, DS:521), --pk-ease-out
 *   exit      fade over --pk-dur-crossfade (120 ms; KIT SEAL_OUT 120 — the bridge has no seal-out key, see Seal.md)
 *   arming    an ink bar fills inside the primary's lip over --pk-dur-seal-arm (450 ms, linear). The bar's progress
 *             is resumed from `armedAtMs` (negative animation-delay), so a re-render never restarts it.
 * Safety: the primary IGNORES taps until kitLogic.sealAccepts(clock(), armedAtMs) (never queued) — the JS gate is the
 * guard, the bar is only its picture. The required canConfirm predicate is read on every render and again at
 * tap time. It must be pure, cheap and non-throwing; an exception is treated as false so cancel remains available.
 * Owners must re-render when eligibility changes. PkSeal has no single-shot latch: the original owner/adapter
 * owns duplicate admission. Esc / scrim tap / BACK cancel; nothing on the Seal ever confirms by default.
 *
 * Presence: pass `ui={null}` to dismiss; the same Seal animates out and `onExitFinished` fires once from the exit
 * animation's end (no guessed delay). The scrim exists only while a seal is shown (the only scrims are under a Full
 * sheet or the Seal, LANE rule).
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Chunky, PkSecondaryButton } from './Button';
import { PkIcon } from './Icon';
import { PkPlate } from './Plate';
import { currencyIcon, priceDescription, priceText, sealAccepts, sealArmFraction, PK_KIT } from './kitLogic';
import { usePresence } from './presence';
import { prefersReducedMotion } from './viewport';
import type { PriceUi, SealUi } from './types';
import './Seal.css';

export interface PkSealProps {
  ui: SealUi | null;
  /** Live original-controller admission, rechecked at the tap. Missing means closed;
   * arming time alone never authorizes a spend or retry. */
  canConfirm: () => boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Wall clock (ms). Injected by tests. */
  clock?: () => number;
  /** Fires once when the seal is no longer painted. */
  onExitFinished?: () => void;
}

function SealToken({ price }: { price: PriceUi }): React.JSX.Element {
  return (
    <span className="pk-seal__token">
      <PkIcon name={currencyIcon(price.currency, price.icon ?? null)} size={48} contentDescription={priceDescription(price)} />
      <span className={`pk-t-numeral-l pk-seal__amount${price.status === 'SHORT' ? ' pk-seal__amount--short' : ''}`}>{priceText(price)}</span>
    </span>
  );
}

export function PkSeal({ ui, canConfirm, onConfirm, onCancel, clock = Date.now, onExitFinished }: PkSealProps): React.JSX.Element | null {
  const { shown: seal, leaving, gone } = usePresence(ui, onExitFinished);
  const backRef = useRef<HTMLDivElement>(null);
  const active = ui != null;
  const sealKey = seal?.armedAtMs;
  useEffect(() => {
    // Focus the safe choice (BACK) when a seal opens, so Enter never confirms by accident.
    if (active) backRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [active, sealKey]);
  if (!seal) return null;
  const elapsed = sealArmFraction(clock(), seal.armedAtMs) * PK_KIT.SEAL_ARM_MS;
  const eligible = (): boolean => { try { return canConfirm?.() === true; } catch { return false; } };
  const confirm = () => { if (active && sealAccepts(clock(), seal.armedAtMs) && eligible()) onConfirm(); };
  const cancel = () => { if (active) onCancel(); };
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
  return (
    <div className={`pk-seal-root${leaving ? ' pk-seal-root--leaving' : ''}${prefersReducedMotion() ? ' pk-seal-root--still' : ''}`}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) gone(); }}>
      <div className="pk-seal__scrim interactive" onClick={cancel} aria-hidden="true" />
      <div className="pk-seal" role="alertdialog" aria-modal="true" aria-labelledby="pk-seal-title" onKeyDown={onKeyDown}>
        <PkPlate kind="WOOD" className="pk-seal__wood">
          <PkPlate kind="PARCHMENT" className="pk-seal__parch">
            <h2 id="pk-seal-title" className="pk-t-title pk-t-wrap pk-seal__title">{seal.title}</h2>
            <span className="pk-seal__trade">
              <SealToken price={seal.price} />
              {seal.gets ? <><PkIcon name="shape:go" size={24} tint="ink-text" /><SealToken price={seal.gets} /></> : null}
            </span>
            {seal.lines.map((line, i) => <p key={i} className="pk-t-body pk-t-wrap pk-seal__line">{line}</p>)}
            <span className="pk-seal__actions">
              <span className="pk-seal__back" ref={backRef}>
                <PkSecondaryButton label={seal.backLabel ?? 'BACK'} onClick={cancel} />
              </span>
              <Chunky verb="GOLD" size="secondary" label={seal.confirmLabel} onClick={confirm} inert={!active || !eligible()}
                className="pk-seal__primary"
                overlay={<i key={seal.armedAtMs} className="pk-seal__arm" style={{ animationDelay: `-${Math.round(elapsed)}ms` }} aria-hidden="true" />}>
                <span className="pk-t-primary pk-ol2 pk-btn__label">{seal.confirmLabel}</span>
              </Chunky>
            </span>
          </PkPlate>
        </PkPlate>
      </div>
    </div>
  );
}
