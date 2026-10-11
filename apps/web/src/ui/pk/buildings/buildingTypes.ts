import type { PriceUi, Verb } from '../types';

/** Building-specific Android UI contracts. Shared kit types stay in ../types. */
export type UpgradeState =
  | 'READY' | 'CHECKING' | 'SHORT' | 'NO_BUILDER' | 'BUSY'
  | 'MAX' | 'READ_ONLY' | 'ERROR' | 'VERIFYING';

export type BuildCardState =
  | 'AVAILABLE' | 'SHORT' | 'CHECKING' | 'REQUIRES' | 'LOCKED' | 'MAX' | 'UNAVAILABLE';

/** BuildTray.kt BuildCardUi: values are formatted by the mapper from server state. */
export interface BuildCardUi {
  type: string;
  name: string;
  purpose: string;
  art: string;
  count: string;
  countTone: Verb;
  state: BuildCardState;
  price: PriceUi | null;
  time: string | null;
  reason: string | null;
  isNew: boolean;
  requires: string | null;
}

/** BuildTray.kt BuildSectionUi: retain the mapper's ordering except for NEW priority. */
export interface BuildSectionUi {
  id: string;
  title: string;
  icon: string;
  count: string;
  cards: readonly BuildCardUi[];
}

export type PlacementState =
  | 'VALID' | 'BLOCKED' | 'CHECKING_PRICE' | 'SHORT' | 'NO_BUILDER'
  | 'SENDING' | 'ERROR' | 'VERIFYING';
