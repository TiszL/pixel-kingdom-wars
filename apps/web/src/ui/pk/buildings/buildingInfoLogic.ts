/** Pure rules of the BuildingInfo sheet: a 1:1 port of Android BuildingInfoLogic.kt (SPEC §2A, correction 7). */
import { UNKNOWN } from '../kitLogic';
import type { CommandState, PriceUi } from '../types';

/** Whether the sheet's data has arrived. */
export type InfoLoad = 'READY' | 'LOADING' | 'ERROR';

/** UPGRADE navigates to its sheet; FINISH opens the Gems Seal; MAX is a plate. */
export type InfoPrimaryKind = 'UPGRADE' | 'FINISH' | 'MAX';

/** Where a tap on the primary goes. */
export type InfoTap = 'UPGRADE' | 'FINISH' | 'NEED_MORE' | 'EXPLAIN' | 'NONE';

/** The most stat rows before the "All levels" row (SPEC §2A.1). */
export const INFO_MAX_STATS = 5;

/** UPGRADE stays enabled while checking or short: it navigates; FINISH short routes to Need-more. */
export function infoDrawState(kind: InfoPrimaryKind, state: CommandState, price: PriceUi | null): CommandState {
  if (kind === 'MAX') return 'DISABLED';
  if (state === 'LOCKED' || state === 'BUSY' || state === 'DISABLED') return state;
  if (price?.status === 'UNAVAILABLE') return 'DISABLED';
  if (kind === 'FINISH' && (state === 'SHORT' || price?.status === 'SHORT')) return 'SHORT';
  return 'ENABLED';
}

/** The primary's words and state after applying the load state. */
export interface InfoPrimaryLook {
  label: string;
  sub: string | null;
  state: CommandState;
  reason: string | null;
}

export function infoPrimaryLook(
  load: InfoLoad,
  kind: InfoPrimaryKind,
  label: string,
  sub: string | null,
  state: CommandState,
  reason: string | null,
  price: PriceUi | null,
): InfoPrimaryLook {
  switch (load) {
    case 'LOADING': return { label: 'Checking', sub: null, state: 'BUSY', reason: null };
    case 'ERROR': return { label, sub: null, state: 'DISABLED', reason: 'waiting for the server' };
    case 'READY': {
      const drawn = infoDrawState(kind, state, price);
      const why = reason != null && reason.trim() !== ''
        ? reason
        : drawn === 'DISABLED' && price?.status === 'UNAVAILABLE' ? 'price unavailable right now' : null;
      return { label, sub, state: drawn, reason: why };
    }
  }
}

/** BUSY never acts; an off or locked primary explains itself. */
export function infoPrimaryTap(
  load: InfoLoad,
  kind: InfoPrimaryKind,
  state: CommandState,
  price: PriceUi | null,
): InfoTap {
  if (load === 'LOADING') return 'NONE';
  if (load === 'ERROR') return 'EXPLAIN';
  if (kind === 'MAX') return 'NONE';
  switch (infoDrawState(kind, state, price)) {
    case 'BUSY': return 'NONE';
    case 'DISABLED':
    case 'LOCKED': return 'EXPLAIN';
    case 'SHORT': return 'NEED_MORE';
    case 'ENABLED': return kind === 'FINISH' ? 'FINISH' : 'UPGRADE';
  }
}

/** Troop, building and hero portraits get the frame; plain stat icons stay bare. */
export function statIconFramed(icon: string): boolean {
  return icon.startsWith('ui_portrait_') || icon.startsWith('troop-')
    || icon.startsWith('building-') || icon.startsWith('hero_');
}

/** One stat as a screen reader hears it, retaining the shared ellipsis for unknown values. */
export function statSpoken(label: string, now: string | null, next: string | null, yesNo: boolean | null): string {
  if (yesNo != null) return `${label}: ${yesNo ? 'yes' : 'no'}`;
  if (next != null) return `${label}: ${now ?? UNKNOWN}, next level ${next}`;
  return `${label}: ${now ?? UNKNOWN}`;
}
