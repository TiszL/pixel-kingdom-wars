import type { ReactNode } from 'react';
import { UNKNOWN } from '../kitLogic';
import type { Currency, PriceUi } from '../types';
import type { ObstacleRemoveUi } from './ObstacleRemoveSheet';
import type { UpgradeState } from './buildingTypes';

/** Minimal read-only BaseStateDto projection; no store, subscription, clock or transport is imported. */
export interface ObstacleSnapshotBase {
  obstacles: readonly { id: string; spriteKey: string }[];
  jobs: readonly { obstacleId: string | null }[];
}

/** Already normalized server/controller facts. Costs, rewards and admission must not come from catalogue fallbacks. */
export interface ObstacleQuoteFacts {
  price: PriceUi | null;
  /** Already formatted with shared fmtDur when known. */
  time: string | null;
  builders: string | null;
  reward: string | null;
  /** The original controller retains uncertainty/refusal classification and all later execution. */
  state: UpgradeState;
  shortfall: string | null;
  builderFreeIn: string | null;
  reason: string | null;
  primaryDetail: string | null;
}

export interface ObstacleSnapshotFacts {
  base: ObstacleSnapshotBase | null;
  selectedObstacleId: string | null;
  currency: Currency | null;
  quote: ObstacleQuoteFacts | null;
  art: ReactNode;
  name: string | null;
  title: string | null;
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
 * Unbound selection/quote projection of sheets.tsx ObstacleSheet at 3cbf0fcc:625 and native ObstacleQuoteUi.
 * An existing job keeps the old clearing/recovery view's custody even after its displayed timer elapses.
 * Only explicit SHARDS facts may reach this fresh-removal body. No live quote producer or removal route is created.
 */
export function obstacleSnapshot(facts: ObstacleSnapshotFacts): ObstacleRemoveUi | null {
  if (facts.base == null || facts.selectedObstacleId == null) return null;
  const obstacle = facts.base.obstacles.find(item => item.id === facts.selectedObstacleId);
  if (obstacle == null || facts.base.jobs.some(job => job.obstacleId === obstacle.id)) return null;

  const quote = facts.quote;
  const price = quote?.price ?? null;
  if (facts.currency != null && facts.currency !== 'SHARDS') return null;
  if (price != null && price.currency !== 'SHARDS') return null;
  if (facts.currency == null && price == null) return null;

  let normalizedPrice: PriceUi = quote == null
    ? { currency: 'SHARDS', amount: null, status: 'CHECKING' }
    : suppliedPrice(price);
  // The controller's current price state wins over an earlier amount, including its screen-reader description.
  if (quote?.state === 'CHECKING') {
    normalizedPrice = { ...normalizedPrice, status: 'CHECKING', amount: null, description: null };
  } else if (quote?.state === 'SHORT' && normalizedPrice.status === 'OK') {
    normalizedPrice = { ...normalizedPrice, status: 'SHORT', description: null };
  }

  return {
    obstacleId: obstacle.id,
    name: facts.name ?? obstacle.spriteKey.replace(/_/g, ' ').toUpperCase(),
    title: facts.title ?? 'REMOVE',
    art: facts.art,
    price: normalizedPrice,
    time: readout(quote?.time ?? null),
    builders: readout(quote?.builders ?? null),
    reward: quote?.reward ?? null,
    state: quote?.state ?? 'CHECKING',
    shortfall: quote?.shortfall ?? null,
    builderFreeIn: quote?.builderFreeIn ?? null,
    reason: quote?.reason ?? null,
    primaryDetail: quote?.primaryDetail ?? null,
  };
}
