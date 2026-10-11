/**
 * <PkPriceChip>: the CostPill (AND:K/ui/kit/Chips.kt PriceChip, DESIGN-SYSTEM §6 CostPill). 26 tall, ink S rim,
 * cream body, 24 px currency icon + caption amount.
 *
 * States (PriceUi.status), text from kitLogic.priceText:
 *   OK (PRICED)   cream, the server amount ("52,400")
 *   SERVER_ZERO   cream, "0": the ONLY way a zero is drawn (never FREE / 0 on a guess)
 *   CHECKING      cream, "…"  (the command it rides on stays ENABLED navigation: commandDrawState)
 *   UNAVAILABLE   cream, VT "unavailable" in ink-text-2 (the command draws DISABLED)
 *   SHORT         #FFD9CC body, #A3261A text. With `onClick` the pill is its own >= 48 px door that opens the
 *                 Need-more half sheet (shortfall + where it is earned + GO). It never auto-spends.
 *
 * Without `onClick` the pill is paint only (a label for the button it sits on). Name: KIT `PriceChip` wins over the
 * design map's `PkCostPill` (Rule 7: the compiled, approved Android API is the one we mirror).
 */
import { PkIcon } from './Icon';
import { currencyIcon, priceDescription, priceText } from './kitLogic';
import type { PriceUi } from './types';
import './PriceChip.css';

export interface PkPriceChipProps {
  ui: PriceUi;
  /** Makes the pill a 48 px door (SHORT -> Need-more). */
  onClick?: (() => void) | undefined;
  className?: string | undefined;
}

export function PkPriceChip({ ui, onClick, className }: PkPriceChipProps): React.JSX.Element {
  const status = ui.status.toLowerCase().replace('_', '-');
  const pill = (
    <span className={['pk-price', `pk-price--${status}`, onClick ? null : className].filter(Boolean).join(' ')}
      {...(onClick ? { 'aria-hidden': true } : { role: 'img', 'aria-label': priceDescription(ui) })}>
      <PkIcon name={currencyIcon(ui.currency, ui.icon ?? null)} size={24} />
      <span className={ui.status === 'UNAVAILABLE' ? 'pk-t-small pk-price__text' : 'pk-t-caption pk-price__text'}>{priceText(ui)}</span>
    </span>
  );
  if (!onClick) return pill;
  return (
    <button type="button" className={['pk-price-door', 'interactive', 'pk-focusable', className].filter(Boolean).join(' ')}
      aria-label={ui.status === 'SHORT' ? `${priceDescription(ui)}. See where to get more` : priceDescription(ui)}
      data-status={status} onClick={onClick}>
      {pill}
    </button>
  );
}
