import { currencyName, priceText } from '../kitLogic';
import type { PriceUi } from '../types';
import type { UpgradeState } from './buildingTypes';
import { upgradePrimaryLook, type UpgradePrimaryLook } from './buildingsLogic';

/** BuildingsR2Logic quote rules with review fd63a9ae's later no-resend ruling.
 * Native VERIFYING -> RETRY/sends is intentionally replaced by the accepted inert VERIFYING look.
 * ERROR is supplied only for authoritative refusals; timeouts must arrive as VERIFYING. */
export function quotePresentation(state: UpgradeState, price: PriceUi, reason: string | null,
  nothingToDo = false, emptyReason: string | null = null): UpgradePrimaryLook {
  if (nothingToDo) return { kind: 'OFF', sends: false, reason: emptyReason ?? reason ?? 'Nothing to do here' };
  const look = upgradePrimaryLook(state, price, reason);
  return look.kind === 'VERIFYING' ? { ...look, reason: reason ?? 'Being checked' } : look;
}

/** Unit pill presentation only: the total is always supplied separately by the server. */
export function wallUnitPrice(count: number, unit: PriceUi, total: PriceUi, short: boolean): PriceUi {
  if (short) return { ...total, status: 'SHORT' };
  const amount = unit.status === 'CHECKING' || unit.status === 'UNAVAILABLE' || !unit.amount?.trim()
    ? null : `${count} × ${unit.amount}`;
  return { ...unit, amount, status: amount == null && unit.status === 'OK' ? 'CHECKING' : unit.status,
    description: amount == null ? null : `${count} walls at ${unit.amount} ${currencyName(unit.currency)} each` };
}

export function quoteTotalLine(total: PriceUi): string { return `${priceText(total)} ${currencyName(total.currency)} in all`; }
export function wallRowHint(wallsStayUp: boolean): string {
  return 'Tap a wall in the row to leave it out.' + (wallsStayUp ? ' Walls stay up while they upgrade.' : '');
}
