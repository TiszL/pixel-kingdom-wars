/**
 * 1:1 port of Android ui/sheets/buildings/BuildingsLogic.kt at 28609e71.
 * Pure presentation rules: no React, DOM, clocks, transport, or locally invented game values.
 * Only a payable authoritative price may send. VERIFYING can never resend an uncertain order.
 */
import { PK_BUDGET } from '../homeHudLogic';
import type { BuildingMarkerUi, PriceUi, PxRect, Verb } from '../types';
import type { BuildCardState, BuildCardUi, BuildSectionUi, PlacementState, UpgradeState } from './buildingTypes';

/** Presentation row cap from BuildingsLogic.kt / buildings SPEC §2.1. */
export const MAX_STAT_ROWS = 4;
/** Existing shared presentation budget; not a separate gameplay cap. */
export const MAX_WORLD_MARKERS = PK_BUDGET.MAX_WORLD_MARKERS;

export interface FoldedRows<T> { shown: readonly T[]; hidden: number }

export function foldRows<T>(rows: readonly T[], expanded: boolean, max = MAX_STAT_ROWS): FoldedRows<T> {
  if (expanded || rows.length <= max) return { shown: rows, hidden: 0 };
  // Kotlin List.take rejects a negative count instead of slicing from the end.
  if (max < 0) throw new RangeError('Requested element count is less than zero.');
  return { shown: rows.slice(0, max), hidden: rows.length - max };
}

export function payablePrice(price: PriceUi): boolean {
  switch (price.status) {
    case 'SERVER_ZERO': return true;
    case 'OK': return price.amount != null && price.amount.trim() !== '';
    case 'CHECKING':
    case 'UNAVAILABLE':
    case 'SHORT': return false;
  }
}

export type UpgradePrimaryKind = 'UPGRADE' | 'WAIT_PRICE' | 'NEED_MORE' | 'NEED_BUILDER' | 'STARTING' | 'VERIFYING' | 'OFF';
export interface UpgradePrimaryLook { kind: UpgradePrimaryKind; sends: boolean; reason: string | null }
const PRICE_UNAVAILABLE = 'Price unavailable right now';

export function upgradePrimaryLook(state: UpgradeState, price: PriceUi, reason: string | null): UpgradePrimaryLook {
  switch (state) {
    case 'READY':
    case 'ERROR':
      if (payablePrice(price)) return { kind: 'UPGRADE', sends: true, reason: null };
      if (price.status === 'SHORT') return { kind: 'NEED_MORE', sends: false, reason: null };
      if (price.status === 'UNAVAILABLE') return { kind: 'OFF', sends: false, reason: reason ?? PRICE_UNAVAILABLE };
      return { kind: 'WAIT_PRICE', sends: false, reason: null };
    case 'CHECKING': return { kind: 'WAIT_PRICE', sends: false, reason: null };
    case 'SHORT': return { kind: 'NEED_MORE', sends: false, reason: null };
    case 'NO_BUILDER': return { kind: 'NEED_BUILDER', sends: false, reason: null };
    case 'BUSY': return { kind: 'STARTING', sends: false, reason: null };
    case 'VERIFYING': return { kind: 'VERIFYING', sends: false, reason };
    case 'MAX': return { kind: 'OFF', sends: false, reason: reason ?? 'Already at the highest level' };
    case 'READ_ONLY': return { kind: 'OFF', sends: false, reason: reason ?? 'This base is read-only' };
  }
}

/** A timeout cannot promise that nothing was spent: the first order may have landed. */
export function failureLine(action: string, authoritative: boolean, serverReason: string | null = null): string {
  if (!authoritative) return `Checking whether the ${action} went through.`;
  const why = serverReason?.trim().replace(/\.+$/, '');
  return !why ? `The ${action} didn't start. Nothing was spent.` : `${why}. Nothing was spent.`;
}

export type CardTap = 'PLACE' | 'NEED_MORE' | 'SHOW_REQUIRED' | 'EXPLAIN_LOCKED' | 'EXPLAIN_MAX' | 'EXPLAIN_UNAVAILABLE';

export function cardTap(state: BuildCardState): CardTap {
  switch (state) {
    case 'AVAILABLE':
    case 'CHECKING': return 'PLACE';
    case 'SHORT': return 'NEED_MORE';
    case 'REQUIRES': return 'SHOW_REQUIRED';
    case 'LOCKED': return 'EXPLAIN_LOCKED';
    case 'MAX': return 'EXPLAIN_MAX';
    case 'UNAVAILABLE': return 'EXPLAIN_UNAVAILABLE';
  }
}

