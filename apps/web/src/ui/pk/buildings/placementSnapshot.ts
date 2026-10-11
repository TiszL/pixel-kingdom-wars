import { UNKNOWN } from '../kitLogic';
import type { Currency, PriceUi } from '../types';
import type { PlacementBarUi } from './PlacementBar';
import type { PlacementState } from './buildingTypes';

/** Normalized facts supplied by the original controller, never derived from a catalogue or a captured balance here. */
export interface PlacementSnapshotFacts {
  type: string;
  name: string;
  tile: readonly [number, number] | null;
  /** The existing world controller owns occupancy and footprint validation. Unknown is not valid. */
  tileValid: boolean | null;
  tileReason: string | null;
  /** A missing quote may still have an explicitly supplied currency; neither field supplies a default. */
  currency: Currency | null;
  price: PriceUi | null;
  /** Positive formatted shortfall supplied by the existing admission owner; null means no supplied shortfall. */
  shortfall: string | null;
  /** Already formatted with shared fmtDur when known; unknown is null. */
  time: string | null;
  freeBuilders: number;
  totalBuilders: number | null;
  nextBuilderFreeIn: string | null;
  available: boolean;
  readOnly: boolean;
  constructionBlocked: boolean;
  busy: boolean;
  heroOffer: boolean;
  /** Explicit original-request uncertainty. This layer does not infer timeouts or authoritative refusals. */
  orderState: 'IDLE' | 'VERIFYING';
  orderReason: string | null;
}

function readout(value: string | null): string {
  return value?.trim() ? value : UNKNOWN;
}

function suppliedPrice(price: PriceUi | null): PriceUi {
  if (price == null) return { currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' };
  if (price.status === 'CHECKING' || price.status === 'UNAVAILABLE') {
    return { ...price, amount: null, description: null };
  }
  // PriceUi reserves zero for SERVER_ZERO. Check decimal spellings exactly, without floating-point rounding.
  if (price.status === 'OK' && (price.amount == null || !price.amount.trim()
    || /^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(price.amount.trim()))) {
    return { ...price, amount: null, status: 'UNAVAILABLE', description: null };
  }
  return { ...price };
}

/**
 * Unbound strip snapshot, based on native LivePlacementMapper.kt:59–96 and the pinned web spot.valid gate.
 * Native's state precedence is preserved after the explicit web uncertainty/validity guards. Only the existing
 * SHARDS route is represented; walls, hero offers, unknown currency and conflicting currency remain with their owner.
 * This does not create a live producer, a build:start event or execution admission: PlacementBar still calls canPlace.
 */
export function placementSnapshot(facts: PlacementSnapshotFacts): PlacementBarUi | null {
  if (facts.type === 'wall' || facts.heroOffer) return null;
  if (facts.currency != null && facts.currency !== 'SHARDS') return null;
  if (facts.price != null && facts.price.currency !== 'SHARDS') return null;
  if (facts.currency == null && facts.price == null) return null;

  let price = suppliedPrice(facts.price);
  if (price.status === 'OK' && facts.shortfall?.trim()) {
    price = { ...price, status: 'SHORT', description: null };
  }

  let state: PlacementState;
  let reason: string | null = null;
  if (facts.orderState === 'VERIFYING') {
    state = 'VERIFYING';
    reason = facts.orderReason;
  } else if (facts.busy) state = 'SENDING';
  else if (facts.readOnly) {
    state = 'BLOCKED';
    reason = 'Orders are paused here';
  } else if (facts.constructionBlocked) {
    state = 'BLOCKED';
    reason = 'Check the saved payment first';
  } else if (!facts.available) {
    state = 'BLOCKED';
    reason = 'Not available now';
  } else if (facts.tile == null) {
    state = 'BLOCKED';
    reason = 'Tap a spot first';
  } else if (facts.tileValid !== true) {
    state = 'BLOCKED';
    reason = facts.tileReason;
  } else if (price.status === 'UNAVAILABLE') state = 'VALID'; // placeLook keeps unavailable quotes inert.
  else if (facts.freeBuilders === 0) {
    state = 'NO_BUILDER';
    reason = 'No free builder';
  } else if (price.status === 'SHORT') state = 'SHORT';
  else state = 'VALID';

  return {
    type: facts.type,
    name: facts.name.toUpperCase(),
    price,
    time: readout(facts.time),
    builders: state === 'NO_BUILDER' && facts.nextBuilderFreeIn?.trim()
      ? `free in ${facts.nextBuilderFreeIn}`
      : `${facts.freeBuilders}/${facts.totalBuilders ?? UNKNOWN}`,
    state,
    hint: facts.tile == null
      ? `Tap where the ${facts.name.toLowerCase()} goes · pinch to zoom`
      : 'Tap another spot to move it · PLACE to build',
    reason,
  };
}