/** CHECKING masks an earlier amount through the existing kit price renderer. */
export function cardPrice(card: BuildCardUi): PriceUi | null {
  switch (card.state) {
    case 'AVAILABLE': return card.price;
    case 'SHORT': return card.price?.status === 'OK' ? { ...card.price, status: 'SHORT' } : card.price;
    case 'CHECKING': return card.price == null ? null : { ...card.price, status: 'CHECKING' };
    case 'REQUIRES':
    case 'LOCKED':
    case 'MAX':
    case 'UNAVAILABLE': return null;
  }
}

export function traySections(sections: readonly BuildSectionUi[]): BuildSectionUi[] {
  // Array.sort is stable; filter gives a new array so the mapper's input stays untouched.
  return sections.filter(section => section.cards.length > 0)
    .sort((a, b) => Number(!a.cards.some(card => card.isNew)) - Number(!b.cards.some(card => card.isNew)));
}

export type PlaceTap = 'PLACE' | 'NEED_MORE' | 'BUILDERS' | 'NONE';
export interface PlaceLook { verb: Verb; dots: boolean; reason: string | null; tap: PlaceTap; draggable: boolean }

export function placeLook(state: PlacementState, price: PriceUi, reason: string | null): PlaceLook {
  switch (state) {
    case 'VALID':
    case 'ERROR':
      if (payablePrice(price)) return { verb: 'GREEN', dots: false, reason: null, tap: 'PLACE', draggable: true };
      if (price.status === 'SHORT') return { verb: 'OFF', dots: false, reason: null, tap: 'NEED_MORE', draggable: true };
      if (price.status === 'UNAVAILABLE') return { verb: 'OFF', dots: false, reason: reason ?? PRICE_UNAVAILABLE, tap: 'NONE', draggable: true };
      return { verb: 'STONE', dots: true, reason: null, tap: 'NONE', draggable: true };
    case 'BLOCKED': return { verb: 'OFF', dots: false, reason: reason ?? 'Spot is blocked', tap: 'NONE', draggable: true };
    case 'CHECKING_PRICE': return { verb: 'STONE', dots: true, reason: null, tap: 'NONE', draggable: true };
    case 'SHORT': return { verb: 'OFF', dots: false, reason: null, tap: 'NEED_MORE', draggable: true };
    case 'NO_BUILDER': return { verb: 'OFF', dots: false, reason: reason ?? 'No free builder', tap: 'BUILDERS', draggable: true };
    case 'SENDING': return { verb: 'STONE', dots: true, reason: null, tap: 'NONE', draggable: false };
    case 'VERIFYING': return { verb: 'STONE', dots: true, reason: reason ?? 'Checking with the server', tap: 'NONE', draggable: false };
  }
}

export function placementHint(state: PlacementState, hint: string | null): string {
  return hint ?? (state === 'BLOCKED' ? 'Red tiles are taken. Drag it clear.' : 'Drag to move · PLACE when green');
}

/** Kotlin Float.roundToInt: nearest integer, ties toward +infinity, and no JS negative zero. */
function roundTileStep(value: number): number {
  if (Number.isNaN(value)) throw new RangeError('Cannot round NaN value.');
  // These are language Int bounds, not game values.
  return Math.max(-2147483648, Math.min(2147483647, Math.round(value))) || 0;
}

export function tileStep(dx: number, dy: number, tilePx: number): [number, number] {
  const size = Math.fround(tilePx);
  if (size <= 0) return [0, 0];
  return [roundTileStep(Math.fround(Math.fround(dx) / size)), roundTileStep(Math.fround(Math.fround(dy) / size))];
}

export function visibleMarkers(
  markers: readonly BuildingMarkerUi[], centerX: number, centerY: number, max: number = MAX_WORLD_MARKERS,
): BuildingMarkerUi[] {
  return [...markers].sort((a, b) => distanceSq(a.anchor, centerX, centerY) - distanceSq(b.anchor, centerX, centerY))
    .slice(0, Math.max(0, max));
}

function distanceSq(rect: PxRect, x: number, y: number): number {
  // Mirror the Float arithmetic in PxRect.centerX and BuildingsLogic.distanceSq.
  const dx = Math.fround(Math.fround(Math.fround(rect.left + rect.right) / 2) - x);
  const dy = Math.fround(Math.fround(Math.fround(rect.top + rect.bottom) / 2) - y);
  return Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy));
}
